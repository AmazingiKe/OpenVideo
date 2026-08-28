import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  AgentAnswerEvidence,
  AgentRunMetricsDisclosure,
} from "./AgentAnswerDetails";
import type { AgentEvidenceBundle } from "@/shared/types";

const EVIDENCE_BUNDLE: AgentEvidenceBundle = {
  items: [
    {
      evidence_id: "evidence-1",
      citation_key: "[1]",
      source_type: "transcript",
      source_version: "v1",
      asset_id: "asset-1",
      start_seconds: 15,
      end_seconds: 21,
      excerpt: "这一段明确给出了结论。",
      relation: "supports",
      retrieval_relation: "direct",
    },
  ],
  conflicts: [],
  coverage: { temporal: 0.8, source_types: ["transcript"] },
};

describe("AgentAnswerDetails", () => {
  it("keeps high-confidence evidence collapsed", () => {
    render(
      <AgentAnswerEvidence
        confidence="high"
        answer_status="final"
        evidence_bundle={EVIDENCE_BUNDLE}
      />,
    );

    expect(
      screen.getByRole("button", { name: /已参考 1 项内容/ }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("expands low-confidence evidence and seeks the full range", () => {
    const on_seek = vi.fn();
    render(
      <AgentAnswerEvidence
        confidence="low"
        answer_status="provisional"
        evidence_bundle={{
          ...EVIDENCE_BUNDLE,
          conflicts: [
            { evidence_ids: ["evidence-1"], reason: "相邻画面存在冲突" },
          ],
        }}
        on_seek={on_seek}
      />,
    );

    expect(screen.getByText("暂定结论")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "跳转到证据 00:15" }));
    expect(on_seek).toHaveBeenCalledWith(
      15,
      21,
      expect.objectContaining({ evidence_id: "evidence-1" }),
    );
  });

  it("shows only metrics that were actually provided", async () => {
    render(
      <AgentRunMetricsDisclosure
        metrics={{ total_ms: 2_450, retrieval_ms: 600 }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "思考 2.5 秒" }));
    expect(await screen.findByText("证据检索")).toBeVisible();
    expect(screen.queryByText("视觉验证")).not.toBeInTheDocument();
  });
});
