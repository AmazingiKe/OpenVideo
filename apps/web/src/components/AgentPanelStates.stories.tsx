import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, waitFor, within } from "storybook/test";

import { AgentPanel } from "./AgentPanel";
import type {
  AgentDefinitionAvailability,
  AgentEvent,
  AgentEvidenceBundle,
  AgentIndexStatus,
  AgentRun,
  AgentSession,
  AgentSessionState,
  AiModelSummary,
} from "@/shared/types";
import { unknown_model_profile } from "@/shared/types";

const ASSET_ID = "019c0123-4567-7abc-8123-456789abcdef";
const MODEL_ID = "model-019c012345677abc8123456789abcdef";
const SECONDARY_MODEL_ID = "model-019c012345677abc8123456789abcdee";
const SESSION_ID = "session-019c012345677abc8123456789abcdef";
const RUN_ID = "run-019c012345677abc8123456789abcdef";
const CREATED_AT = "2026-08-29T10:00:00Z";

const INDEX_STATUS: AgentIndexStatus = {
  index_task_id: "index-task-019c012345677abc8123456789abcdef",
  asset_id: ASSET_ID,
  state: "partial",
  stage: "tokenizing",
  stage_label: "正在解析检索文本",
  processed_documents: 246,
  total_documents: 720,
  indexed_documents: 720,
  covered_seconds: 2_460,
  duration_seconds: 7_200,
  available_capabilities: ["字幕检索", "关键词检索"],
  error_message: null,
  updated_at: CREATED_AT,
};

const MODEL: AiModelSummary = {
  model_id: MODEL_ID,
  name: "在线工具模型",
  litellm_model: "openai/story-model",
  input_modalities: ["text", "image"],
  capabilities: {
    tools: "auto",
    reasoning: "auto",
    vision: "auto",
    structured_output: "auto",
    streaming_tools: "auto",
    reasoning_tools: "auto",
    tool_choice_auto: "auto",
    tool_choice_required: "auto",
    tool_choice_named: "auto",
    parallel_tools: "auto",
    vision_tools: "auto",
  },
  profile: unknown_model_profile("openai", "story-model"),
};

const SECONDARY_MODEL: AiModelSummary = {
  ...MODEL,
  model_id: SECONDARY_MODEL_ID,
  name: "备用工具模型",
  litellm_model: "anthropic/story-model",
  profile: unknown_model_profile("anthropic", "story-model"),
};

const DEFINITION: AgentDefinitionAvailability = {
  definition: {
    agent_id: "marker",
    title: "标记 Agent",
    description: "围绕当前视频证据回答问题或生成标记建议。",
    mode: "chat",
    prompt: "只根据证据回答。",
    required_capabilities: ["tools"],
    minimum_context_tokens: 8_000,
    tools: [
      {
        name: "search_evidence",
        description: "检索视频证据",
        prerequisites: [],
      },
    ],
    required_tools: [],
    requires_approval: false,
    result_type: null,
    input_mode: "message",
  },
  available: true,
  compatible_model_ids: [MODEL_ID, SECONDARY_MODEL_ID],
  capability_model_ids: { tools: [MODEL_ID, SECONDARY_MODEL_ID] },
  unavailable_reason: null,
};

const SESSION: AgentSession = {
  session_id: SESSION_ID,
  agent_id: "marker",
  asset_id: ASSET_ID,
  title: "透视投影问答",
  context: {},
  created_at: CREATED_AT,
  updated_at: CREATED_AT,
};

const meta = {
  title: "Assistant/AgentPanelStates",
  component: AgentPanel,
  args: {
    agent_id: "marker",
    asset_id: ASSET_ID,
    models: [MODEL, SECONDARY_MODEL],
    title: "视频助手",
    context_label: "当前视频 · 透视投影课程",
    focus_context: {
      workspace: "markers",
      surface: "markers",
      label: "标记面板 · 第 3 章",
      playhead_seconds: 132,
      selected_marker_ids: [],
      selected_transcript_indices: [],
    },
    className: "h-[640px] w-full",
  },
  decorators: [
    (Story) => (
      <div className="mx-auto flex min-h-screen w-full max-w-2xl items-start bg-background p-4 text-foreground">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AgentPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NoVideo: Story = {
  args: { asset_id: null },
  play: async ({ canvas }) => {
    await expect(canvas.getByText("请先选择视频")).toBeVisible();
  },
};

export const Loading: Story = {
  beforeEach: () => install_agent_fetch("loading"),
  play: async ({ canvas }) => {
    await expect(canvas.getByText("正在加载助手会话")).toBeVisible();
    await expect(canvas.queryByText("尚未创建会话")).toBeNull();
  },
};

export const Empty: Story = {
  beforeEach: () => install_agent_fetch("empty"),
  play: async ({ canvas, canvasElement, userEvent }) => {
    await expect(await canvas.findByText("尚未创建会话")).toBeVisible();
    await expect(
      canvas.getByRole("combobox", {
        name: "视频助手历史对话，当前视频 · 透视投影课程",
      }),
    ).toHaveTextContent("新建对话");
    await expect(
      canvas.getByRole("textbox", { name: "助手指令" }),
    ).toBeEnabled();
    const execution_control = canvas.getByRole("button", {
      name: "模型与思考强度：在线工具模型，自动",
    });
    await userEvent.click(execution_control);
    const page = within(canvasElement.ownerDocument.body);
    const model_select = page.getByRole("combobox", { name: "执行模型" });
    await expect(model_select).toHaveTextContent("在线工具模型");
    await userEvent.click(model_select);
    await userEvent.click(
      await page.findByRole("option", { name: /备用工具模型/ }),
    );
    await expect(model_select).toHaveTextContent("备用工具模型");
  },
};

export const Submitting: Story = {
  beforeEach: () => install_agent_fetch("submitting"),
  play: async ({ canvas, userEvent }) => {
    await expect(await canvas.findByText("尚未创建会话")).toBeVisible();
    const composer = canvas.getByRole("textbox", { name: "助手指令" });
    await userEvent.type(composer, "分析当前画面的构图");
    await userEvent.click(canvas.getByRole("button", { name: "发送指令" }));

    await expect(composer).toHaveValue("");
    await expect(canvas.getByText("分析当前画面的构图")).toBeVisible();
    await expect(canvas.getByText("正在发送请求")).toBeVisible();
    await expect(canvas.getByText("00:00")).toBeVisible();
    await expect(canvas.queryByText("尚未创建会话")).toBeNull();
  },
};

export const Streaming: Story = {
  beforeEach: () => install_agent_fetch("streaming"),
  parameters: { viewport: { value: "mobile1", isRotated: false } },
  play: async ({ canvas }) => {
    await expect(
      await canvas.findByText("正在整理当前时间线中的关键结论…"),
    ).toBeVisible();
    await expect(canvas.getByText("运行中")).toBeVisible();
  },
};

export const Failure: Story = {
  beforeEach: () => install_agent_fetch("failure"),
  play: async ({ canvas }) => {
    await expect(await canvas.findByText("助手运行失败")).toBeVisible();
    await expect(canvas.getByText("示例服务暂时不可用")).toBeVisible();
    await expect(canvas.queryByText("尚未创建会话")).toBeNull();
  },
};

export const LowConfidence: Story = {
  beforeEach: () => install_dark_agent_story("low-confidence"),
  play: async ({ canvas }) => {
    await expect(await canvas.findByText("暂定结论")).toBeVisible();
    await expect(canvas.getByText("发现 1 组证据冲突")).toBeVisible();
  },
};

export const CompactHeaderControls: Story = {
  args: { index_status: INDEX_STATUS },
  beforeEach: () => install_dark_agent_story("low-confidence"),
  play: async ({ canvas, canvasElement, userEvent }) => {
    await expect(await canvas.findByText("暂定结论")).toBeVisible();
    await expect(
      canvas.getByRole("combobox", {
        name: "视频助手历史对话，当前视频 · 透视投影课程",
      }),
    ).toHaveTextContent("透视投影问答");
    await expect(canvas.queryByText("历史会话")).toBeNull();
    await expect(canvas.queryByText("视频助手")).toBeNull();
    await expect(canvas.getAllByText("当前视频")).toHaveLength(1);
    const index_control = canvas.getByRole("button", {
      name: "索引状态：正在解析检索文本",
    });
    await expect(
      canvas.getByRole("button", { name: "新建对话" }),
    ).toBeVisible();
    await userEvent.click(index_control);
    const page = within(canvasElement.ownerDocument.body);
    const popover = await page.findByRole("dialog", { name: "索引状态" });
    await waitFor(async () => {
      await expect(within(popover).getByText("正在解析检索文本")).toBeVisible();
      await expect(
        within(popover).getByRole("progressbar", { name: "索引覆盖 34%" }),
      ).toBeVisible();
    });
  },
};

export const NewConversation: Story = {
  beforeEach: () => install_dark_agent_story("low-confidence"),
  play: async ({ canvas, userEvent }) => {
    await expect(await canvas.findByText("暂定结论")).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "新建对话" }));
    await expect(
      canvas.getByRole("combobox", {
        name: "视频助手历史对话，当前视频 · 透视投影课程",
      }),
    ).toHaveTextContent("新建对话");
    await expect(canvas.getByText("尚未创建会话")).toBeVisible();
    await expect(canvas.queryByText("暂定结论")).toBeNull();
  },
};

export const ManyEvidence: Story = {
  beforeEach: () => install_agent_fetch("many-evidence"),
  play: async ({ canvas, userEvent }) => {
    const disclosure = await canvas.findByRole("button", {
      name: /已参考 24 项内容/,
    });
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(disclosure);
    await expect(canvas.getByText("证据片段 24")).toBeVisible();
  },
};

type AgentStoryState =
  | "loading"
  | "empty"
  | "submitting"
  | "streaming"
  | "failure"
  | "low-confidence"
  | "many-evidence";

function install_agent_fetch(state: AgentStoryState) {
  const original_fetch = window.fetch;
  window.fetch = (input, init) => agent_fetch(state, input, init);
  return () => {
    window.fetch = original_fetch;
  };
}

function install_dark_agent_story(state: AgentStoryState) {
  const restore_fetch = install_agent_fetch(state);
  document.documentElement.classList.add("dark");
  return () => {
    restore_fetch();
    document.documentElement.classList.remove("dark");
  };
}

function agent_fetch(
  state: AgentStoryState,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  if (state === "loading") return pending_response(init?.signal);
  const url = new URL(String(input), window.location.origin);
  if (state === "failure") {
    return Promise.resolve(
      new Response(JSON.stringify({ message: "示例服务暂时不可用" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }
  if (url.pathname === "/api/agent-definitions") {
    return Promise.resolve(json_response([DEFINITION]));
  }
  if (url.pathname === "/api/agent-sessions") {
    if (init?.method === "POST" && state === "submitting") {
      return Promise.resolve(json_response(SESSION));
    }
    const sessions =
      state === "empty" || state === "submitting" ? [] : [SESSION];
    return Promise.resolve(json_response(sessions));
  }
  if (
    url.pathname === `/api/agent-sessions/${SESSION_ID}/runs` &&
    state === "submitting"
  ) {
    return pending_response(init?.signal);
  }
  if (url.pathname === `/api/agent-sessions/${SESSION_ID}`) {
    if (state === "submitting") {
      return Promise.resolve(
        new Response(JSON.stringify({ message: "新会话不应被重复读取" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    return Promise.resolve(json_response(session_state(state)));
  }
  if (url.pathname === `/api/agent-runs/${RUN_ID}/events`) {
    return Promise.resolve(streaming_response(init?.signal));
  }
  return Promise.resolve(json_response({}));
}

function session_state(state: AgentStoryState): AgentSessionState {
  if (state === "streaming") {
    const run = agent_run("running");
    return {
      session: SESSION,
      runs: [run],
      events: [agent_event(1, "run.status", { input: "总结当前选中范围" })],
      artifacts: [],
    };
  }
  const evidence_bundle =
    state === "many-evidence" ? many_evidence() : low_confidence_evidence();
  return {
    session: SESSION,
    runs: [agent_run("complete")],
    events: [
      agent_event(1, "run.status", { input: "这个结论的证据是什么？" }),
      agent_event(2, "message.completed", {
        content:
          state === "many-evidence"
            ? "这些片段共同说明了透视投影的定义、推导与应用。"
            : "现有片段支持这一解释，但相邻画面中的术语存在冲突。",
        confidence: state === "many-evidence" ? "high" : "low",
        answer_status: state === "many-evidence" ? "final" : "provisional",
        evidence_bundle,
      }),
    ],
    artifacts: [],
  };
}

function agent_run(stage: AgentRun["stage"]): AgentRun {
  return {
    run_id: RUN_ID,
    session_id: SESSION_ID,
    request_key: "request-019c012345677abc8123456789abcdef",
    model_id: MODEL_ID,
    stage,
    error_code: null,
    error_message: null,
    latest_event_sequence: stage === "running" ? 1 : 2,
    created_at: CREATED_AT,
    started_at: CREATED_AT,
    updated_at: CREATED_AT,
    completed_at: stage === "running" ? null : CREATED_AT,
  };
}

function agent_event(
  sequence: number,
  event_type: AgentEvent["event_type"],
  payload: Record<string, unknown>,
): AgentEvent {
  return {
    event_id: `event-019c012345677abc8123456789abcde${sequence}`,
    session_id: SESSION_ID,
    run_id: RUN_ID,
    sequence,
    event_type,
    payload,
    created_at: CREATED_AT,
  };
}

function low_confidence_evidence(): AgentEvidenceBundle {
  const item = evidence_item(1);
  return {
    items: [item],
    conflicts: [
      {
        evidence_ids: [item.evidence_id],
        reason: "字幕与相邻画面中的术语不一致。",
      },
    ],
    coverage: { temporal: 0.32, source_types: ["transcript", "frame"] },
  };
}

function many_evidence(): AgentEvidenceBundle {
  return {
    items: Array.from({ length: 24 }, (_, index) => evidence_item(index + 1)),
    conflicts: [],
    coverage: {
      temporal: 0.92,
      source_types: ["transcript", "ocr", "chapter"],
    },
  };
}

function evidence_item(index: number) {
  const suffix = index.toString(16).padStart(2, "0");
  return {
    evidence_id: `evidence-019c012345677abc8123456789abcd${suffix}`,
    citation_key: `[${index}]`,
    source_type: index % 3 === 0 ? "ocr" : "transcript",
    source_version: `source-v${index}`,
    asset_id: ASSET_ID,
    start_seconds: index * 12,
    end_seconds: index * 12 + 8,
    excerpt: `证据片段 ${index}`,
    relation: "supports" as const,
    retrieval_relation: "direct" as const,
  };
}

function streaming_response(signal?: AbortSignal | null): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          "event: message.delta\n" +
            'data: {"event_id":"event-019c012345677abc8123456789abcdef","sequence":2,"content":"正在整理当前时间线中的关键结论…"}\n\n',
        ),
      );
      signal?.addEventListener(
        "abort",
        () => controller.error(new DOMException("已取消", "AbortError")),
        { once: true },
      );
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function pending_response(signal?: AbortSignal | null): Promise<Response> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener(
      "abort",
      () => reject(new DOMException("已取消", "AbortError")),
      { once: true },
    );
  });
}

function json_response(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
