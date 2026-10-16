import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RESOURCE_QUERY_KEYS } from "@/app/query_cache";
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
const UPDATED_MODEL: AiModelSummary = {
  ...MODEL,
  model_id: "model-2",
  name: "更新后的测试模型",
};
const COMMAND: AgentCommand = {
  name: "处理全部字幕",
  label: "处理全部字幕",
  description: "按自定义要求处理全部字幕",
  task_input: { intent: "transcript_edit", segment_indices: null },
  instruction_input_key: "correction_instruction",
  instruction_required: true,
};

function create_query_wrapper() {
  const query_client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    query_client,
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={query_client}>
        {children}
      </QueryClientProvider>
    ),
  };
}

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
    const { wrapper } = create_query_wrapper();
    const { result } = renderHook(
      () =>
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
      { wrapper },
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

  it("refreshes assistant compatibility when definitions are invalidated", async () => {
    const updated_definition: AgentDefinitionAvailability = {
      ...DEFINITION,
      compatible_model_ids: [UPDATED_MODEL.model_id],
    };
    api.list_agent_definitions
      .mockResolvedValueOnce([DEFINITION])
      .mockResolvedValueOnce([updated_definition]);
    api.list_agent_sessions.mockResolvedValue([]);
    const { query_client, wrapper } = create_query_wrapper();
    const { result, rerender } = renderHook(
      ({ models }) =>
        use_agent_panel({
          agent_id: "marker",
          asset_id: ASSET_ID,
          context: {},
          models,
          task_input: {},
          default_thinking_mode: "auto",
        }),
      { initialProps: { models: [MODEL] }, wrapper },
    );

    await waitFor(() => expect(result.current.model_id).toBe(MODEL.model_id));
    rerender({ models: [UPDATED_MODEL] });
    await act(() =>
      query_client.invalidateQueries({
        queryKey: RESOURCE_QUERY_KEYS.agent_definitions,
      }),
    );

    await waitFor(() =>
      expect(result.current.model_id).toBe(UPDATED_MODEL.model_id),
    );
    expect(api.list_agent_definitions).toHaveBeenCalledTimes(2);
  });

  it("refreshes the active conversation after manual context compression", async () => {
    const { wrapper } = create_query_wrapper();
    const { result } = renderHook(
      () =>
        use_agent_panel({
          agent_id: "marker",
          asset_id: ASSET_ID,
          context: {},
          models: [MODEL],
          task_input: {},
          default_thinking_mode: "auto",
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.state).toEqual(INITIAL_STATE));
    await act(() => result.current.compact_context());

    expect(api.compact_agent_session_context).toHaveBeenCalledWith(
      SESSION.session_id,
    );
    await waitFor(() => expect(result.current.state).toEqual(FINAL_STATE));
    expect(result.current.compacting_context).toBe(false);
  });

  it("keeps a new video's conversation and stream when an older cancel response arrives", async () => {
    const next_asset_id = "asset-0198f10e3f9871239c79000000000002";
    const next_session = {
      ...SESSION,
      asset_id: next_asset_id,
      session_id: "session-0198f10e3f9871239c79000000000002",
    };
    const next_run = {
      ...RUN,
      session_id: next_session.session_id,
      run_id: "run-0198f10e3f9871239c79000000000002",
    };
    const first_state = { ...INITIAL_STATE, runs: [RUN] };
    const next_state = {
      ...INITIAL_STATE,
      session: next_session,
      runs: [next_run],
    };
    let finish_cancel: (run: AgentRun) => void = () => undefined;
    const next_signal = { current: null as AbortSignal | null };
    api.cancel_agent_run.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish_cancel = resolve;
        }),
    );
    api.list_agent_sessions.mockImplementation(async ({ asset_id }) =>
      asset_id === ASSET_ID ? [SESSION] : [next_session],
    );
    api.get_agent_session
      .mockReset()
      .mockImplementation(async (session_id) =>
        session_id === SESSION.session_id ? first_state : next_state,
      );
    api.stream_unified_agent_run.mockImplementation(
      (run_id, _on_event, signal) => {
        if (run_id === next_run.run_id) next_signal.current = signal;
        return new Promise((_resolve, reject) =>
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("已取消", "AbortError")),
            { once: true },
          ),
        );
      },
    );
    const { wrapper } = create_query_wrapper();
    const hook = renderHook(
      ({ asset_id }) =>
        use_agent_panel({
          agent_id: "marker",
          asset_id,
          context: {},
          models: [MODEL],
          task_input: {},
          default_thinking_mode: "auto",
        }),
      { wrapper, initialProps: { asset_id: ASSET_ID } },
    );
    await waitFor(() =>
      expect(hook.result.current.active_run?.run_id).toBe(RUN.run_id),
    );
    let cancelling: Promise<void> = Promise.resolve();
    act(() => {
      cancelling = hook.result.current.cancel_run(RUN.run_id);
    });
    hook.rerender({ asset_id: next_asset_id });
    await waitFor(() =>
      expect(hook.result.current.active_run?.run_id).toBe(next_run.run_id),
    );
    await act(async () => {
      finish_cancel({ ...RUN, stage: "cancelled" });
      await cancelling;
    });

    expect(hook.result.current.state?.session.session_id).toBe(
      next_session.session_id,
    );
    expect(hook.result.current.active_run?.run_id).toBe(next_run.run_id);
    expect(next_signal.current?.aborted).toBe(false);
  });

  it("cancels the current run and refreshes its conversation", async () => {
    const cancelled_run: AgentRun = { ...RUN, stage: "cancelled" };
    const cancelled_state = { ...INITIAL_STATE, runs: [cancelled_run] };
    api.list_agent_sessions.mockResolvedValue([SESSION]);
    api.get_agent_session
      .mockReset()
      .mockResolvedValueOnce({ ...INITIAL_STATE, runs: [RUN] })
      .mockResolvedValueOnce(cancelled_state);
    api.cancel_agent_run.mockResolvedValue(cancelled_run);
    api.stream_unified_agent_run.mockImplementation(
      (_run_id, _on_event, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("已取消", "AbortError")),
            { once: true },
          ),
        ),
    );
    const { wrapper } = create_query_wrapper();
    const { result } = renderHook(
      () =>
        use_agent_panel({
          agent_id: "marker",
          asset_id: ASSET_ID,
          context: {},
          models: [MODEL],
          task_input: {},
          default_thinking_mode: "auto",
        }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.pending).toBe(true));
    await act(async () => result.current.cancel_run(RUN.run_id));
    expect(result.current.active_run).toEqual(cancelled_run);
    expect(result.current.state).toEqual(cancelled_state);
    expect(result.current.pending).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("keeps the last selected conversation when an earlier selection responds late", async () => {
    let finish_earlier: (state: AgentSessionState) => void = () => undefined;
    const earlier_state = {
      ...INITIAL_STATE,
      session: {
        ...SESSION,
        session_id: "session-0198f10e3f9871239c79000000000002",
      },
    };
    const latest_state = {
      ...INITIAL_STATE,
      session: {
        ...SESSION,
        session_id: "session-0198f10e3f9871239c79000000000003",
      },
    };
    api.list_agent_sessions.mockResolvedValue([SESSION]);
    api.get_agent_session
      .mockReset()
      .mockResolvedValueOnce(INITIAL_STATE)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish_earlier = resolve;
          }),
      )
      .mockResolvedValueOnce(latest_state);
    const { wrapper } = create_query_wrapper();
    const { result } = renderHook(
      () =>
        use_agent_panel({
          agent_id: "marker",
          asset_id: ASSET_ID,
          context: {},
          models: [MODEL],
          task_input: {},
          default_thinking_mode: "auto",
        }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.state).toEqual(INITIAL_STATE));
    let earlier_selection: Promise<void> = Promise.resolve();
    act(() => {
      earlier_selection = result.current.select_session(
        earlier_state.session.session_id,
      );
    });
    await act(async () =>
      result.current.select_session(latest_state.session.session_id),
    );
    await act(async () => {
      finish_earlier(earlier_state);
      await earlier_selection;
    });
    expect(result.current.state).toEqual(latest_state);
  });

  it("ignores an old cancelled conversation refresh after starting a new conversation", async () => {
    const first_state = { ...INITIAL_STATE, runs: [RUN] };
    let finish_refresh: (state: AgentSessionState) => void = () => undefined;
    api.get_agent_session
      .mockReset()
      .mockResolvedValueOnce(first_state)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish_refresh = resolve;
          }),
      );
    api.cancel_agent_run.mockResolvedValue({ ...RUN, stage: "cancelled" });
    api.stream_unified_agent_run.mockImplementation(
      (_run_id, _on_event, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("已取消", "AbortError")),
            { once: true },
          ),
        ),
    );
    const { wrapper } = create_query_wrapper();
    const { result } = renderHook(
      () =>
        use_agent_panel({
          agent_id: "marker",
          asset_id: ASSET_ID,
          context: {},
          models: [MODEL],
          task_input: {},
          default_thinking_mode: "auto",
        }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.pending).toBe(true));
    let cancelling: Promise<void> = Promise.resolve();
    act(() => {
      cancelling = result.current.cancel_run(RUN.run_id);
    });
    await waitFor(() => expect(api.get_agent_session).toHaveBeenCalledTimes(2));
    act(() => {
      result.current.start_new_conversation();
      result.current.set_draft("新的问题");
    });
    await act(async () => {
      finish_refresh(first_state);
      await cancelling;
    });

    expect(result.current.state).toBeNull();
    expect(result.current.active_run).toBeNull();
    expect(result.current.draft).toBe("新的问题");
  });

  it("ignores an old cancellation error after starting a new conversation", async () => {
    let fail_cancel: (error: Error) => void = () => undefined;
    api.get_agent_session
      .mockReset()
      .mockResolvedValue({ ...INITIAL_STATE, runs: [RUN] });
    api.cancel_agent_run.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          fail_cancel = reject;
        }),
    );
    api.stream_unified_agent_run.mockImplementation(
      (_run_id, _on_event, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("已取消", "AbortError")),
            { once: true },
          ),
        ),
    );
    const { wrapper } = create_query_wrapper();
    const { result } = renderHook(
      () =>
        use_agent_panel({
          agent_id: "marker",
          asset_id: ASSET_ID,
          context: {},
          models: [MODEL],
          task_input: {},
          default_thinking_mode: "auto",
        }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.pending).toBe(true));
    let cancelling: Promise<void> = Promise.resolve();
    act(() => {
      cancelling = result.current.cancel_run(RUN.run_id);
    });
    act(() => result.current.start_new_conversation());
    await act(async () => {
      fail_cancel(new Error("旧任务停止失败"));
      await cancelling;
    });
    expect(result.current.error).toBeNull();
  });
});
