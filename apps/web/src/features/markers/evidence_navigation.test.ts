import { describe, expect, it } from "vitest";

import type { AgentEvidenceReference } from "@/shared/types";
import { evidence_range_for_asset } from "./evidence_navigation";

const ASSET_ID = "asset-0198d12345677890abcdef1234567890";
const EVIDENCE: AgentEvidenceReference = {
  evidence_id: "evidence-0198d12345677890abcdef1234567890",
  citation_key: "E1",
  source_type: "transcript",
  source_version: "version-1",
  asset_id: ASSET_ID,
  start_seconds: 12,
  end_seconds: 18,
  excerpt: "证据",
  relation: "supports",
};

describe("evidence range navigation", () => {
  it("keeps only evidence that belongs to the current player", () => {
    expect(evidence_range_for_asset(ASSET_ID, EVIDENCE)).toEqual({
      evidence_id: EVIDENCE.evidence_id,
      start_seconds: 12,
      end_seconds: 18,
    });
    expect(evidence_range_for_asset("asset-other", EVIDENCE)).toBeNull();
    expect(evidence_range_for_asset(ASSET_ID)).toBeNull();
  });
});
