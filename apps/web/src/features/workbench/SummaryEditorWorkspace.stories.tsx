import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  DEFAULT_MODEL_CAPABILITY_OVERRIDES,
  unknown_model_profile,
  type MediaAsset,
  type SummaryDocument,
  type Transcript,
} from "@/shared/types";
import { SummaryWorkspace } from "./SummaryWorkspace";

const ASSET_ID = "asset-0198dbf112347abc8123456789abcdef";
const ROOT_DOCUMENT_ID = "document-0198dbf212347abc8123456789abcdef";
const CHILD_DOCUMENT_ID = "document-0198dbf312347abc8123456789abcdef";
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
          input_modalities: ["text", "image"],
          capabilities: { ...DEFAULT_MODEL_CAPABILITY_OVERRIDES },
          profile: unknown_model_profile("openai", "example"),
        },
      ]),
    );
  }
  if (url.includes("/api/agent-definitions")) {
    return Promise.resolve(
      json_response([
        {
          definition: {
            agent_id: "summary",
            title: "总结 Agent",
            description: "围绕视频证据问答或生成文档修改预览。",
            mode: "chat",
            prompt: "总结协作",
            required_capabilities: [],
            minimum_context_tokens: 8000,
            tools: [],
            required_tools: [],
            requires_approval: false,
            result_type: "summary_edit",
            input_mode: "message",
          },
          available: true,
          compatible_model_ids: ["model-0198dbf912347abc8123456789abcdef"],
          capability_model_ids: {
            tools: ["model-0198dbf912347abc8123456789abcdef"],
            vision: ["model-0198dbf912347abc8123456789abcdef"],
            long_context: ["model-0198dbf912347abc8123456789abcdef"],
          },
          unavailable_reason: null,
        },
      ]),
    );
  }
  if (url.includes("/api/agent-sessions")) {
    return Promise.resolve(json_response([]));
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
  // Milkdown builder 的开发态 ESM 与 Vitest 浏览器不兼容，生产 Storybook 构建仍覆盖该场景。
  tags: ["!test"],
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
