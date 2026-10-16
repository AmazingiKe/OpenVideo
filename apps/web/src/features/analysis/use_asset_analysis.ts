import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { RESOURCE_QUERY_KEYS } from "@/app/query_cache";
import { update_transcript_segment, get_analysis } from "@/shared/api";
import { cancel_analysis, generate_chapters } from "@/shared/api/analysis";
import { TERMINAL_ANALYSIS_STAGES } from "@/shared/poll_transcription_job";
import type { AnalysisJob } from "@/shared/types";
import { error_message } from "@/shared/errors";
import {
  load_asset_analysis,
  type AssetAnalysis,
} from "@/shared/load_asset_analysis";

const EMPTY_ANALYSIS: AssetAnalysis = { segments: [], transcript: null };
const CHAPTER_POLL_INTERVAL_MILLISECONDS = 1_000;

type ChapterGeneration = {
  controller: AbortController;
  job: AnalysisJob | null;
  cancel_requested: boolean;
  cancel_request: Promise<void> | null;
};

export function use_asset_analysis(asset_id: string | null) {
  const query_client = useQueryClient();
  const generation_ref = useRef<ChapterGeneration | null>(null);
  const [is_cancelling_chapters, set_is_cancelling_chapters] = useState(false);
  const [chapter_generation_message, set_chapter_generation_message] = useState<
    string | null
  >(null);
  const [chapter_generation_error, set_chapter_generation_error] = useState<
    string | null
  >(null);
  useEffect(() => {
    set_chapter_generation_message(null);
    set_chapter_generation_error(null);
    set_is_cancelling_chapters(false);
    return () => {
      const generation = generation_ref.current;
      // 已请求停止时必须先取得任务号并发送取消，切换页面不能丢掉停止意图。
      if (generation && !generation.cancel_requested)
        generation.controller.abort();
      generation_ref.current = null;
    };
  }, [asset_id]);
  const query_key = RESOURCE_QUERY_KEYS.asset_analysis(asset_id);
  const analysis_query = useQuery({
    queryKey: query_key,
    queryFn: ({ signal }) => load_asset_analysis(asset_id!, signal),
    enabled: asset_id !== null,
  });
  const analysis = analysis_query.data ?? EMPTY_ANALYSIS;
  const refetch_analysis = analysis_query.refetch;

  const reload_analysis = useCallback(async () => {
    if (!asset_id) {
      return;
    }
    await refetch_analysis();
  }, [asset_id, refetch_analysis]);

  const save_transcript_segment = useCallback(
    async (segment_index: number, text: string) => {
      if (!asset_id) return;
      const transcript = await update_transcript_segment(
        asset_id,
        segment_index,
        text,
      );
      query_client.setQueryData<AssetAnalysis>(
        RESOURCE_QUERY_KEYS.asset_analysis(asset_id),
        (current) => ({
          ...(current ?? EMPTY_ANALYSIS),
          transcript,
        }),
      );
    },
    [asset_id, query_client],
  );

  async function request_chapter_cancellation(generation: ChapterGeneration) {
    if (!generation.job || generation.cancel_request)
      return generation.cancel_request;
    generation.cancel_request = (async () => {
      try {
        const job = await cancel_analysis(
          generation.job!.job_id,
          generation.controller.signal,
        );
        generation.controller.signal.throwIfAborted();
        generation.job = job;
      } catch (error) {
        generation.cancel_requested = false;
        if (
          generation_ref.current === generation &&
          !generation.controller.signal.aborted
        ) {
          set_is_cancelling_chapters(false);
          set_chapter_generation_error(error_message(error));
        }
      } finally {
        generation.cancel_request = null;
        if (generation_ref.current !== generation)
          generation.controller.abort();
      }
    })();
    return generation.cancel_request;
  }

  async function cancel_chapter_generation() {
    const generation = generation_ref.current;
    if (!generation || generation.cancel_requested) return;
    generation.cancel_requested = true;
    set_is_cancelling_chapters(true);
    set_chapter_generation_error(null);
    if (generation.job) await request_chapter_cancellation(generation);
  }

  async function regenerate_chapters() {
    if (!asset_id || generation_ref.current) return;
    const generation: ChapterGeneration = {
      controller: new AbortController(),
      job: null,
      cancel_requested: false,
      cancel_request: null,
    };
    const { signal } = generation.controller;
    generation_ref.current = generation;
    set_chapter_generation_error(null);
    set_is_cancelling_chapters(false);
    set_chapter_generation_message("正在生成章节…");
    try {
      generation.job = await generate_chapters(asset_id, signal);
      signal.throwIfAborted();
      if (generation.cancel_requested)
        await request_chapter_cancellation(generation);
      signal.throwIfAborted();
      while (!TERMINAL_ANALYSIS_STAGES.has(generation.job.stage)) {
        if (generation_ref.current === generation)
          set_chapter_generation_message(generation.job.message);
        await new Promise((resolve) =>
          setTimeout(resolve, CHAPTER_POLL_INTERVAL_MILLISECONDS),
        );
        signal.throwIfAborted();
        if (TERMINAL_ANALYSIS_STAGES.has(generation.job.stage)) break;
        const job = await get_analysis(generation.job.job_id, signal);
        signal.throwIfAborted();
        // 停止请求与旧轮询响应可能交错，确认后的状态不能被旧进度覆盖。
        const current_stage = generation.job.stage;
        if (
          !TERMINAL_ANALYSIS_STAGES.has(current_stage) &&
          (current_stage !== "cancelling" ||
            TERMINAL_ANALYSIS_STAGES.has(job.stage))
        ) {
          generation.job = job;
        }
      }
      if (
        generation.job.stage === "failed" ||
        generation.job.stage === "rejected"
      )
        throw new Error(generation.job.error_message ?? generation.job.message);
      if (generation.job.stage === "complete") {
        await query_client.invalidateQueries({
          queryKey: RESOURCE_QUERY_KEYS.asset_analysis(asset_id),
        });
      }
    } catch (error) {
      if (!signal.aborted && generation_ref.current === generation)
        set_chapter_generation_error(error_message(error));
    } finally {
      if (generation_ref.current === generation) {
        generation_ref.current = null;
        set_is_cancelling_chapters(false);
        set_chapter_generation_message(null);
      }
    }
  }

  return {
    ...analysis,
    regenerate_chapters,
    cancel_chapter_generation,
    is_cancelling_chapters,
    chapter_generation_message,
    chapter_generation_error,
    analysis_error: analysis_query.error
      ? error_message(analysis_query.error)
      : null,
    is_loading: analysis_query.isPending,
    is_refreshing: analysis_query.isFetching && !analysis_query.isPending,
    reload_analysis,
    save_transcript_segment,
  };
}
