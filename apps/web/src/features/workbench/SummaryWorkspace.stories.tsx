import type { Meta, StoryObj } from "@storybook/react-vite";

import type { MediaAsset, Transcript } from "@/shared/types";
import { SummaryGeneration } from "./SummaryWorkspace";

const ASSET: MediaAsset = {
  asset_id: "01890f4c-7a2b-7cc2-98c4-dc0c0c07398f",
  folder_id: null,
  media_type: "video",
  source_url: "https://www.bilibili.com/video/BV1xx411c7mD",
  source_platform: "bilibili",
  source_video_id: "BV1xx411c7mD",
  title: "从镜头语言理解电影叙事",
  author_name: "开放影像课",
  description: "课程简介",
  duration_seconds: 180,
  width: 1920,
  height: 1080,
  video_codec: "h264",
  audio_codec: "aac",
  status: "ready",
  error_message: null,
  playback_url: "/stream",
  scrub_preview_url: null,
  thumbnail_url: null,
  thumbnail_storyboard: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const TRANSCRIPT: Transcript = {
  asset_id: ASSET.asset_id,
  language: "zh",
  segments: [
    {
      start_seconds: 0,
      end_seconds: 8,
      text: "镜头会组织观众注意力。",
      emotion: null,
      audio_events: [],
    },
  ],
  created_at: "2026-01-01T00:00:00Z",
};

const meta = {
  title: "Summary/Generation",
  component: SummaryGeneration,
  // Milkdown builder 的开发态 ESM 与 Vitest 浏览器不兼容，生产 Storybook 构建仍覆盖该场景。
  tags: ["!test"],
  args: {
    asset: ASSET,
    transcript: TRANSCRIPT,
    segment_count: 6,
    models: [],
    model_id: null,
    on_model_change: () => undefined,
    detail: "standard",
    on_detail_change: () => undefined,
    create_subdocuments: false,
    on_create_subdocuments_change: () => undefined,
    is_generating: false,
    on_generate: () => undefined,
  },
  decorators: [
    (StoryComponent) => (
      <div className="h-[720px] max-w-[900px] bg-background text-foreground">
        <StoryComponent />
      </div>
    ),
  ],
} satisfies Meta<typeof SummaryGeneration>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Running: Story = {
  args: { is_generating: true },
};

export const DisabledWithoutTranscript: Story = {
  args: { transcript: null },
};

export const Narrow: Story = {
  decorators: [
    (StoryComponent) => (
      <div className="h-[720px] w-[360px] max-w-full bg-background text-foreground">
        <StoryComponent />
      </div>
    ),
  ],
};

export const Dark: Story = {
  decorators: [
    (StoryComponent) => (
      <div className="dark min-h-screen bg-background p-8 text-foreground">
        <StoryComponent />
      </div>
    ),
  ],
};
