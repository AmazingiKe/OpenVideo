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
  create_transcript_correction,
  list_asset_agent_jobs,
  list_downloads,
  respond_to_agent_job,
  transcribe_asset,
} from "@/shared/api";
import { poll_agent_job } from "@/shared/poll_agent_job";
import { poll_analysis } from "@/shared/poll_analysis";
import { poll_download } from "@/shared/poll_download";
import type {
  AnalysisJob,
  AnalysisMode,
  AnalysisOperation,
  AnalysisStrategy,
  DownloadJob,
  TranscriptionOptions,
  AgentJob,
  AgentQuestionAction,
} from "@/shared/types";
import { merge_task_record, type TaskRecord } from "@/features/workbench/tasks";

const TERMINAL_DOWNLOAD_STAGES = new Set(["complete", "failed"]);
const INITIAL_DOWNLOAD_TASK_LIMIT = 50;

type TaskManager = {
  task_records: TaskRecord[];
  start_downloads: (
    urls: string[],
    folder_id?: string | null,
  ) => Promise<DownloadJob[]>;
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
  agent_job_for_asset: (asset_id: string) => AgentJob | null;
  start_transcript_correction: (
    asset_id: string,
    segment_indices: number[] | null,
    ai_model_id: string,
  ) => Promise<AgentJob>;
  restore_transcript_correction: (asset_id: string) => Promise<AgentJob | null>;
  respond_to_transcript_correction: (
    job: AgentJob,
    action: AgentQuestionAction,
    ai_model_id?: string | null,
  ) => Promise<AgentJob>;
};

const TaskManagerContext = createContext<TaskManager | null>(null);

export function TaskManagerProvider({ children }: { children: ReactNode }) {
  const { refresh_assets, select_asset } = use_asset_catalog();
  const [task_records, set_task_records] = useState<TaskRecord[]>([]);
  const [active_operations, set_active_operations] = useState<Set<string>>(
    new Set(),
  );
  const [agent_jobs_by_asset, set_agent_jobs_by_asset] = useState<
    Map<string, AgentJob>
  >(new Map());
  const download_controller_ref = useRef<AbortController | null>(null);
  const analysis_controller_ref = useRef<AbortController | null>(null);
  const agent_controller_ref = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      download_controller_ref.current?.abort();
      analysis_controller_ref.current?.abort();
      agent_controller_ref.current?.abort();
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

  const record_agent_job = useCallback(
    (job: AgentJob) => {
      set_agent_jobs_by_asset((current) => {
        const next = new Map(current);
        next.set(job.asset_id, job);
        return next;
      });
      record_task({
        task_id: job.job_id,
        task_type: "agent",
        stage: job.stage,
        message: job.message,
        progress_percent: job.progress_percent,
        error_message: job.error_message,
        created_at: job.created_at,
        name: "转录修正",
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

  const start_downloads = useCallback(
    async (urls: string[], folder_id: string | null = null) => {
      download_controller_ref.current?.abort();
      const controller = new AbortController();
      download_controller_ref.current = controller;
      try {
        const jobs = await create_download(urls, controller.signal, folder_id);
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

  const follow_agent_job = useCallback(
    async (job: AgentJob, controller: AbortController) => {
      record_agent_job(job);
      const final_job = await poll_agent_job(
        job,
        record_agent_job,
        controller.signal,
      );
      record_agent_job(final_job);
      if (final_job.stage === "failed") {
        throw new Error(final_job.error_message ?? "转录修正失败");
      }
      return final_job;
    },
    [record_agent_job],
  );

  const with_agent_controller = useCallback(
    async function run_with_agent_controller<Result>(
      operation: (controller: AbortController) => Promise<Result>,
    ): Promise<Result> {
      agent_controller_ref.current?.abort();
      const controller = new AbortController();
      agent_controller_ref.current = controller;
      try {
        return await operation(controller);
      } finally {
        if (agent_controller_ref.current === controller) {
          agent_controller_ref.current = null;
        }
      }
    },
    [],
  );

  const start_transcript_correction = useCallback(
    (asset_id: string, segment_indices: number[] | null, ai_model_id: string) =>
      with_agent_controller(async (controller) => {
        const job = await create_transcript_correction(
          asset_id,
          segment_indices,
          ai_model_id,
          controller.signal,
        );
        return follow_agent_job(job, controller);
      }),
    [follow_agent_job, with_agent_controller],
  );

  const restore_transcript_correction = useCallback(
    (asset_id: string) =>
      with_agent_controller(async (controller) => {
        const jobs = await list_asset_agent_jobs(
          asset_id,
          true,
          controller.signal,
        );
        const job = jobs[0] ?? null;
        if (!job) {
          set_agent_jobs_by_asset((current) => {
            const next = new Map(current);
            next.delete(asset_id);
            return next;
          });
          return null;
        }
        return follow_agent_job(job, controller);
      }),
    [follow_agent_job, with_agent_controller],
  );

  const respond_to_transcript_correction = useCallback(
    (job: AgentJob, action: AgentQuestionAction, ai_model_id?: string | null) =>
      with_agent_controller(async (controller) => {
        if (!job.question) throw new Error("Agent 当前没有待回答的问题");
        const resumed_job = await respond_to_agent_job(
          job.job_id,
          job.question.question_id,
          action,
          ai_model_id ?? null,
          controller.signal,
        );
        return follow_agent_job(resumed_job, controller);
      }),
    [follow_agent_job, with_agent_controller],
  );

  const value = useMemo<TaskManager>(
    () => ({
      task_records,
      start_downloads,
      start_analysis,
      start_transcription,
      start_transcript_correction,
      restore_transcript_correction,
      respond_to_transcript_correction,
      agent_job_for_asset: (asset_id) =>
        agent_jobs_by_asset.get(asset_id) ?? null,
      is_operation_running: (asset_id, operation) =>
        active_operations.has(`${asset_id}:${operation}`),
    }),
    [
      active_operations,
      agent_jobs_by_asset,
      start_analysis,
      start_downloads,
      start_transcription,
      start_transcript_correction,
      restore_transcript_correction,
      respond_to_transcript_correction,
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
