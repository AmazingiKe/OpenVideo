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
  list_downloads,
  request_download_retry,
  transcribe_asset,
} from "@/shared/api";
import { poll_transcription_job } from "@/shared/poll_transcription_job";
import { poll_download } from "@/shared/poll_download";
import type {
  AnalysisJob,
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
  start_transcription: (
    asset_id: string,
    options: TranscriptionOptions,
  ) => Promise<AnalysisJob>;
  is_transcription_running: (asset_id: string) => boolean;
};

const TaskManagerContext = createContext<TaskManager | null>(null);

export function TaskManagerProvider({ children }: { children: ReactNode }) {
  const { refresh_assets, select_asset } = use_asset_catalog();
  const [task_records, set_task_records] = useState<TaskRecord[]>([]);
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

  const value = useMemo<TaskManager>(
    () => ({
      task_records,
      start_downloads,
      retry_download,
      start_transcription,
      is_transcription_running: (asset_id) =>
        active_transcriptions.has(asset_id),
    }),
    [
      active_transcriptions,
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
