import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MarkerAgentPanel } from "./MarkerAgentPanel";

const { agent_panel_spy } = vi.hoisted(() => ({
  agent_panel_spy: vi.fn(),
}));

vi.mock("@/components/AgentPanel", () => ({
  AgentPanel: (props: unknown) => {
    agent_panel_spy(props);
    return <div>标记 Agent</div>;
  },
}));

describe("MarkerAgentPanel", () => {
  it("defaults to content questions and isolates the marker proposal mode", () => {
    render(
      <MarkerAgentPanel
        asset_id="01890f4c-7a2b-7cc2-98c4-dc0c0c07398f"
        models={[]}
        on_seek={vi.fn()}
        on_candidate_markers_change={vi.fn()}
        on_markers_changed={vi.fn()}
      />,
    );

    expect(agent_panel_spy).toHaveBeenCalledWith(
      expect.objectContaining({
        placeholder: "例如：这个课程主要讲什么？",
        run_options: [
          expect.objectContaining({
            value: "chat",
            label: "内容问答",
            task_input: { intent: "chat" },
          }),
          expect.objectContaining({
            value: "edit",
            label: "生成标记建议",
            task_input: { intent: "edit" },
          }),
        ],
      }),
    );
  });
});
