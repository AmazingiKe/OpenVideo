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
  ApiError,
  delete_download,
  get_download,
  get_agent_index_status,
  list_downloads,
  list_agent_tasks,
  retry_agent_run,
  pause_download,
  probe_source,
  resume_download,
  transcribe_asset,
} from "@/shared/api";
import { poll_transcription_job } from "@/shared/poll_transcription_job";
import { poll_download } from "@/shared/poll_download";
import { error_message, is_abort_error } from "@/shared/errors";
import { uuid7 } from "@/shared/identifiers";
import type {
  AnalysisJob,
  AgentIndexStatus,
  AgentTaskSnapshot,
  DownloadDestination,
  DownloadJob,
  ProbeResponse,
  TranscriptionOptions,
} from "@/shared/types";
import { merge_task_record, type TaskRecord } from "@/features/workbench/tasks";

const INACTIVE_DOWNLOAD_STAGES = new Set(["complete", "failed", "paused"]);
const INITIAL_DOWNLOAD_TASK_LIMIT = 50;
const AGENT_TASK_REFRESH_INTERVAL_MS = 2_000;
const TRANSCRIPTION_STAGES = new Set<AgentIndexStatus["stage"]>([
  "preparing_transcription_model",
  "extracting_audio",
  "transcribing",
]);

type TaskManager = {
  task_records: TaskRecord[];
  task_center_open: boolean;
  set_task_center_open: (open: boolean) => void;
  selected_probe: ProbeResult | null;
  clear_selected_probe: () => void;
  start_probe: (source_url: string) => void;
  view_probe_result: (task_id: string) => void;
  retry_task: (task_id: string) => Promise<void>;
  pause_task: (task_id: string) => Promise<void>;
  delete_task: (task_id: string) => Promise<void>;
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
};

type ProbeResult = { source_url: string; result: ProbeResponse };
type ProbeTask = {
  source_url: string;
  controller: AbortController;
  result?: ProbeResponse;
};
type DownloadSubmission = {
  source_url: string;
  destination?: DownloadDestination;
};

const TaskManagerContext = createContext<TaskManager | null>(null);

export function TaskManagerProvider({ children }: { children: ReactNode }) {
  const query_client = useQueryClient();
  const { assets, selected_asset_id } = use_asset_catalog();
  const [task_records, set_task_records] = useState<TaskRecord[]>([]);
  const [task_center_open, set_task_center_open] = useState(false);
  const [selected_probe, set_selected_probe] = useState<ProbeResult | null>(
    null,
  );
  const probe_tasks = useRef(new Map<string, ProbeTask>());
  const download_submissions = useRef(new Map<string, DownloadSubmission>());
  const download_actions = useRef(new Set<string>());
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
    const probes = probe_tasks.current;
    return () => {
      downloads.forEach((controller) => controller.abort());
      requests.forEach((controller) => controller.abort());
      transcriptions.forEach((controller) => controller.abort());
      downloads.clear();
      requests.clear();
      transcriptions.clear();
      probes.forEach((task) => task.controller.abort());
      probes.clear();
    };
  }, []);

  const record_task = useCallback((task: TaskRecord) => {
    set_task_records((current) => merge_task_record(current, task));
  }, []);

  const record_download_job = useCallback(
    (job: DownloadJob) => {
      if (download_actions.current.has(job.job_id)) return;
      record_task({
        task_id: job.job_id,
        task_type: "download",
        stage: job.stage,
        message: job.message,
        progress_percent: job.progress_percent,
        error_message: job.error_message,
        created_at: job.created_at,
        name: job.name,
        retry_available: job.stage === "failed" || job.stage === "paused",
        pause_available:
          !INACTIVE_DOWNLOAD_STAGES.has(job.stage) && job.stage !== "pausing",
        delete_available: INACTIVE_DOWNLOAD_STAGES.has(job.stage),
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
    let refresh_pending = false;
    const refresh_agent_tasks = async () => {
      if (controller.signal.aborted || refresh_pending) return;
      refresh_pending = true;
      try {
        const snapshots = await list_agent_tasks(controller.signal);
        if (!controller.signal.aborted) record_agent_tasks(snapshots);
      } catch {
        // 离线壳层未提供 Agent 端点时不影响下载与转录任务。
      } finally {
        refresh_pending = false;
      }
    };
    void refresh_agent_tasks();
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
    let refresh_pending = false;
    const refresh_index_status = async () => {
      if (controller.signal.aborted || refresh_pending) return;
      refresh_pending = true;
      try {
        const status = await get_agent_index_status(
          selected_asset_id,
          controller.signal,
        );
        if (controller.signal.aborted) return;
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
      } catch {
        // 离线壳层未提供索引端点时，其余任务仍可继续。
      } finally {
        refresh_pending = false;
      }
    };
    void refresh_index_status();
    const interval_id = window.setInterval(
      refresh_index_status,
      AGENT_TASK_REFRESH_INTERVAL_MS,
    );
    return () => {
      controller.abort();
      window.clearInterval(interval_id);
    };
  }, [query_client, record_task, selected_asset_id]);

  const refresh_download_catalog = useCallback(
    () =>
      Promise.all([
        query_client.invalidateQueries({
          queryKey: RESOURCE_QUERY_KEYS.assets,
        }),
        query_client.invalidateQueries({
          queryKey: RESOURCE_QUERY_KEYS.library_folders,
        }),
      ]),
    [query_client],
  );

  const track_download_jobs = useCallback(
    (jobs: DownloadJob[]) => {
      if (jobs.length > 0) void refresh_download_catalog();
      for (const job of jobs) {
        record_download_job(job);
        if (
          INACTIVE_DOWNLOAD_STAGES.has(job.stage) ||
          download_actions.current.has(job.job_id) ||
          download_controllers.current.has(job.job_id)
        )
          continue;
        const controller = new AbortController();
        download_controllers.current.set(job.job_id, controller);
        void poll_download(job, record_download_job, controller.signal)
          .then(refresh_download_catalog)
          .catch((error: unknown) => {
            if (!controller.signal.aborted && !is_abort_error(error)) {
              set_task_records((current) =>
                current.map((task) =>
                  task.task_id === job.job_id
                    ? {
                        ...task,
                        stage: "interrupted",
                        message: "下载进度同步中断，可重新连接查看",
                        error_message: error_message(error),
                        retry_available: true,
                        delete_available: true,
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
    [refresh_download_catalog, record_download_job],
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

  const submit_downloads = useCallback(
    async (
      urls: string[],
      destination: DownloadDestination | undefined,
      job_ids: string[],
    ) => {
      const controller = new AbortController();
      download_requests.current.add(controller);
      for (const [index, job_id] of job_ids.entries()) {
        const source_url = urls[index];
        download_submissions.current.set(job_id, { source_url, destination });
        record_task({
          task_id: job_id,
          task_type: "download",
          stage: "submitting",
          message: "已加入队列，正在提交下载",
          name: source_url,
          progress_percent: 0,
          progress_known: false,
          error_message: null,
          created_at: new Date().toISOString(),
        });
      }
      set_task_center_open(true);
      try {
        const jobs = await create_download(
          urls,
          controller.signal,
          destination,
          job_ids,
        );
        controller.signal.throwIfAborted();
        // 后端可能复用同一视频的已有任务，替换临时行以免显示两份。
        const confirmed_ids = new Set(jobs.map((job) => job.job_id));
        set_task_records((current) =>
          current.filter(
            (task) =>
              !job_ids.includes(task.task_id) ||
              confirmed_ids.has(task.task_id),
          ),
        );
        job_ids.forEach((job_id) =>
          download_submissions.current.delete(job_id),
        );
        track_download_jobs(jobs);
        return jobs;
      } catch (error) {
        if (!is_abort_error(error)) {
          set_task_records((current) =>
            current.map((task) =>
              job_ids.includes(task.task_id)
                ? {
                    ...task,
                    stage: "failed",
                    message: "提交失败，可重新开始或删除任务",
                    error_message: error_message(error),
                    retry_available: true,
                    delete_available: true,
                  }
                : task,
            ),
          );
        }
        throw error;
      } finally {
        download_requests.current.delete(controller);
      }
    },
    [record_task, track_download_jobs],
  );

  const start_downloads = useCallback(
    (urls: string[], destination?: DownloadDestination) =>
      submit_downloads(
        urls,
        destination,
        urls.map(() => `job-${uuid7().replaceAll("-", "")}`),
      ),
    [submit_downloads],
  );

  const run_probe = useCallback(
    async (task_id: string, source_url: string) => {
      const controller = new AbortController();
      probe_tasks.current.set(task_id, { source_url, controller });
      const task: TaskRecord = {
        task_id,
        task_type: "probe",
        name: source_url,
        stage: "probing",
        message: "正在解析视频列表，可继续使用其他功能",
        progress_percent: 0,
        progress_known: false,
        error_message: null,
        created_at: new Date().toISOString(),
      };
      record_task(task);
      set_task_center_open(true);
      try {
        const result = await probe_source(source_url, controller.signal);
        controller.signal.throwIfAborted();
        probe_tasks.current.set(task_id, { source_url, controller, result });
        record_task({
          ...task,
          name: result.title ?? source_url,
          stage: "complete",
          message: `已找到 ${result.entries.length} 个视频，请选择要下载的内容`,
          progress_percent: 100,
          result_available: true,
          delete_available: true,
        });
      } catch (error) {
        if (!is_abort_error(error))
          record_task({
            ...task,
            stage: "failed",
            message: "链接解析失败",
            error_message: error_message(error),
            retry_available: true,
            delete_available: true,
          });
      }
    },
    [record_task],
  );

  const start_probe = useCallback(
    (source_url: string) => {
      void run_probe(`probe-${uuid7().replaceAll("-", "")}`, source_url);
    },
    [run_probe],
  );

  const view_probe_result = useCallback((task_id: string) => {
    const task = probe_tasks.current.get(task_id);
    if (!task?.result) return;
    set_task_center_open(false);
    set_selected_probe({ source_url: task.source_url, result: task.result });
  }, []);
  const clear_selected_probe = useCallback(() => set_selected_probe(null), []);

  const pause_task = useCallback(
    async (task_id: string) => {
      download_actions.current.add(task_id);
      download_controllers.current.get(task_id)?.abort();
      download_controllers.current.delete(task_id);
      set_task_records((current) =>
        current.map((task) =>
          task.task_id === task_id
            ? {
                ...task,
                stage: "pausing",
                message: "正在停止下载，保留续传分片",
                pause_available: false,
              }
            : task,
        ),
      );
      try {
        const job = await pause_download(task_id);
        download_actions.current.delete(task_id);
        track_download_jobs([job]);
      } catch (error) {
        download_actions.current.delete(task_id);
        set_task_records((current) =>
          current.map((task) =>
            task.task_id === task_id
              ? {
                  ...task,
                  stage: "interrupted",
                  message: "未能确认暂停状态，请重新连接",
                  error_message: error_message(error),
                  retry_available: true,
                  delete_available: true,
                }
              : task,
          ),
        );
        throw error;
      }
    },
    [track_download_jobs],
  );

  const delete_task = useCallback(
    async (task_id: string) => {
      const previous_task = task_records.find(
        (task) => task.task_id === task_id,
      );
      if (!previous_task) return;
      set_task_records((current) =>
        current.filter((task) => task.task_id !== task_id),
      );
      const probe = probe_tasks.current.get(task_id);
      if (probe) {
        probe.controller.abort();
        probe_tasks.current.delete(task_id);
        return;
      }
      download_actions.current.add(task_id);
      download_controllers.current.get(task_id)?.abort();
      download_controllers.current.delete(task_id);
      try {
        // 请求失败可能只是响应丢失，删除前先确认服务器是否已启动下载。
        try {
          const job = await get_download(task_id);
          if (!INACTIVE_DOWNLOAD_STAGES.has(job.stage))
            await pause_download(task_id);
          await delete_download(task_id);
        } catch (error) {
          if (!(error instanceof ApiError && error.status === 404)) throw error;
        }
        download_submissions.current.delete(task_id);
      } catch (error) {
        record_task({ ...previous_task, error_message: error_message(error) });
        download_actions.current.delete(task_id);
        throw error;
      }
    },
    [record_task, task_records],
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
        controller.signal.throwIfAborted();
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

  const retry_task = useCallback(
    async (task_id: string) => {
      const probe = probe_tasks.current.get(task_id);
      if (probe) {
        await run_probe(task_id, probe.source_url);
        return;
      }
      const submission = download_submissions.current.get(task_id);
      const previous_task = task_records.find(
        (task) => task.task_id === task_id,
      );
      if (previous_task?.task_type === "download") {
        download_actions.current.add(task_id);
        download_controllers.current.get(task_id)?.abort();
        download_controllers.current.delete(task_id);
        record_task({
          ...previous_task,
          stage: "submitting",
          message: "正在重新连接下载任务",
          error_message: null,
          retry_available: false,
          delete_available: false,
          pause_available: false,
        });
        try {
          const current_job = await get_download(task_id);
          download_submissions.current.delete(task_id);
          const job =
            current_job.stage === "failed" || current_job.stage === "paused"
              ? await resume_download(task_id)
              : current_job;
          download_actions.current.delete(task_id);
          track_download_jobs([job]);
        } catch (error) {
          download_actions.current.delete(task_id);
          if (submission && error instanceof ApiError && error.status === 404) {
            await submit_downloads(
              [submission.source_url],
              submission.destination,
              [task_id],
            );
            return;
          }
          record_task({
            ...previous_task,
            error_message: error_message(error),
          });
          throw error;
        }
        return;
      }
      await retry_agent_run(task_id);
      try {
        record_agent_tasks(await list_agent_tasks());
      } catch {
        // 重试已启动时不因一次刷新失败误报，下一轮轮询会补齐状态。
      }
    },
    [
      record_agent_tasks,
      record_task,
      run_probe,
      submit_downloads,
      task_records,
      track_download_jobs,
    ],
  );

  const value = useMemo<TaskManager>(
    () => ({
      task_records,
      task_center_open,
      set_task_center_open,
      selected_probe,
      clear_selected_probe,
      start_probe,
      view_probe_result,
      pause_task,
      delete_task,
      index_status,
      start_downloads,
      retry_task,
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
      retry_task,
      task_center_open,
      selected_probe,
      clear_selected_probe,
      start_probe,
      view_probe_result,
      pause_task,
      delete_task,
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
