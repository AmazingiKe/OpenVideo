import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  AgentAnswerEvidence,
  AgentIndexStatusDisclosure,
  AgentRunMetricsDisclosure,
} from "./AgentAnswerDetails";
import type { AgentEvidenceBundle } from "@/shared/types";

const EVIDENCE_BUNDLE: AgentEvidenceBundle = {
  items: [
    {
      evidence_id: "evidence-1",
      citation_key: "E1",
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

    fireEvent.click(screen.getByRole("button", { name: "用时 2.5 秒" }));
    expect(await screen.findByText("证据检索")).toBeVisible();
    expect(screen.queryByText("视觉验证")).not.toBeInTheDocument();
  });

  it("shows real index units and leaves unknown-duration stages indeterminate", () => {
    render(
      <AgentIndexStatusDisclosure
        status={{
          index_task_id: "index-task-019c012345677abc8123456789abcdef",
          asset_id: "019c0123-4567-7abc-8123-456789abcdef",
          state: "partial",
          stage: "projecting",
          stage_label: "正在计算语义投影，耗时暂不可估计",
          processed_documents: 0,
          total_documents: 0,
          indexed_documents: 80,
          covered_seconds: 300,
          duration_seconds: 600,
          available_capabilities: ["字幕检索", "关键词检索"],
          error_message: null,
          updated_at: "2026-08-29T10:00:00Z",
        }}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: /正在计算语义投影，耗时暂不可估计/,
      }),
    );
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(
      screen.getByText("已收录 80 条证据，时间覆盖 05:00 / 10:00"),
    ).toBeVisible();
  });

  it("does not seek another video and provides a return action", () => {
    const on_seek = vi.fn();
    const on_return = vi.fn();
    render(
      <AgentAnswerEvidence
        confidence="medium"
        answer_status="final"
        evidence_bundle={EVIDENCE_BUNDLE}
        current_asset_id="asset-current"
        on_seek={on_seek}
        return_position_seconds={8}
        on_return={on_return}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /已参考 1 项内容/ }));
    expect(screen.getByText("其他视频")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "跳转到证据 00:15" }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "返回原播放位置 00:08" }),
    );
    expect(on_return).toHaveBeenCalledOnce();
    expect(on_seek).not.toHaveBeenCalled();
  });

  it("explains a failed citation validation", () => {
    render(
      <AgentAnswerEvidence
        confidence="low"
        answer_status="provisional"
        evidence_bundle={EVIDENCE_BUNDLE}
        citation_validation={{
          valid: false,
          invalid_citations: ["E99"],
          missing_citations: false,
        }}
      />,
    );

    expect(screen.getByText("引用校验未通过")).toBeVisible();
    expect(screen.getByText("回答包含无效引用：E99。")).toBeVisible();
  });
});
