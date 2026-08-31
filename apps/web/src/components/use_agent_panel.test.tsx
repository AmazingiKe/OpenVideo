import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentSession } from "@/shared/types";
import { use_agent_panel } from "./use_agent_panel";

const api = vi.hoisted(() => ({
  cancel_agent_run: vi.fn(),
  create_agent_run: vi.fn(),
  create_agent_session: vi.fn(),
  get_agent_run: vi.fn(),
  get_agent_session: vi.fn(),
  list_agent_definitions: vi.fn(),
  list_agent_sessions: vi.fn(),
  resolve_agent_artifact: vi.fn(),
  stream_unified_agent_run: vi.fn(),
}));

vi.mock("@/shared/api", () => api);

const ASSET_ID = "asset-0198f10e3f9871239c79000000000001";
const HISTORY_AGENT_IDS = ["marker", "transcript_correction"] as const;
const MARKER_SESSION: AgentSession = {
  session_id: "session-0198f10e3f9871239c79000000000001",
  agent_id: "marker",
  asset_id: ASSET_ID,
  title: "视频标记",
  context: {},
  created_at: "2026-08-31T10:00:00Z",
  updated_at: "2026-08-31T10:00:00Z",
};
const TRANSCRIPT_SESSION: AgentSession = {
  session_id: "session-0198f10e3f9871239c79000000000002",
  agent_id: "transcript_correction",
  asset_id: ASSET_ID,
  title: "字幕处理",
  context: {},
  created_at: "2026-08-31T11:00:00Z",
  updated_at: "2026-08-31T11:00:00Z",
};

describe("use_agent_panel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.list_agent_definitions.mockResolvedValue([]);
    api.list_agent_sessions.mockResolvedValue([
      TRANSCRIPT_SESSION,
      MARKER_SESSION,
    ]);
    api.get_agent_session.mockResolvedValue({
      session: TRANSCRIPT_SESSION,
      runs: [],
      events: [],
      artifacts: [],
    });
  });

  it("restores the latest conversation across related agents", async () => {
    const on_session_change = vi.fn();
    const { result, rerender } = renderHook(
      ({ agent_id, requested_session_id }) =>
        use_agent_panel({
          agent_id,
          asset_id: ASSET_ID,
          context: {},
          history_agent_ids: HISTORY_AGENT_IDS,
          models: [],
          on_session_change,
          requested_session_id,
          task_input: {},
          default_thinking_mode: "auto",
        }),
      {
        initialProps: {
          agent_id: "marker",
          requested_session_id: undefined as string | null | undefined,
        },
      },
    );

    await waitFor(() =>
      expect(on_session_change).toHaveBeenCalledWith(
        "transcript_correction",
        TRANSCRIPT_SESSION.session_id,
      ),
    );
    expect(api.get_agent_session).not.toHaveBeenCalled();

    rerender({
      agent_id: "transcript_correction",
      requested_session_id: TRANSCRIPT_SESSION.session_id,
    });

    await waitFor(() =>
      expect(result.current.state?.session.session_id).toBe(
        TRANSCRIPT_SESSION.session_id,
      ),
    );
    expect(result.current.sessions).toEqual([
      TRANSCRIPT_SESSION,
      MARKER_SESSION,
    ]);
    expect(api.list_agent_sessions).toHaveBeenCalledWith(
      { asset_id: ASSET_ID },
      expect.any(AbortSignal),
    );
  });

  it("keeps history visible while starting a new task conversation", async () => {
    const { result } = renderHook(() =>
      use_agent_panel({
        agent_id: "transcript_correction",
        asset_id: ASSET_ID,
        context: {},
        history_agent_ids: HISTORY_AGENT_IDS,
        models: [],
        requested_session_id: null,
        task_input: {},
        default_thinking_mode: "auto",
      }),
    );

    await waitFor(() => expect(result.current.restoring).toBe(false));
    expect(result.current.sessions).toEqual([
      TRANSCRIPT_SESSION,
      MARKER_SESSION,
    ]);
    expect(result.current.state).toBeNull();
    expect(api.get_agent_session).not.toHaveBeenCalled();
  });
});
