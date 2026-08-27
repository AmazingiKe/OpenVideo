import { DEFAULT_ANALYSIS_STRATEGY } from "../analysis";
import type {
  AnalysisJob,
  AnalysisMode,
  AnalysisStrategy,
  AnalysisStrategyPresetDescriptor,
  MediaSegment,
  Transcript,
  TranscriptionOptions,
} from "../types";
import { request_json } from "./client";

export function analyze_asset(
  asset_id: string,
  mode: AnalysisMode,
  marker_ids: string[],
  ai_model_id: string | null,
  strategy: AnalysisStrategy = DEFAULT_ANALYSIS_STRATEGY,
  signal?: AbortSignal,
): Promise<AnalysisJob> {
  return request_json(
    `/api/media/assets/${encodeURIComponent(asset_id)}/analyze`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode,
        marker_ids,
        ai_model_id,
        strategy,
        force: true,
      }),
      signal,
    },
  );
}

export function list_analysis_strategies(
  signal?: AbortSignal,
): Promise<AnalysisStrategyPresetDescriptor[]> {
  return request_json("/api/analysis-strategies", { signal });
}

export function transcribe_asset(
  asset_id: string,
  options: TranscriptionOptions,
  signal?: AbortSignal,
): Promise<AnalysisJob> {
  return request_json(
    `/api/media/assets/${encodeURIComponent(asset_id)}/transcribe`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force: true, ...options }),
      signal,
    },
  );
}

export function get_analysis(
  job_id: string,
  signal?: AbortSignal,
): Promise<AnalysisJob> {
  return request_json(`/api/analysis/${encodeURIComponent(job_id)}`, {
    signal,
  });
}

export function resolve_analysis_proposal(
  job_id: string,
  action: "approve" | "reject",
  signal?: AbortSignal,
): Promise<AnalysisJob> {
  return request_json(`/api/analysis/${encodeURIComponent(job_id)}/${action}`, {
    method: "POST",
    signal,
  });
}

export function get_transcript(
  asset_id: string,
  signal?: AbortSignal,
): Promise<Transcript> {
  return request_json(
    `/api/media/assets/${encodeURIComponent(asset_id)}/transcript`,
    { signal },
  );
}

export function update_transcript_segment(
  asset_id: string,
  segment_index: number,
  text: string,
  signal?: AbortSignal,
): Promise<Transcript> {
  return request_json(
    `/api/media/assets/${encodeURIComponent(asset_id)}/transcript/segments/${segment_index}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal,
    },
  );
}

export function get_segments(
  asset_id: string,
  signal?: AbortSignal,
): Promise<MediaSegment[]> {
  return request_json(
    `/api/media/assets/${encodeURIComponent(asset_id)}/segments`,
    { signal },
  );
}
