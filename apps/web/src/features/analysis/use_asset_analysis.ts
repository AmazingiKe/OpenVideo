import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { RESOURCE_QUERY_KEYS } from "@/app/query_cache";
import { update_transcript_segment, get_analysis } from "@/shared/api";
import { generate_chapters } from "@/shared/api/analysis";
import { error_message } from "@/shared/errors";
import {
  load_asset_analysis,
  type AssetAnalysis,
} from "@/shared/load_asset_analysis";

const EMPTY_ANALYSIS: AssetAnalysis = { segments: [], transcript: null };
const CHAPTER_POLL_INTERVAL_MILLISECONDS = 1_000;

export function use_asset_analysis(asset_id: string | null) {
  const query_client = useQueryClient();
  const generation_controller_ref = useRef<AbortController | null>(null);
  const [chapter_generation_message, set_chapter_generation_message] = useState<
    string | null
  >(null);
  const [chapter_generation_error, set_chapter_generation_error] = useState<
    string | null
  >(null);
  useEffect(() => {
    set_chapter_generation_message(null);
    set_chapter_generation_error(null);
    return () => {
      generation_controller_ref.current?.abort();
      generation_controller_ref.current = null;
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

  async function regenerate_chapters() {
    if (!asset_id || generation_controller_ref.current) return;
    const controller = new AbortController();
    generation_controller_ref.current = controller;
    set_chapter_generation_error(null);
    set_chapter_generation_message("正在生成章节…");
    try {
      let job = await generate_chapters(asset_id, controller.signal);
      controller.signal.throwIfAborted();
      while (job.stage !== "complete") {
        if (job.stage === "failed" || job.stage === "rejected")
          throw new Error(job.error_message ?? job.message);
        set_chapter_generation_message(job.message);
        await new Promise((resolve) =>
          setTimeout(resolve, CHAPTER_POLL_INTERVAL_MILLISECONDS),
        );
        controller.signal.throwIfAborted();
        job = await get_analysis(job.job_id, controller.signal);
        controller.signal.throwIfAborted();
      }
      await query_client.invalidateQueries({
        queryKey: RESOURCE_QUERY_KEYS.asset_analysis(asset_id),
      });
    } catch (error) {
      if (!controller.signal.aborted)
        set_chapter_generation_error(error_message(error));
    } finally {
      if (generation_controller_ref.current === controller) {
        generation_controller_ref.current = null;
        set_chapter_generation_message(null);
      }
    }
  }

  return {
    ...analysis,
    regenerate_chapters,
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
