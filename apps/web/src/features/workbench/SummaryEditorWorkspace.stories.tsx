import type { Meta, StoryObj } from "@storybook/react-vite";

import type {
  MediaAsset,
  SummaryAgentSessionState,
  SummaryDocument,
  Transcript,
} from "@/shared/types";
import { SummaryWorkspace } from "./SummaryWorkspace";

const ASSET_ID = "asset-0198dbf112347abc8123456789abcdef";
const ROOT_DOCUMENT_ID = "document-0198dbf212347abc8123456789abcdef";
const CHILD_DOCUMENT_ID = "document-0198dbf312347abc8123456789abcdef";
const SESSION_ID = "session-0198dbf412347abc8123456789abcdef";
const SECOND_SESSION_ID = "session-0198dbfb12347abc8123456789abcdef";
const CREATED_AT = "2026-08-24T08:00:00Z";

const ASSET: MediaAsset = {
  asset_id: ASSET_ID,
  folder_id: null,
  media_type: "video",
  source_url: "https://example.com/course.mp4",
  source_platform: "bilibili",
  source_video_id: null,
  title: "镜头语言与电影叙事",
  author_name: "开放影像课",
  description: "课程示例",
  duration_seconds: 180,
  width: 1920,
  height: 1080,
  video_codec: "h264",
  audio_codec: "aac",
  status: "ready",
  error_message: null,
  playback_url: "/stream",
  thumbnail_url: null,
  thumbnail_storyboard: null,
  created_at: CREATED_AT,
  updated_at: CREATED_AT,
};

const DOCUMENTS: SummaryDocument[] = [
  {
    document_id: ROOT_DOCUMENT_ID,
    asset_id: ASSET_ID,
    parent_document_id: null,
    title: "镜头语言课程笔记",
    markdown:
      "# 镜头语言课程笔记\n\n## 核心结论\n\n镜头不仅记录动作，也通过景别与运动组织观众注意力。\n\n- 全景建立空间关系\n- 特写强调人物反应\n\n详见 [案例拆解](docs/document-0198dbf312347abc8123456789abcdef.md)。",
    relative_path: "index.md",
    content_digest: "storybook-root-digest",
    position: 0,
    revision: 3,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
  },
  {
    document_id: CHILD_DOCUMENT_ID,
    asset_id: ASSET_ID,
    parent_document_id: ROOT_DOCUMENT_ID,
    title: "案例拆解",
    markdown:
      "# 案例拆解\n\n00:42 的推轨镜头逐步缩短观众与人物之间的心理距离。",
    relative_path: `docs/${CHILD_DOCUMENT_ID}.md`,
    content_digest: "storybook-child-digest",
    position: 0,
    revision: 1,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
  },
];

const SESSION: SummaryAgentSessionState = {
  session: {
    session_id: SESSION_ID,
    agent_type: "summary",
    title: "复习要点整理",
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
  },
  asset_id: ASSET_ID,
  root_document_id: ROOT_DOCUMENT_ID,
  events: [
    {
      event_id: "event-0198dbf512347abc8123456789abcdef",
      session_id: SESSION_ID,
      sequence: 1,
      run_id: null,
      event_type: "user/message",
      payload: { content: "把核心结论改得更适合复习。" },
      created_at: CREATED_AT,
    },
    {
      event_id: "event-0198dbf612347abc8123456789abcdef",
      session_id: SESSION_ID,
      sequence: 2,
      run_id: null,
      event_type: "assistant/message",
      payload: {
        content: "我整理了三条可快速回忆的结论，并补充了一张关键帧建议。",
      },
      created_at: CREATED_AT,
    },
  ],
  proposals: [
    {
      proposal_id: "proposal-0198dbf712347abc8123456789abcdef",
      session_id: SESSION_ID,
      document_id: ROOT_DOCUMENT_ID,
      base_revision: 3,
      proposed_markdown: DOCUMENTS[0]!.markdown,
      explanation: "将核心结论改写为可复习的要点，并保留案例入口。",
      diff: "+ 增加三条镜头语言复习要点",
      suggested_subdocuments: [],
      media_suggestions: [
        {
          suggestion_id: "suggestion-0198dbf812347abc8123456789abcdef",
          media_type: "image",
          start_seconds: 42,
          end_seconds: null,
          insert_after: "## 核心结论",
          caption: "推轨镜头开始靠近人物的关键帧",
        },
      ],
      status: "pending",
      created_at: CREATED_AT,
    },
  ],
};

const SECOND_SESSION: SummaryAgentSessionState = {
  session: {
    session_id: SECOND_SESSION_ID,
    agent_type: "summary",
    title: "案例拆解补充",
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
  },
  asset_id: ASSET_ID,
  root_document_id: ROOT_DOCUMENT_ID,
  events: [],
  proposals: [],
};

const TRANSCRIPT: Transcript = {
  asset_id: ASSET_ID,
  language: "zh",
  segments: [
    {
      start_seconds: 38,
      end_seconds: 48,
      text: "摄影机开始向人物缓慢推进。",
      emotion: null,
      audio_events: [],
    },
  ],
  created_at: CREATED_AT,
};

function json_response(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function summary_fetch(input: RequestInfo | URL): Promise<Response> {
  const url = typeof input === "string" ? input : input.toString();
  if (url.endsWith("/api/ai/models")) {
    return Promise.resolve(
      json_response([
        {
          model_id: "model-0198dbf912347abc8123456789abcdef",
          name: "课程总结模型",
          litellm_model: "openai/example",
          tool_calling_mode: "auto",
          input_modalities: ["text", "image"],
        },
      ]),
    );
  }
  if (url.endsWith(`/api/summary-agent-sessions/${SESSION_ID}`)) {
    return Promise.resolve(json_response(SESSION));
  }
  if (url.endsWith(`/api/summary-agent-sessions/${SECOND_SESSION_ID}`)) {
    return Promise.resolve(json_response(SECOND_SESSION));
  }
  if (url.endsWith(`/api/media/assets/${ASSET_ID}/summary-agent-sessions`)) {
    return Promise.resolve(
      json_response([
        {
          session: SESSION.session,
          asset_id: ASSET_ID,
          root_document_id: ROOT_DOCUMENT_ID,
        },
        {
          session: SECOND_SESSION.session,
          asset_id: ASSET_ID,
          root_document_id: ROOT_DOCUMENT_ID,
        },
      ]),
    );
  }
  if (url.includes("/summary-exports")) {
    return Promise.resolve(
      json_response({
        export_id: "export-0198dbfa12347abc8123456789abcdef",
        relative_path:
          "summary_output/summary-20260824-143015-382-export-0198dbfa12347abc8123456789abcdef.zip",
        file_name:
          "summary-20260824-143015-382-export-0198dbfa12347abc8123456789abcdef.zip",
        size_bytes: 4096,
        exported_at: "2026-08-24T14:30:15.382+08:00",
      }),
    );
  }
  if (url.includes("/summary-documents")) {
    return Promise.resolve(json_response(DOCUMENTS));
  }
  return Promise.resolve(json_response({}));
}

const meta = {
  title: "Summary/Workspace",
  component: SummaryWorkspace,
  args: {
    selected_asset: ASSET,
    transcript: TRANSCRIPT,
    segments: [],
  },
  beforeEach() {
    const original_fetch = window.fetch;
    window.fetch = summary_fetch;
    return () => {
      window.fetch = original_fetch;
    };
  },
  decorators: [
    (StoryComponent) => (
      <div className="h-[760px] min-w-0 overflow-hidden bg-background text-foreground">
        <StoryComponent />
      </div>
    ),
  ],
} satisfies Meta<typeof SummaryWorkspace>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Desktop: Story = {};

export const Dark: Story = {
  decorators: [
    (StoryComponent) => (
      <div className="dark bg-background text-foreground">
        <StoryComponent />
      </div>
    ),
  ],
};

export const Narrow: Story = {};
