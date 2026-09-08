import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQueryClient } from "@tanstack/react-query";

import { use_asset_catalog } from "@/app/asset_catalog";
import { RESOURCE_QUERY_KEYS } from "@/app/query_cache";
import {
  create_download,
  get_agent_index_status,
  list_downloads,
  list_agent_tasks,
  retry_agent_run,
  transcribe_asset,
} from "@/shared/api";
import { poll_transcription_job } from "@/shared/poll_transcription_job";
import { poll_download } from "@/shared/poll_download";
import { error_message, is_abort_error } from "@/shared/errors";
import type {
  AnalysisJob,
  AgentIndexStatus,
  AgentTaskSnapshot,
  DownloadDestination,
  DownloadJob,
  TranscriptionOptions,
} from "@/shared/types";
import { merge_task_record, type TaskRecord } from "@/features/workbench/tasks";

const TERMINAL_DOWNLOAD_STAGES = new Set(["complete", "failed"]);
const INITIAL_DOWNLOAD_TASK_LIMIT = 50;
const AGENT_TASK_REFRESH_INTERVAL_MS = 2_000;
const TRANSCRIPTION_STAGES = new Set<AgentIndexStatus["stage"]>([
  "preparing_transcription_model",
  "extracting_audio",
  "transcribing",
]);

type TaskManager = {
  task_records: TaskRecord[];
  index_status: AgentIndexStatus | null;
  start_downloads: (
    urls: string[],
    destination?: DownloadDestination,
  ) => Promise<DownloadJob[]>;
  start_transcription: (
    asset_id: string,
    options: TranscriptionOptions,
  ) => Promise<AnalysisJob>;
  is_transcription_running: (asset_id: string) => boolean;
  retry_agent_task: (run_id: string) => Promise<void>;
};

const TaskManagerContext = createContext<TaskManager | null>(null);

export function TaskManagerProvider({ children }: { children: ReactNode }) {
  const query_client = useQueryClient();
  const { assets, selected_asset_id } = use_asset_catalog();
  const [task_records, set_task_records] = useState<TaskRecord[]>([]);
  const [index_status, set_index_status] = useState<AgentIndexStatus | null>(
    null,
  );
  const [active_transcriptions, set_active_transcriptions] = useState<
    Set<string>
  >(new Set());
  const download_controllers = useRef(new Map<string, AbortController>());
  const download_requests = useRef(new Set<AbortController>());
  const transcription_controllers = useRef(new Map<string, AbortController>());
  const previous_index_status_ref = useRef<AgentIndexStatus | null>(null);

  useEffect(() => {
    const downloads = download_controllers.current;
    const requests = download_requests.current;
    const transcriptions = transcription_controllers.current;
    return () => {
      downloads.forEach((controller) => controller.abort());
      requests.forEach((controller) => controller.abort());
      transcriptions.forEach((controller) => controller.abort());
      downloads.clear();
      requests.clear();
      transcriptions.clear();
    };
  }, []);

  const record_task = useCallback((task: TaskRecord) => {
    set_task_records((current) => merge_task_record(current, task));
  }, []);

  const record_download_job = useCallback(
    (job: DownloadJob) => {
      record_task({
        task_id: job.job_id,
        task_type: "download",
        stage: job.stage,
        message: job.message,
        progress_percent: job.progress_percent,
        error_message: job.error_message,
        created_at: job.created_at,
        name: job.name,
      });
    },
    [record_task],
  );

  const record_transcription_job = useCallback(
    (job: AnalysisJob) => {
      record_task({
        task_id: job.job_id,
        task_type: "transcription",
        stage: job.stage,
        message: job.message,
        progress_percent: job.progress_percent,
        error_message: job.error_message,
        created_at: job.created_at,
        name:
          assets.find((asset) => asset.asset_id === job.asset_id)?.title ??
          "素材转写",
      });
    },
    [assets, record_task],
  );

  const record_agent_tasks = useCallback((snapshots: AgentTaskSnapshot[]) => {
    set_task_records((current) =>
      snapshots.reduce(
        (tasks, snapshot) =>
          merge_task_record(tasks, agent_task_record(snapshot)),
        current,
      ),
    );
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const refresh_agent_tasks = () => {
      try {
        void list_agent_tasks(controller.signal)
          .then(record_agent_tasks)
          .catch(() => undefined);
      } catch {
        // 离线壳层未提供 Agent 端点时不影响下载与转录任务。
      }
    };
    refresh_agent_tasks();
    const interval_id = window.setInterval(
      refresh_agent_tasks,
      AGENT_TASK_REFRESH_INTERVAL_MS,
    );
    return () => {
      controller.abort();
      window.clearInterval(interval_id);
    };
  }, [record_agent_tasks]);

  useEffect(() => {
    const controller = new AbortController();
    previous_index_status_ref.current = null;
    set_index_status(null);
    const refresh_index_status = () => {
      try {
        void get_agent_index_status(selected_asset_id, controller.signal)
          .then((status) => {
            const previous_status = previous_index_status_ref.current;
            previous_index_status_ref.current = status;
            set_index_status(status);
            record_task(index_task_record(status));
            if (
              previous_status?.asset_id &&
              previous_status.asset_id === status.asset_id &&
              TRANSCRIPTION_STAGES.has(previous_status.stage) &&
              !TRANSCRIPTION_STAGES.has(status.stage)
            ) {
              void query_client.invalidateQueries({
                queryKey: RESOURCE_QUERY_KEYS.asset_analysis(
                  previous_status.asset_id,
                ),
              });
            }
          })
          .catch(() => undefined);
      } catch {
        // 离线壳层未提供索引端点时，其余任务仍可继续。
      }
    };
    refresh_index_status();
    const interval_id = window.setInterval(
      refresh_index_status,
      AGENT_TASK_REFRESH_INTERVAL_MS,
    );
    return () => {
      controller.abort();
      window.clearInterval(interval_id);
    };
  }, [query_client, record_task, selected_asset_id]);

  const track_download_jobs = useCallback(
    (jobs: DownloadJob[]) => {
      for (const job of jobs) {
        record_download_job(job);
        if (
          TERMINAL_DOWNLOAD_STAGES.has(job.stage) ||
          download_controllers.current.has(job.job_id)
        )
          continue;
        const controller = new AbortController();
        download_controllers.current.set(job.job_id, controller);
        void poll_download(job, record_download_job, controller.signal)
          .then(() =>
            Promise.all([
              query_client.invalidateQueries({
                queryKey: RESOURCE_QUERY_KEYS.assets,
              }),
              query_client.invalidateQueries({
                queryKey: RESOURCE_QUERY_KEYS.library_folders,
              }),
            ]),
          )
          .catch((error: unknown) => {
            if (!is_abort_error(error)) {
              set_task_records((current) =>
                current.map((task) =>
                  task.task_id === job.job_id
                    ? {
                        ...task,
                        stage: "interrupted",
                        message: "下载进度同步中断，重新打开应用可恢复查看",
                        error_message: error_message(error),
                      }
                    : task,
                ),
              );
            }
          })
          .finally(() => {
            if (download_controllers.current.get(job.job_id) === controller)
              download_controllers.current.delete(job.job_id);
          });
      }
    },
    [query_client, record_download_job],
  );

  useEffect(() => {
    const controller = new AbortController();
    void list_downloads(INITIAL_DOWNLOAD_TASK_LIMIT, controller.signal)
      .then((jobs) => {
        if (!controller.signal.aborted) track_download_jobs(jobs);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [track_download_jobs]);

  const start_downloads = useCallback(
    async (urls: string[], destination?: DownloadDestination) => {
      const controller = new AbortController();
      download_requests.current.add(controller);
      try {
        const jobs = await create_download(
          urls,
          controller.signal,
          destination,
        );
        track_download_jobs(jobs);
        void query_client.invalidateQueries({
          queryKey: RESOURCE_QUERY_KEYS.assets,
        });
        void query_client.invalidateQueries({
          queryKey: RESOURCE_QUERY_KEYS.library_folders,
        });
        return jobs;
      } finally {
        download_requests.current.delete(controller);
      }
    },
    [query_client, track_download_jobs],
  );

  const start_transcription = useCallback(
    async (asset_id: string, options: TranscriptionOptions) => {
      if (transcription_controllers.current.has(asset_id))
        throw new Error("该视频已在转写队列中");
      const controller = new AbortController();
      transcription_controllers.current.set(asset_id, controller);
      set_active_transcriptions((current) => new Set(current).add(asset_id));
      try {
        const job = await transcribe_asset(
          asset_id,
          options,
          controller.signal,
        );
        record_transcription_job(job);
        const final_job =
          job.stage === "complete"
            ? job
            : await poll_transcription_job(
                job,
                record_transcription_job,
                controller.signal,
              );
        if (final_job.stage === "failed") {
          throw new Error(final_job.error_message ?? "转录失败");
        }
        await query_client.invalidateQueries({
          queryKey: RESOURCE_QUERY_KEYS.asset_analysis(asset_id),
        });
        return final_job;
      } finally {
        set_active_transcriptions((current) => {
          const next = new Set(current);
          next.delete(asset_id);
          return next;
        });
        transcription_controllers.current.delete(asset_id);
      }
    },
    [query_client, record_transcription_job],
  );

  const retry_agent_task = useCallback(
    async (run_id: string) => {
      await retry_agent_run(run_id);
      try {
        record_agent_tasks(await list_agent_tasks());
      } catch {
        // 重试已启动时不因一次刷新失败误报，下一轮轮询会补齐状态。
      }
    },
    [record_agent_tasks],
  );

  const value = useMemo<TaskManager>(
    () => ({
      task_records,
      index_status,
      start_downloads,
      retry_agent_task,
      start_transcription,
      is_transcription_running: (asset_id) =>
        active_transcriptions.has(asset_id) ||
        (index_status?.asset_id === asset_id &&
          TRANSCRIPTION_STAGES.has(index_status.stage)),
    }),
    [
      active_transcriptions,
      index_status,
      start_downloads,
      retry_agent_task,
      start_transcription,
      task_records,
    ],
  );

  return (
    <TaskManagerContext.Provider value={value}>
      {children}
    </TaskManagerContext.Provider>
  );
}

function agent_task_message(stage: AgentTaskSnapshot["run"]["stage"]): string {
  return {
    pending: "等待助手开始",
    running: "助手正在处理",
    waiting_for_approval: "等待用户批准变更",
    complete: "助手任务已完成",
    failed: "助手任务失败",
    cancelled: "助手任务已取消",
    interrupted: "应用退出时任务中断",
  }[stage];
}

function agent_task_progress(stage: AgentTaskSnapshot["run"]["stage"]): number {
  return {
    pending: 0,
    running: 50,
    waiting_for_approval: 90,
    complete: 100,
    failed: 100,
    cancelled: 100,
    interrupted: 100,
  }[stage];
}

function agent_task_record(snapshot: AgentTaskSnapshot): TaskRecord {
  const run = snapshot.run;
  return {
    task_id: run.run_id,
    task_type: "agent",
    stage: run.stage,
    message: agent_task_message(run.stage),
    progress_percent: agent_task_progress(run.stage),
    error_message: run.error_message,
    created_at: run.created_at,
    name: snapshot.session_title,
    retry_available: snapshot.retry_available,
  };
}

function index_task_record(status: AgentIndexStatus): TaskRecord {
  const progress_known = status.state === "ready" || status.total_documents > 0;
  const progress_percent =
    status.state === "ready"
      ? 100
      : status.total_documents > 0
        ? (status.processed_documents / status.total_documents) * 100
        : 0;
  return {
    task_id: status.index_task_id,
    task_type: "index",
    stage:
      status.state === "ready"
        ? "complete"
        : status.state === "failed"
          ? "failed"
          : status.stage,
    message: status.stage_label,
    progress_percent,
    progress_known,
    error_message: status.error_message,
    created_at: status.updated_at,
    name: status.asset_id ? "当前视频证据索引" : "资料库证据索引",
  };
}

export function use_task_manager(): TaskManager {
  const manager = useContext(TaskManagerContext);
  if (!manager) {
    throw new Error("use_task_manager 必须在 TaskManagerProvider 内使用");
  }
  return manager;
}

export function use_optional_task_manager(): TaskManager | null {
  return useContext(TaskManagerContext);
}
