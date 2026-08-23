import type { Meta, StoryObj } from "@storybook/react-vite";

import { AssetLibrary } from "./AssetLibrary";
import type { MediaAsset } from "@/shared/types";

const ASSET: MediaAsset = {
  asset_id: "01890f4c-7a2b-7cc2-98c4-dc0c0c07398f",
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
  thumbnail_url: null,
  thumbnail_storyboard: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const meta = {
  title: "Analysis/AssetLibrary",
  component: AssetLibrary,
  args: {
    assets: [ASSET],
    selected_asset_id: ASSET.asset_id,
    on_select: () => undefined,
    on_collapsed_change: () => undefined,
  },
  decorators: [
    (StoryComponent) => (
      <div className="dark h-[560px] w-[280px] overflow-hidden bg-background text-foreground">
        <StoryComponent />
      </div>
    ),
  ],
} satisfies Meta<typeof AssetLibrary>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Expanded: Story = {};

export const Collapsed: Story = {
  args: { collapsed: true },
  decorators: [
    (StoryComponent) => (
      <div className="h-[560px] w-12 overflow-hidden">
        <StoryComponent />
      </div>
    ),
  ],
};
