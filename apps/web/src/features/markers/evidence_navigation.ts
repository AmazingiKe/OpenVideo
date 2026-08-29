import type {
  AgentEvidenceRange,
  AgentEvidenceReference,
} from "@/shared/types";

export function evidence_range_for_asset(
  asset_id: string | null,
  evidence?: AgentEvidenceReference,
  requested_end_seconds?: number | null,
): AgentEvidenceRange | null {
  if (!evidence || evidence.asset_id !== asset_id) return null;
  return {
    evidence_id: evidence.evidence_id,
    start_seconds: evidence.start_seconds,
    end_seconds: Math.max(
      evidence.start_seconds,
      requested_end_seconds ?? evidence.end_seconds,
    ),
  };
}
