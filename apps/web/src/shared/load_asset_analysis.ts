import { get_segments, get_transcript } from "@/shared/api";
import { is_not_found_error } from "@/shared/errors";
import type { MediaSegment, Transcript } from "@/shared/types";

export type AssetAnalysis = {
  segments: MediaSegment[];
  transcript: Transcript | null;
};

export async function load_asset_analysis(
  asset_id: string,
  signal?: AbortSignal,
): Promise<AssetAnalysis> {
  const [segments, transcript] = await Promise.all([
    load_optional_segments(asset_id, signal),
    load_optional_transcript(asset_id, signal),
  ]);
  return { segments, transcript };
}

async function load_optional_segments(
  asset_id: string,
  signal?: AbortSignal,
): Promise<MediaSegment[]> {
  try {
    return await get_segments(asset_id, signal);
  } catch (error) {
    if (is_not_found_error(error)) return [];
    throw error;
  }
}

async function load_optional_transcript(
  asset_id: string,
  signal?: AbortSignal,
): Promise<Transcript | null> {
  try {
    return await get_transcript(asset_id, signal);
  } catch (error) {
    if (is_not_found_error(error)) return null;
    throw error;
  }
}
