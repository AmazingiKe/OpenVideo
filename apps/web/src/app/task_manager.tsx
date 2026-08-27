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
  analyze_asset,
  create_download,
  list_downloads,
  request_download_retry,
  transcribe_asset,
} from "@/shared/api";
import { poll_analysis } from "@/shared/poll_analysis";
import { poll_download } from "@/shared/poll_download";
import type {
  AnalysisJob,
  AnalysisMode,
  AnalysisOperation,
  AnalysisStrategy,
  DownloadDestination,
  DownloadJob,
  TranscriptionOptions,
} from "@/shared/types";
import { merge_task_record, type TaskRecord } from "@/features/workbench/tasks";

const TERMINAL_DOWNLOAD_STAGES = new Set(["complete", "failed"]);
const INITIAL_DOWNLOAD_TASK_LIMIT = 50;

type TaskManager = {
  task_records: TaskRecord[];
  start_downloads: (
    urls: string[],
    destination?: DownloadDestination,
  ) => Promise<DownloadJob[]>;
  retry_download: (job_id: string) => Promise<DownloadJob>;
  start_analysis: (
    asset_id: string,
    mode: AnalysisMode,
    marker_ids: string[],
    ai_model_id: string | null,
    strategy: AnalysisStrategy,
  ) => Promise<AnalysisJob>;
  start_transcription: (
    asset_id: string,
    options: TranscriptionOptions,
  ) => Promise<AnalysisJob>;
  is_operation_running: (
    asset_id: string,
    operation: AnalysisOperation,
  ) => boolean;
};

const TaskManagerContext = createContext<TaskManager | null>(null);

export function TaskManagerProvider({ children }: { children: ReactNode }) {
  const { refresh_assets, select_asset } = use_asset_catalog();
  const [task_records, set_task_records] = useState<TaskRecord[]>([]);
  const [active_operations, set_active_operations] = useState<Set<string>>(
    new Set(),
  );
  const download_controller_ref = useRef<AbortController | null>(null);
  const analysis_controller_ref = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      download_controller_ref.current?.abort();
      analysis_controller_ref.current?.abort();
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

  const record_analysis_job = useCallback(
    (job: AnalysisJob) => {
      record_task({
        task_id: job.job_id,
        task_type: "analysis",
        stage: job.stage,
        message: job.message,
        progress_percent: job.progress_percent,
        error_message: job.error_message,
        created_at: job.created_at,
        name: "素材分析",
        events: [],
      });
    },
    [record_task],
  );

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

  const run_analysis_operation = useCallback(
    async (
      asset_id: string,
      operation: AnalysisOperation,
      create_job: (signal: AbortSignal) => Promise<AnalysisJob>,
    ) => {
      analysis_controller_ref.current?.abort();
      const controller = new AbortController();
      analysis_controller_ref.current = controller;
      const operation_key = `${asset_id}:${operation}`;
      set_active_operations((current) => new Set(current).add(operation_key));
      try {
        const job = await create_job(controller.signal);
        record_analysis_job(job);
        const final_job =
          job.stage === "complete"
            ? job
            : await poll_analysis(job, record_analysis_job, controller.signal);
        if (final_job.stage === "failed") {
          throw new Error(
            final_job.error_message ??
              (operation === "analysis" ? "分析失败" : "转录失败"),
          );
        }
        return final_job;
      } finally {
        set_active_operations((current) => {
          const next = new Set(current);
          next.delete(operation_key);
          return next;
        });
        if (analysis_controller_ref.current === controller) {
          analysis_controller_ref.current = null;
        }
      }
    },
    [record_analysis_job],
  );

  const start_analysis = useCallback(
    (
      asset_id: string,
      mode: AnalysisMode,
      marker_ids: string[],
      ai_model_id: string | null,
      strategy: AnalysisStrategy,
    ) =>
      run_analysis_operation(asset_id, "analysis", (signal) =>
        analyze_asset(
          asset_id,
          mode,
          marker_ids,
          ai_model_id,
          strategy,
          signal,
        ),
      ),
    [run_analysis_operation],
  );

  const start_transcription = useCallback(
    (asset_id: string, options: TranscriptionOptions) =>
      run_analysis_operation(asset_id, "transcription", (signal) =>
        transcribe_asset(asset_id, options, signal),
      ),
    [run_analysis_operation],
  );

  const value = useMemo<TaskManager>(
    () => ({
      task_records,
      start_downloads,
      retry_download,
      start_analysis,
      start_transcription,
      is_operation_running: (asset_id, operation) =>
        active_operations.has(`${asset_id}:${operation}`),
    }),
    [
      active_operations,
      start_analysis,
      start_downloads,
      retry_download,
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

export function use_task_manager(): TaskManager {
  const manager = useContext(TaskManagerContext);
  if (!manager) {
    throw new Error("use_task_manager 必须在 TaskManagerProvider 内使用");
  }
  return manager;
}
