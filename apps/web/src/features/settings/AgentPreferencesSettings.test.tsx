import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AgentPreferences } from "@/shared/types";
import { AgentPreferencesSettings } from "./AgentPreferencesSettings";

describe("AgentPreferencesSettings", () => {
  it("explains foreground priority without another scheduling choice", () => {
    render(
      <AgentPreferencesSettings
        value={preferences()}
        models={[]}
        on_change={vi.fn()}
      />,
    );

    expect(
      screen.getByText(
        "同时运行 1–32 个任务；前台对话优先，后台任务使用剩余容量。",
      ),
    ).toBeInTheDocument();
  });

  it("lets the user revoke an always grant", () => {
    const on_change = vi.fn();
    render(
      <AgentPreferencesSettings
        value={preferences()}
        models={[]}
        on_change={on_change}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "移除总结修改始终授权" }),
    );

    expect(on_change).toHaveBeenCalledWith(
      expect.objectContaining({ always_allowed_grants: [] }),
    );
  });
});

function preferences(): AgentPreferences {
  return {
    permission_mode: "smart_approval",
    fast_model_id: null,
    complex_model_id: null,
    vision_model_id: null,
    default_thinking_mode: "auto",
    max_concurrent_runs: 4,
    always_allowed_grants: [
      {
        grant_id: "grant-01890f4c7a2b7cc298c4dc0c0c07398f",
        capability: "artifact.apply.summary_edit",
        resource_scope: "current_item",
        resource_id: "01890f4c-7a2b-7cc2-98c4-dc0c0c07398f",
        scope: "always",
        request_id: null,
        session_id: null,
      },
    ],
  };
}
