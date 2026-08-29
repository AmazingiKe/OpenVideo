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

import { use_asset_catalog } from "@/app/asset_catalog";
import {
  create_download,
  get_agent_index_status,
  list_downloads,
  list_agent_tasks,
  request_download_retry,
  resume_agent_run,
  transcribe_asset,
} from "@/shared/api";
import { poll_transcription_job } from "@/shared/poll_transcription_job";
import { poll_download } from "@/shared/poll_download";
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

type TaskManager = {
  task_records: TaskRecord[];
  index_status: AgentIndexStatus | null;
  start_downloads: (
    urls: string[],
    destination?: DownloadDestination,
  ) => Promise<DownloadJob[]>;
  retry_download: (job_id: string) => Promise<DownloadJob>;
  start_transcription: (
    asset_id: string,
    options: TranscriptionOptions,
  ) => Promise<AnalysisJob>;
  is_transcription_running: (asset_id: string) => boolean;
  resume_agent_task: (run_id: string) => Promise<void>;
};

const TaskManagerContext = createContext<TaskManager | null>(null);

export function TaskManagerProvider({ children }: { children: ReactNode }) {
  const { refresh_assets, select_asset, selected_asset_id } =
    use_asset_catalog();
  const [task_records, set_task_records] = useState<TaskRecord[]>([]);
  const [index_status, set_index_status] = useState<AgentIndexStatus | null>(
    null,
  );
  const [active_transcriptions, set_active_transcriptions] = useState<
    Set<string>
  >(new Set());
  const download_controller_ref = useRef<AbortController | null>(null);
  const transcription_controller_ref = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      download_controller_ref.current?.abort();
      transcription_controller_ref.current?.abort();
    },
    [],
  );

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
        events: job.events,
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
        name: "素材转录",
        events: [],
      });
    },
    [record_task],
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
    try {
      void list_downloads(INITIAL_DOWNLOAD_TASK_LIMIT, controller.signal)
        .then((jobs) => jobs.forEach(record_download_job))
        .catch(() => undefined);
    } catch {
      // 测试或离线壳层未提供历史端点时，实时任务仍可正常工作。
    }
    return () => controller.abort();
  }, [record_download_job]);

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
    set_index_status(null);
    const refresh_index_status = () => {
      try {
        void get_agent_index_status(selected_asset_id, controller.signal)
          .then((status) => {
            set_index_status(status);
            record_task(index_task_record(status));
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
  }, [record_task, selected_asset_id]);

  const track_download_jobs = useCallback(
    async (jobs: DownloadJob[], controller: AbortController) => {
      jobs.forEach(record_download_job);
      const final_jobs = await Promise.all(
        jobs.map((job) =>
          TERMINAL_DOWNLOAD_STAGES.has(job.stage)
            ? Promise.resolve(job)
            : poll_download(job, record_download_job, controller.signal),
        ),
      );
      final_jobs.forEach(record_download_job);
      const completed_jobs = final_jobs.filter(
        (job) => job.stage === "complete",
      );
      if (completed_jobs.length > 0) {
        await refresh_assets(controller.signal);
        select_asset(completed_jobs.at(-1)?.asset_id ?? null);
      }
      return final_jobs;
    },
    [record_download_job, refresh_assets, select_asset],
  );

  const with_download_controller = useCallback(
    async <Result,>(
      operation: (controller: AbortController) => Promise<Result>,
    ) => {
      download_controller_ref.current?.abort();
      const controller = new AbortController();
      download_controller_ref.current = controller;
      try {
        return await operation(controller);
      } finally {
        if (download_controller_ref.current === controller) {
          download_controller_ref.current = null;
        }
      }
    },
    [],
  );

  const start_downloads = useCallback(
    (urls: string[], destination?: DownloadDestination) =>
      with_download_controller(async (controller) => {
        const jobs = await create_download(
          urls,
          controller.signal,
          destination,
        );
        return track_download_jobs(jobs, controller);
      }),
    [track_download_jobs, with_download_controller],
  );

  const retry_download = useCallback(
    (job_id: string) =>
      with_download_controller(async (controller) => {
        const job = await request_download_retry(job_id, controller.signal);
        const [final_job] = await track_download_jobs([job], controller);
        if (!final_job) throw new Error("重新下载任务未返回结果");
        return final_job;
      }),
    [track_download_jobs, with_download_controller],
  );

  const start_transcription = useCallback(
    async (asset_id: string, options: TranscriptionOptions) => {
      transcription_controller_ref.current?.abort();
      const controller = new AbortController();
      transcription_controller_ref.current = controller;
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
        return final_job;
      } finally {
        set_active_transcriptions((current) => {
          const next = new Set(current);
          next.delete(asset_id);
          return next;
        });
        if (transcription_controller_ref.current === controller) {
          transcription_controller_ref.current = null;
        }
      }
    },
    [record_transcription_job],
  );

  const resume_agent_task = useCallback(
    async (run_id: string) => {
      await resume_agent_run(run_id);
      try {
        record_agent_tasks(await list_agent_tasks());
      } catch {
        // 恢复已成功时不因一次刷新失败误报，下一轮轮询会补齐状态。
      }
    },
    [record_agent_tasks],
  );

  const value = useMemo<TaskManager>(
    () => ({
      task_records,
      index_status,
      start_downloads,
      retry_download,
      resume_agent_task,
      start_transcription,
      is_transcription_running: (asset_id) =>
        active_transcriptions.has(asset_id),
    }),
    [
      active_transcriptions,
      index_status,
      start_downloads,
      retry_download,
      resume_agent_task,
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
    events: [],
    resume_available: snapshot.resume_available,
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
    events: [],
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
