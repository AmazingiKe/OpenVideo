import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MarkerAgentPanel } from "./MarkerAgentPanel";

const { agent_panel_spy } = vi.hoisted(() => ({
  agent_panel_spy: vi.fn(),
}));

vi.mock("@/components/AgentPanel", () => ({
  AgentPanel: (props: unknown) => {
    agent_panel_spy(props);
    return <div>助手</div>;
  },
}));

describe("MarkerAgentPanel", () => {
  it("lets the assistant route questions and marker changes from one input", () => {
    render(
      <MarkerAgentPanel
        asset_id="01890f4c-7a2b-7cc2-98c4-dc0c0c07398f"
        models={[]}
        current_time={0}
        on_seek={vi.fn()}
        on_candidate_markers_change={vi.fn()}
        on_markers_changed={vi.fn()}
      />,
    );

    expect(agent_panel_spy).toHaveBeenCalledWith(
      expect.objectContaining({
        placeholder: "询问视频内容，或直接描述希望创建的标记…",
      }),
    );
    expect(agent_panel_spy.mock.calls[0][0]).not.toHaveProperty("run_options");
  });
});
