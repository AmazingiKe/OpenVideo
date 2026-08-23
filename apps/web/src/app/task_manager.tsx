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
import { analyze_asset, create_download, transcribe_asset } from "@/shared/api";
import { poll_analysis } from "@/shared/poll_analysis";
import { poll_download } from "@/shared/poll_download";
import type {
  AnalysisJob,
  AnalysisMode,
  AnalysisOperation,
  DownloadJob,
  TranscriptionOptions,
} from "@/shared/types";
import type { TaskRecord } from "@/features/workbench/tasks";

const MAX_TASK_RECORDS = 100;
const TERMINAL_DOWNLOAD_STAGES = new Set(["complete", "failed"]);

type TaskManager = {
  task_records: TaskRecord[];
  start_downloads: (urls: string[]) => Promise<DownloadJob[]>;
  start_analysis: (
    asset_id: string,
    mode: AnalysisMode,
    marker_ids: string[],
    ai_model_id: string | null,
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
    set_task_records((current) => {
      const remaining_tasks = current.filter(
        (item) => item.task_id !== task.task_id,
      );
      return [task, ...remaining_tasks].slice(0, MAX_TASK_RECORDS);
    });
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
      });
    },
    [record_task],
  );

  const start_downloads = useCallback(
    async (urls: string[]) => {
      download_controller_ref.current?.abort();
      const controller = new AbortController();
      download_controller_ref.current = controller;
      try {
        const jobs = await create_download(urls, controller.signal);
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
      } finally {
        if (download_controller_ref.current === controller) {
          download_controller_ref.current = null;
        }
      }
    },
    [record_download_job, refresh_assets, select_asset],
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
    ) =>
      run_analysis_operation(asset_id, "analysis", (signal) =>
        analyze_asset(asset_id, mode, marker_ids, ai_model_id, signal),
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
      start_analysis,
      start_transcription,
      is_operation_running: (asset_id, operation) =>
        active_operations.has(`${asset_id}:${operation}`),
    }),
    [
      active_operations,
      start_analysis,
      start_downloads,
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
