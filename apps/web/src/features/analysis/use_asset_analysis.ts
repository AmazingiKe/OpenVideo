import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { RESOURCE_QUERY_KEYS } from "@/app/query_cache";
import { update_transcript_segment } from "@/shared/api";
import { error_message } from "@/shared/errors";
import {
  load_asset_analysis,
  type AssetAnalysis,
} from "@/shared/load_asset_analysis";

const EMPTY_ANALYSIS: AssetAnalysis = { segments: [], transcript: null };

export function use_asset_analysis(asset_id: string | null) {
  const query_client = useQueryClient();
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

  return {
    ...analysis,
    analysis_error: analysis_query.error
      ? error_message(analysis_query.error)
      : null,
    is_loading: analysis_query.isPending,
    is_refreshing: analysis_query.isFetching && !analysis_query.isPending,
    reload_analysis,
    save_transcript_segment,
  };
}
