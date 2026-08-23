import { useCallback, useEffect, useRef, useState } from "react";

import { correct_transcript, update_transcript_segment } from "@/shared/api";
import { error_message, is_abort_error } from "@/shared/errors";
import {
  load_asset_analysis,
  type AssetAnalysis,
} from "@/shared/load_asset_analysis";

const EMPTY_ANALYSIS: AssetAnalysis = { segments: [], transcript: null };

export function use_asset_analysis(asset_id: string | null) {
  const [analysis, set_analysis] = useState<AssetAnalysis>(EMPTY_ANALYSIS);
  const [analysis_error, set_analysis_error] = useState<string | null>(null);
  const controller_ref = useRef<AbortController | null>(null);

  const reload_analysis = useCallback(async () => {
    controller_ref.current?.abort();
    if (!asset_id) {
      set_analysis(EMPTY_ANALYSIS);
      set_analysis_error(null);
      return;
    }
    const controller = new AbortController();
    controller_ref.current = controller;
    try {
      const loaded_analysis = await load_asset_analysis(
        asset_id,
        controller.signal,
      );
      set_analysis(loaded_analysis);
      set_analysis_error(null);
    } catch (error) {
      if (!is_abort_error(error)) set_analysis_error(error_message(error));
    } finally {
      if (controller_ref.current === controller) {
        controller_ref.current = null;
      }
    }
  }, [asset_id]);

  useEffect(() => {
    void reload_analysis();
    return () => controller_ref.current?.abort();
  }, [reload_analysis]);

  const save_transcript_segment = useCallback(
    async (segment_index: number, text: string) => {
      if (!asset_id) return;
      try {
        const transcript = await update_transcript_segment(
          asset_id,
          segment_index,
          text,
        );
        set_analysis((current) => ({ ...current, transcript }));
        set_analysis_error(null);
      } catch (error) {
        if (!is_abort_error(error)) set_analysis_error(error_message(error));
        throw error;
      }
    },
    [asset_id],
  );

  const correct_transcript_segments = useCallback(
    async (segment_indices: number[] | null) => {
      if (!asset_id) return;
      try {
        const transcript = await correct_transcript(asset_id, segment_indices);
        set_analysis((current) => ({ ...current, transcript }));
        set_analysis_error(null);
      } catch (error) {
        if (!is_abort_error(error)) set_analysis_error(error_message(error));
        throw error;
      }
    },
    [asset_id],
  );

  return {
    ...analysis,
    analysis_error,
    reload_analysis,
    save_transcript_segment,
    correct_transcript_segments,
  };
}
