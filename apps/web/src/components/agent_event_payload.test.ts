import { describe, expect, it } from "vitest";

import {
  parse_citation_validation,
  parse_evidence_bundle,
  parse_run_metrics,
} from "./agent_event_payload";

describe("agent event payload", () => {
  it("parses the frozen evidence contract", () => {
    expect(
      parse_evidence_bundle({
        items: [
          {
            evidence_id: "evidence-1",
            citation_key: "E1",
            source_type: "transcript",
            source_version: "v2",
            asset_id: "asset-1",
            start_seconds: 12,
            end_seconds: 18,
            excerpt: "证据文本",
            relation: "supports",
            retrieval_relation: "direct",
          },
        ],
        conflicts: [
          { evidence_ids: ["evidence-1", "evidence-2"], reason: "来源不一致" },
        ],
        coverage: { temporal: 0.75, source_types: ["transcript", "frame"] },
      }),
    ).toEqual({
      items: [
        {
          evidence_id: "evidence-1",
          citation_key: "E1",
          source_type: "transcript",
          source_version: "v2",
          asset_id: "asset-1",
          start_seconds: 12,
          end_seconds: 18,
          excerpt: "证据文本",
          relation: "supports",
          retrieval_relation: "direct",
        },
      ],
      conflicts: [
        { evidence_ids: ["evidence-1", "evidence-2"], reason: "来源不一致" },
      ],
      coverage: { temporal: 0.75, source_types: ["transcript", "frame"] },
    });
  });

  it("does not accept an old nullable evidence end time", () => {
    const bundle = parse_evidence_bundle({
      items: [
        {
          evidence_id: "evidence-1",
          citation_key: "E1",
          source_type: "transcript",
          source_version: "v2",
          asset_id: "asset-1",
          start_seconds: 12,
          end_seconds: null,
          excerpt: "证据文本",
          relation: "supports",
        },
      ],
      conflicts: [],
      coverage: { temporal: 0.2, source_types: ["transcript"] },
    });

    expect(bundle?.items).toEqual([]);
  });

  it("keeps only real metrics fields", () => {
    expect(
      parse_run_metrics({
        total_ms: 3_200,
        retrieval_ms: 800,
        retry_count: 1,
        selected_model_id: "model-1",
        unknown: 42,
      }),
    ).toMatchObject({
      total_ms: 3_200,
      retrieval_ms: 800,
      retry_count: 1,
      selected_model_id: "model-1",
    });
  });

  it("parses deterministic citation validation", () => {
    expect(
      parse_citation_validation({
        valid: false,
        invalid_citations: ["E99"],
        missing_citations: false,
      }),
    ).toEqual({
      valid: false,
      invalid_citations: ["E99"],
      missing_citations: false,
    });
  });
});
