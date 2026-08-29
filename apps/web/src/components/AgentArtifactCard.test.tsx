import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AgentArtifact } from "@/shared/types";
import { AgentArtifactCard } from "./AgentPanelContent";

describe("AgentArtifactCard", () => {
  it("uses only-once approval as the primary action", () => {
    const on_resolve = vi.fn();
    render(<AgentArtifactCard artifact={artifact()} on_resolve={on_resolve} />);

    fireEvent.click(screen.getByRole("button", { name: "仅本次接受" }));

    expect(on_resolve).toHaveBeenCalledWith("approve", "once");
  });

  it.each([
    ["本次对话", "session"],
    ["始终允许", "always"],
  ] as const)("offers the %s scoped grant", async (label, scope) => {
    const on_resolve = vi.fn();
    render(<AgentArtifactCard artifact={artifact()} on_resolve={on_resolve} />);

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "选择更长授权范围" }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: new RegExp(label) }),
    );

    expect(on_resolve).toHaveBeenCalledWith("approve", scope);
  });

  it("explains a partial merge against the latest version", () => {
    const on_resolve = vi.fn();
    const value = artifact();
    value.status = "approved";
    value.payload.application_result = {
      change_version_id: "agent-version-01890f4c7a2b7cc298c4dc0c0c07398f",
      rebased: true,
      applied_change_count: 2,
      skipped_conflicts: ["字幕修改 1 的原片段已变化"],
      base_version: "before",
      committed_version: "after",
    };

    render(<AgentArtifactCard artifact={value} on_resolve={on_resolve} />);

    expect(screen.getByText("已合并可安全应用的部分")).toBeInTheDocument();
    expect(
      screen.getByText(/已应用 2 项，跳过 1 项冲突/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "撤销整批变更" }));
    expect(on_resolve).toHaveBeenCalledWith("undo");
  });
});

function artifact(): AgentArtifact {
  return {
    artifact_id: "artifact-01890f4c7a2b7cc298c4dc0c0c07398f",
    run_id: "run-01890f4c7a2b7cc298c4dc0c0c07398f",
    session_id: "session-01890f4c7a2b7cc298c4dc0c0c07398f",
    agent_id: "marker",
    asset_id: "01890f4c-7a2b-7cc2-98c4-dc0c0c07398f",
    result_type: "marker_changes",
    payload: { changes: [] },
    status: "pending",
    error_message: null,
    created_at: "2026-08-29T00:00:00Z",
    updated_at: "2026-08-29T00:00:00Z",
  };
}
