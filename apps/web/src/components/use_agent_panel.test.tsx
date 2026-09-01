import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_MODEL_CAPABILITY_OVERRIDES,
  unknown_model_profile,
} from "@/shared/types";
import type {
  AgentArtifact,
  AgentDefinitionAvailability,
  AgentRun,
  AgentSession,
  AgentSessionState,
  AiModelSummary,
} from "@/shared/types";
import type { AgentCommand } from "./agent_commands";
import { use_agent_panel } from "./use_agent_panel";

const api = vi.hoisted(() => ({
  cancel_agent_run: vi.fn(),
  compact_agent_session_context: vi.fn(),
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
const SESSION: AgentSession = {
  session_id: "session-0198f10e3f9871239c79000000000001",
  agent_id: "marker",
  asset_id: ASSET_ID,
  title: "视频对话",
  context: {},
  created_at: "2026-08-31T10:00:00Z",
  updated_at: "2026-08-31T10:00:00Z",
};
const RUN: AgentRun = {
  run_id: "run-0198f10e3f9871239c79000000000001",
  session_id: SESSION.session_id,
  request_key: "request-0198f10e3f9871239c79000000000001",
  model_id: "model-1",
  stage: "running",
  error_code: null,
  error_message: null,
  latest_event_sequence: 0,
  created_at: "2026-08-31T10:01:00Z",
  started_at: "2026-08-31T10:01:00Z",
  updated_at: "2026-08-31T10:01:00Z",
  completed_at: null,
};
const FINAL_RUN: AgentRun = {
  ...RUN,
  stage: "complete",
  completed_at: "2026-08-31T10:02:00Z",
};
const ARTIFACT: AgentArtifact = {
  artifact_id: "artifact-0198f10e3f9871239c79000000000001",
  run_id: RUN.run_id,
  session_id: SESSION.session_id,
  agent_id: "marker",
  asset_id: ASSET_ID,
  result_type: "transcript_correction",
  payload: {},
  status: "approved",
  error_message: null,
  created_at: "2026-08-31T10:01:30Z",
  updated_at: "2026-08-31T10:01:31Z",
};
const INITIAL_STATE: AgentSessionState = {
  session: SESSION,
  runs: [],
  events: [],
  artifacts: [],
};
const FINAL_STATE: AgentSessionState = {
  session: SESSION,
  runs: [FINAL_RUN],
  events: [],
  artifacts: [ARTIFACT],
};
const DEFINITION: AgentDefinitionAvailability = {
  definition: {
    agent_id: "marker",
    title: "视频助手",
    description: "处理视频对话与字幕",
    mode: "chat",
    prompt: "",
    required_capabilities: [],
    minimum_context_tokens: 0,
    tools: [],
    required_tools: [],
    requires_approval: false,
    result_type: "marker_changes",
    input_mode: "message",
  },
  available: true,
  compatible_model_ids: ["model-1"],
  capability_model_ids: {},
  unavailable_reason: null,
};
const MODEL: AiModelSummary = {
  model_id: "model-1",
  name: "测试模型",
  litellm_model: "openai/test",
  input_modalities: ["text"],
  capabilities: { ...DEFAULT_MODEL_CAPABILITY_OVERRIDES },
  profile: unknown_model_profile("openai", "test"),
};
const COMMAND: AgentCommand = {
  name: "处理全部字幕",
  label: "处理全部字幕",
  description: "按自定义要求处理全部字幕",
  task_input: { intent: "transcript_edit", segment_indices: null },
  instruction_input_key: "correction_instruction",
  instruction_required: true,
};

describe("use_agent_panel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.list_agent_definitions.mockResolvedValue([DEFINITION]);
    api.list_agent_sessions.mockResolvedValue([SESSION]);
    api.get_agent_session
      .mockResolvedValueOnce(INITIAL_STATE)
      .mockResolvedValueOnce(FINAL_STATE);
    api.create_agent_run.mockResolvedValue(RUN);
    api.stream_unified_agent_run.mockResolvedValue(undefined);
    api.get_agent_run.mockResolvedValue(FINAL_RUN);
    api.compact_agent_session_context.mockResolvedValue({
      compressed: true,
      message: "已整理较早的对话内容",
    });
  });

  it("submits slash-command metadata through the native conversation", async () => {
    const on_artifact_change = vi.fn();
    const { result } = renderHook(() =>
      use_agent_panel({
        agent_id: "marker",
        asset_id: ASSET_ID,
        commands: [COMMAND],
        context: {},
        models: [MODEL],
        on_artifact_change,
        task_input: { source: "timeline" },
        default_thinking_mode: "auto",
      }),
    );

    await waitFor(() => expect(result.current.model_id).toBe("model-1"));
    act(() => {
      expect(result.current.submit("/处理全部字幕 翻译成中文")).toBe(true);
    });

    await waitFor(() => expect(api.create_agent_run).toHaveBeenCalledOnce());
    expect(api.create_agent_run).toHaveBeenCalledWith(
      SESSION.session_id,
      expect.objectContaining({
        content: "/处理全部字幕 翻译成中文",
        task_input: {
          source: "timeline",
          intent: "transcript_edit",
          segment_indices: null,
          correction_instruction: "翻译成中文",
        },
      }),
    );
    await waitFor(() =>
      expect(on_artifact_change).toHaveBeenCalledWith(ARTIFACT),
    );
  });

  it("refreshes the active conversation after manual context compression", async () => {
    const { result } = renderHook(() =>
      use_agent_panel({
        agent_id: "marker",
        asset_id: ASSET_ID,
        context: {},
        models: [MODEL],
        task_input: {},
        default_thinking_mode: "auto",
      }),
    );

    await waitFor(() => expect(result.current.state).toEqual(INITIAL_STATE));
    await act(() => result.current.compact_context());

    expect(api.compact_agent_session_context).toHaveBeenCalledWith(
      SESSION.session_id,
    );
    await waitFor(() => expect(result.current.state).toEqual(FINAL_STATE));
    expect(result.current.compacting_context).toBe(false);
  });
});
