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
import { useNavigate } from "react-router-dom";

import { use_asset_catalog } from "@/app/asset_catalog";
import { RESOURCE_QUERY_KEYS } from "@/app/query_cache";
import { marker_asset_path } from "@/app/workspace_routes";
import {
  use_media_import_tasks,
  type MediaImportSubmission,
} from "@/app/use_media_import_tasks";
import {
  create_download,
  cancel_analysis,
  get_analysis,
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
  list_analysis_tasks,
  analyze_asset,
  generate_chapters,
} from "@/shared/api";
import {
  poll_transcription_job,
  TERMINAL_ANALYSIS_STAGES,
} from "@/shared/poll_transcription_job";
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
const INITIAL_ANALYSIS_TASK_LIMIT = 50;
const AGENT_TASK_REFRESH_INTERVAL_MS = 2_000;
const RETRYABLE_ANALYSIS_STAGES = new Set<AnalysisJob["stage"]>([
  "failed",
  "cancelled",
  "rejected",
]);
const ANALYSIS_OPERATION_LABELS: Record<AnalysisJob["operation"], string> = {
  transcription: "转写",
  analysis: "视频分析",
  initialization: "后台初始化",
  chapters: "章节生成",
};
const TRANSCRIPTION_STAGES = new Set<AgentIndexStatus["stage"]>([
  "preparing_transcription_model",
  "extracting_audio",
  "transcribing",
]);

type TaskManager = {
  task_records: TaskRecord[];
  task_center_open: boolean;
  task_sync_error: string | null;
  set_task_center_open: (open: boolean) => void;
  selected_probe: ProbeResult | null;
  clear_selected_probe: () => void;
  start_probe: (source_url: string) => void;
  view_task_result: (task_id: string) => void;
  retry_task: (task_id: string) => Promise<void>;
  pause_task: (task_id: string) => Promise<void>;
  cancel_task: (task_id: string) => Promise<void>;
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
  enqueue_media_imports: (files: File[]) => MediaImportSubmission;
  enqueue_directory_import: (
    path: string,
    include_subfolders: boolean,
  ) => boolean;
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
type AnalysisTask = {
  job: AnalysisJob;
  options: TranscriptionOptions | null;
  controller: AbortController | null;
};

const TaskManagerContext = createContext<TaskManager | null>(null);

export function TaskManagerProvider({ children }: { children: ReactNode }) {
  const query_client = useQueryClient();
  const navigate = useNavigate();
  const { assets, selected_asset_id, select_asset } = use_asset_catalog();
  const [task_records, set_task_records] = useState<TaskRecord[]>([]);
  const [task_center_open, set_task_center_open] = useState(false);
  const [task_sync_error, set_task_sync_error] = useState<string | null>(null);
  const [selected_probe, set_selected_probe] = useState<ProbeResult | null>(
    null,
  );
  const probe_tasks = useRef(new Map<string, ProbeTask>());
  const download_submissions = useRef(new Map<string, DownloadSubmission>());
  const download_actions = useRef(new Set<string>());
  const [index_status, set_index_status] = useState<AgentIndexStatus | null>(
    null,
  );
  const [active_analysis_requests, set_active_analysis_requests] = useState<
    Map<string, AbortController>
  >(new Map());
  const download_controllers = useRef(new Map<string, AbortController>());
  const download_requests = useRef(new Set<AbortController>());
  const analysis_controllers = useRef(new Map<string, AbortController>());
  const analysis_tasks = useRef(new Map<string, AnalysisTask>());
  const analysis_actions = useRef(new Set<string>());
  const previous_index_status_ref = useRef<AgentIndexStatus | null>(null);

  useEffect(() => {
    const downloads = download_controllers.current;
    const requests = download_requests.current;
    const analysis_requests = analysis_controllers.current;
    const probes = probe_tasks.current;
    return () => {
      downloads.forEach((controller) => controller.abort());
      requests.forEach((controller) => controller.abort());
      analysis_requests.forEach((controller) => controller.abort());
      downloads.clear();
      requests.clear();
      analysis_requests.clear();
      probes.forEach((task) => task.controller.abort());
      probes.clear();
    };
  }, []);

  const record_task = useCallback((task: TaskRecord) => {
    set_task_records((current) => merge_task_record(current, task));
  }, []);
  const {
    enqueue_media_imports,
    enqueue_directory_import,
    cancel_media_import,
    retry_media_import,
    delete_media_import,
  } = use_media_import_tasks(record_task);

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
          (!INACTIVE_DOWNLOAD_STAGES.has(job.stage) &&
            job.stage !== "pausing") ||
          (job.stage === "pausing" && Boolean(job.error_message)),
        delete_available: INACTIVE_DOWNLOAD_STAGES.has(job.stage),
      });
    },
    [record_task],
  );

  const record_analysis_job = useCallback(
    (job: AnalysisJob) => {
      const tracked = analysis_tasks.current.get(job.job_id);
      if (!tracked) return;
      const current_job = tracked.job;
      if (Date.parse(current_job.updated_at) > Date.parse(job.updated_at))
        return;
      if (
        TERMINAL_ANALYSIS_STAGES.has(current_job.stage) &&
        !TERMINAL_ANALYSIS_STAGES.has(job.stage)
      )
        return;
      if (
        current_job.stage === "cancelling" &&
        job.stage !== "cancelling" &&
        !TERMINAL_ANALYSIS_STAGES.has(job.stage)
      )
        return;
      tracked.job = job;
      if (
        analysis_actions.current.has(job.job_id) &&
        !TERMINAL_ANALYSIS_STAGES.has(job.stage)
      )
        return;
      const needs_transcription_options =
        RETRYABLE_ANALYSIS_STAGES.has(job.stage) &&
        job.operation === "transcription" &&
        !tracked.options;
      const cannot_retry_initialization =
        RETRYABLE_ANALYSIS_STAGES.has(job.stage) &&
        job.operation === "initialization";
      const message = needs_transcription_options
        ? `${job.message}；请回视频页面选择模型重新转写。`
        : cannot_retry_initialization
          ? `${job.message}；可回视频页面按需重新转写或生成章节。`
          : job.message;
      record_task({
        task_id: job.job_id,
        asset_id: job.asset_id,
        task_type:
          job.operation === "transcription" ? "transcription" : "analysis",
        stage: job.stage,
        message,
        progress_percent: job.progress_percent,
        progress_known: job.stage !== "cancelling" && job.progress_known === true,
        error_message: job.error_message,
        created_at: job.created_at,
        started_at: job.started_at,
        updated_at: job.updated_at,
        name: `${assets.find((asset) => asset.asset_id === job.asset_id)?.title ?? "视频"} · ${ANALYSIS_OPERATION_LABELS[job.operation]}`,
        retry_available: analysis_retry_available(tracked),
        cancel_available:
          !TERMINAL_ANALYSIS_STAGES.has(job.stage) &&
          (job.stage !== "cancelling" || Boolean(job.error_message)),
        result_available: TERMINAL_ANALYSIS_STAGES.has(job.stage),
      });
    },
    [assets, record_task],
  );

  useEffect(() => {
    const controller = new AbortController();
    let refreshing = false;
    async function refresh_analysis_tasks() {
      if (refreshing || controller.signal.aborted) return;
      refreshing = true;
      try {
        const snapshots = await list_analysis_tasks(
          INITIAL_ANALYSIS_TASK_LIMIT,
          controller.signal,
        );
        controller.signal.throwIfAborted();
        set_task_sync_error(null);
        for (const snapshot of snapshots) {
          const { job } = snapshot;
          let tracked = analysis_tasks.current.get(job.job_id);
          const previous_stage = tracked?.job.stage;
          if (!tracked) {
            tracked = {
              job,
              options: snapshot.transcription_options,
              controller: null,
            };
            analysis_tasks.current.set(job.job_id, tracked);
          } else if (!tracked.options && snapshot.transcription_options) {
            tracked.options = snapshot.transcription_options;
          }
          record_analysis_job(job);
          if (TERMINAL_ANALYSIS_STAGES.has(tracked.job.stage)) {
            tracked.controller?.abort();
            if (
              tracked.job.stage === "complete" &&
              previous_stage &&
              previous_stage !== "complete"
            ) {
              void query_client.invalidateQueries({
                queryKey: RESOURCE_QUERY_KEYS.asset_analysis(job.asset_id),
              });
            }
          } else {
            set_task_records((current) =>
              current.filter(
                (task) =>
                  task.task_type !== "index" ||
                  task.index_state !== "initializing" ||
                  task.asset_id !== job.asset_id,
              ),
            );
          }
        }
      } catch (error) {
        if (!controller.signal.aborted && !is_abort_error(error))
          set_task_sync_error(
            `分析任务同步中断，后台任务仍可能运行。${error_message(error)}`,
          );
      } finally {
        refreshing = false;
      }
    }
    void refresh_analysis_tasks();
    const interval = window.setInterval(
      () => void refresh_analysis_tasks(),
      AGENT_TASK_REFRESH_INTERVAL_MS,
    );
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [query_client, record_analysis_job]);

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
            const has_analysis_task = [...analysis_tasks.current.values()].some(
              (task) =>
                task.job.asset_id === status.asset_id &&
                !TERMINAL_ANALYSIS_STAGES.has(task.job.stage),
            );
            if (status.state !== "initializing" || !has_analysis_task)
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

  const view_task_result = useCallback(
    (task_id: string) => {
      const analysis = analysis_tasks.current.get(task_id);
      if (analysis) {
        select_asset(analysis.job.asset_id);
        set_task_center_open(false);
        void navigate(marker_asset_path(analysis.job.asset_id));
        return;
      }
      const task = probe_tasks.current.get(task_id);
      if (!task?.result) return;
      set_task_center_open(false);
      set_selected_probe({ source_url: task.source_url, result: task.result });
      void navigate("/library");
    },
    [navigate, select_asset],
  );
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
      if (delete_media_import(task_id)) {
        set_task_records((current) =>
          current.filter((task) => task.task_id !== task_id),
        );
        return;
      }
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
    [delete_media_import, record_task, task_records],
  );

  const observe_analysis = useCallback(
    async (job: AnalysisJob, controller: AbortController) => {
      const asset_id = job.asset_id;
      record_analysis_job(job);
      try {
        const final_job = await poll_transcription_job(
          job,
          record_analysis_job,
          controller.signal,
        );
        if (final_job.stage === "failed" || final_job.stage === "rejected") {
          throw new Error(final_job.error_message ?? final_job.message);
        }
        if (final_job.stage === "complete") {
          await query_client.invalidateQueries({
            queryKey: RESOURCE_QUERY_KEYS.asset_analysis(asset_id),
          });
        }
        return final_job;
      } catch (error) {
        const confirmed_job = analysis_tasks.current.get(job.job_id)?.job;
        if (
          controller.signal.aborted &&
          confirmed_job &&
          TERMINAL_ANALYSIS_STAGES.has(confirmed_job.stage)
        ) {
          return confirmed_job;
        }
        if (
          !controller.signal.aborted &&
          !is_abort_error(error) &&
          confirmed_job &&
          !TERMINAL_ANALYSIS_STAGES.has(confirmed_job.stage)
        ) {
          set_task_records((current) =>
            current.map((task) =>
              task.task_id === job.job_id
                ? {
                    ...task,
                    stage: "interrupted",
                    message: `${ANALYSIS_OPERATION_LABELS[job.operation]}进度同步中断，后台任务仍可能运行`,
                    error_message: error_message(error),
                    retry_available: true,
                    cancel_available:
                      confirmed_job.stage !== "cancelling" ||
                      Boolean(confirmed_job.error_message),
                  }
                : task,
            ),
          );
        }
        throw error;
      } finally {
        if (analysis_controllers.current.get(asset_id) === controller) {
          analysis_controllers.current.delete(asset_id);
        }
        const confirmed_job = analysis_tasks.current.get(job.job_id)?.job;
        if (
          confirmed_job &&
          TERMINAL_ANALYSIS_STAGES.has(confirmed_job.stage)
        ) {
          set_active_analysis_requests((current) => {
            if (current.get(asset_id) !== controller) return current;
            const next = new Map(current);
            next.delete(asset_id);
            return next;
          });
        }
      }
    },
    [query_client, record_analysis_job],
  );

  const start_transcription = useCallback(
    async (asset_id: string, options: TranscriptionOptions) => {
      const unfinished_task = [...analysis_tasks.current.values()].some(
        (task) =>
          task.job.asset_id === asset_id &&
          !TERMINAL_ANALYSIS_STAGES.has(task.job.stage),
      );
      if (analysis_controllers.current.has(asset_id) || unfinished_task)
        throw new Error("该视频已在转写队列中，请在任务中心查看或重新连接");
      const controller = new AbortController();
      analysis_controllers.current.set(asset_id, controller);
      set_active_analysis_requests((current) =>
        new Map(current).set(asset_id, controller),
      );
      let accepted = false;
      try {
        const job = await transcribe_asset(
          asset_id,
          options,
          controller.signal,
        );
        controller.signal.throwIfAborted();
        accepted = true;
        analysis_tasks.current.set(job.job_id, {
          job,
          options,
          controller,
        });
        set_task_center_open(true);
        return await observe_analysis(job, controller);
      } finally {
        if (!accepted) {
          if (analysis_controllers.current.get(asset_id) === controller)
            analysis_controllers.current.delete(asset_id);
          set_active_analysis_requests((current) => {
            if (current.get(asset_id) !== controller) return current;
            const next = new Map(current);
            next.delete(asset_id);
            return next;
          });
        }
      }
    },
    [observe_analysis],
  );

  const cancel_task = useCallback(
    async (task_id: string) => {
      if (cancel_media_import(task_id)) return;
      const tracked = analysis_tasks.current.get(task_id);
      if (
        !tracked ||
        TERMINAL_ANALYSIS_STAGES.has(tracked.job.stage) ||
        (tracked.job.stage === "cancelling" && !tracked.job.error_message) ||
        analysis_actions.current.has(task_id)
      )
        return;
      analysis_actions.current.add(task_id);
      set_task_records((current) =>
        current.map((task) =>
          task.task_id === task_id
            ? {
                ...task,
                stage: "cancelling",
                message: "正在请求停止，等待后台安全退出",
                cancel_available: false,
                retry_available: false,
                error_message: null,
              }
            : task,
        ),
      );
      try {
        const job = await cancel_analysis(task_id);
        analysis_actions.current.delete(task_id);
        record_analysis_job(job);
        const controller = tracked.controller;
        if (tracked.job.stage === "cancelled") {
          controller?.abort();
          set_active_analysis_requests((current) => {
            if (current.get(job.asset_id) !== controller) return current;
            const next = new Map(current);
            next.delete(job.asset_id);
            return next;
          });
        } else if (
          !analysis_controllers.current.has(job.asset_id) &&
          !TERMINAL_ANALYSIS_STAGES.has(tracked.job.stage)
        ) {
          const observation = new AbortController();
          tracked.controller = observation;
          analysis_controllers.current.set(job.asset_id, observation);
          set_active_analysis_requests((current) =>
            new Map(current).set(job.asset_id, observation),
          );
          void observe_analysis(tracked.job, observation).catch(
            () => undefined,
          );
        }
      } catch (error) {
        analysis_actions.current.delete(task_id);
        record_analysis_job(tracked.job);
        set_task_records((current) =>
          current.map((task) =>
            task.task_id === task_id
              ? { ...task, error_message: error_message(error) }
              : task,
          ),
        );
        throw error;
      }
    },
    [cancel_media_import, observe_analysis, record_analysis_job],
  );

  const retry_task = useCallback(
    async (task_id: string) => {
      if (retry_media_import(task_id)) return;
      const probe = probe_tasks.current.get(task_id);
      if (probe) {
        await run_probe(task_id, probe.source_url);
        return;
      }
      const analysis = analysis_tasks.current.get(task_id);
      if (analysis) {
        if (RETRYABLE_ANALYSIS_STAGES.has(analysis.job.stage)) {
          if (!analysis_retry_available(analysis))
            throw new Error(
              "请回视频页面选择转写模型或生成章节，当前任务缺少安全重试所需信息",
            );
          if (analysis.job.operation === "transcription" && analysis.options) {
            await start_transcription(analysis.job.asset_id, analysis.options);
          } else {
            const previous_job = analysis.job;
            const asset_id = previous_job.asset_id;
            const has_active_job = [...analysis_tasks.current.values()].some(
              (task) =>
                task.job.asset_id === asset_id &&
                !TERMINAL_ANALYSIS_STAGES.has(task.job.stage),
            );
            if (analysis_controllers.current.has(asset_id) || has_active_job)
              throw new Error("该视频已有分析任务，请先查看或停止现有任务");
            const controller = new AbortController();
            analysis_controllers.current.set(asset_id, controller);
            set_active_analysis_requests((current) =>
              new Map(current).set(asset_id, controller),
            );
            let accepted = false;
            try {
              const job =
                previous_job.operation === "chapters"
                  ? await generate_chapters(asset_id, controller.signal)
                  : await analyze_asset(
                      asset_id,
                      {
                        mode: previous_job.mode,
                        ai_model_id: previous_job.ai_model_id,
                        strategy: previous_job.strategy,
                      },
                      controller.signal,
                    );
              controller.signal.throwIfAborted();
              analysis_tasks.current.set(job.job_id, {
                job,
                options: null,
                controller,
              });
              accepted = true;
              void observe_analysis(job, controller).catch(() => undefined);
            } finally {
              if (!accepted) {
                if (analysis_controllers.current.get(asset_id) === controller)
                  analysis_controllers.current.delete(asset_id);
                set_active_analysis_requests((current) => {
                  if (current.get(asset_id) !== controller) return current;
                  const next = new Map(current);
                  next.delete(asset_id);
                  return next;
                });
              }
            }
          }
        } else if (
          !TERMINAL_ANALYSIS_STAGES.has(analysis.job.stage) &&
          !analysis_controllers.current.has(analysis.job.asset_id)
        ) {
          const controller = new AbortController();
          analysis_controllers.current.set(analysis.job.asset_id, controller);
          analysis.controller = controller;
          set_active_analysis_requests((current) =>
            new Map(current).set(analysis.job.asset_id, controller),
          );
          try {
            const job = await get_analysis(task_id, controller.signal);
            controller.signal.throwIfAborted();
            void observe_analysis(job, controller).catch(() => undefined);
          } catch (error) {
            if (
              analysis_controllers.current.get(analysis.job.asset_id) ===
              controller
            )
              analysis_controllers.current.delete(analysis.job.asset_id);
            throw error;
          }
        }
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
      retry_media_import,
      observe_analysis,
      start_transcription,
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
      task_sync_error,
      set_task_center_open,
      selected_probe,
      clear_selected_probe,
      start_probe,
      view_task_result,
      pause_task,
      cancel_task,
      delete_task,
      index_status,
      start_downloads,
      retry_task,
      start_transcription,
      is_transcription_running: (asset_id) =>
        active_analysis_requests.has(asset_id) ||
        task_records.some(
          (task) =>
            task.asset_id === asset_id &&
            (task.task_type === "transcription" ||
              task.task_type === "analysis") &&
            !TERMINAL_ANALYSIS_STAGES.has(task.stage as AnalysisJob["stage"]),
        ) ||
        (index_status?.asset_id === asset_id &&
          TRANSCRIPTION_STAGES.has(index_status.stage)),
      enqueue_media_imports,
      enqueue_directory_import,
    }),
    [
      active_analysis_requests,
      enqueue_media_imports,
      enqueue_directory_import,
      index_status,
      start_downloads,
      retry_task,
      task_center_open,
      task_sync_error,
      selected_probe,
      clear_selected_probe,
      start_probe,
      view_task_result,
      pause_task,
      cancel_task,
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

function analysis_retry_available(task: AnalysisTask): boolean {
  if (!RETRYABLE_ANALYSIS_STAGES.has(task.job.stage)) return false;
  if (task.job.operation === "initialization") return false;
  return task.job.operation !== "transcription" || task.options !== null;
}

function agent_task_message(stage: AgentTaskSnapshot["run"]["stage"]): string {
  return {
    pending: "等待助手开始",
    running: "助手正在处理",
    cancelling: "正在停止助手，等待后台退出",
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
    cancelling: 50,
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
    asset_id: status.asset_id ?? undefined,
    index_state: status.state,
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
