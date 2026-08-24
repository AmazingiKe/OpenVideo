import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MarkerAgentPanel } from "./MarkerAgentPanel";
import {
  create_marker_agent_session,
  get_marker_agent_session,
  list_marker_agent_sessions,
  resolve_marker_proposal,
} from "@/shared/api";
import type {
  AiModelSummary,
  MarkerAgentSessionState,
  MarkerProposal,
} from "@/shared/types";

const ASSET_ID = "asset-01890f4c7a2b7cc298c4dc0c0c07398f";
const SESSION = {
  session_id: "session-01890f4c7a2b7cc298c4dc0c0c07398f",
  agent_type: "marker",
  title: "结论标记",
  created_at: "2026-08-24T08:00:00Z",
  updated_at: "2026-08-24T08:00:00Z",
};
const PROPOSAL: MarkerProposal = {
  proposal_id: "proposal-01890f4c7a2b7cc298c4dc0c0c07398f",
  session_id: SESSION.session_id,
  asset_id: ASSET_ID,
  status: "pending",
  created_at: "2026-08-24T08:00:00Z",
  changes: [
    {
      operation: "create",
      before: [],
      after: {
        marker_id: "marker-01890f4c7a2b7cc298c4dc0c0c07398f",
        asset_id: ASSET_ID,
        start_seconds: 12,
        end_seconds: 20,
        title: "关键结论",
        tags: ["重点"],
      },
      reason: "转录中出现明确结论。",
      evidence: ["00:12–00:20"],
    },
  ],
};
const STATE: MarkerAgentSessionState = {
  session: SESSION,
  asset_id: ASSET_ID,
  events: [],
  proposals: [PROPOSAL],
};
const MODELS: AiModelSummary[] = [
  {
    model_id: "model-01890f4c7a2b7cc298c4dc0c0c07398f",
    name: "测试模型",
    litellm_model: "openai/test",
    tool_calling_mode: "auto",
    input_modalities: ["text", "image"],
  },
];

vi.mock("@/shared/api", () => ({
  cancel_agent_run: vi.fn(),
  create_marker_agent_message: vi.fn(),
  create_marker_agent_session: vi.fn(),
  delete_marker_agent_session: vi.fn(),
  get_marker_agent_session: vi.fn(),
  list_marker_agent_sessions: vi.fn(),
  resolve_marker_proposal: vi.fn(),
  stream_agent_run: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(list_marker_agent_sessions).mockResolvedValue([
    { session: SESSION, asset_id: ASSET_ID },
  ]);
  vi.mocked(get_marker_agent_session).mockResolvedValue(STATE);
  vi.mocked(create_marker_agent_session).mockResolvedValue(STATE);
  vi.mocked(resolve_marker_proposal).mockResolvedValue({
    ...PROPOSAL,
    status: "accepted",
  });
});

describe("MarkerAgentPanel", () => {
  it("shows the current-video empty state", () => {
    render(
      <MarkerAgentPanel
        asset_id={null}
        models={MODELS}
        on_seek={vi.fn()}
        on_candidate_markers_change={vi.fn()}
        on_markers_changed={vi.fn()}
      />,
    );

    expect(screen.getByText("请先选择视频")).toBeInTheDocument();
  });

  it("restores pending proposals and resolves the whole batch", async () => {
    const on_candidate_markers_change = vi.fn();
    const on_markers_changed = vi.fn().mockResolvedValue(undefined);
    render(
      <MarkerAgentPanel
        asset_id={ASSET_ID}
        models={MODELS}
        on_seek={vi.fn()}
        on_candidate_markers_change={on_candidate_markers_change}
        on_markers_changed={on_markers_changed}
      />,
    );

    expect(await screen.findByText("关键结论")).toBeInTheDocument();
    await waitFor(() =>
      expect(on_candidate_markers_change).toHaveBeenLastCalledWith([
        PROPOSAL.changes[0].after,
      ]),
    );
    fireEvent.click(screen.getByRole("button", { name: "整批接受" }));

    await waitFor(() => {
      expect(resolve_marker_proposal).toHaveBeenCalledWith(
        PROPOSAL.proposal_id,
        "accept",
      );
      expect(on_markers_changed).toHaveBeenCalledOnce();
      expect(on_candidate_markers_change).toHaveBeenLastCalledWith([]);
    });
  });
});
