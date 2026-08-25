import type { Meta, StoryObj } from "@storybook/react-vite";

import { LibraryVideoCard } from "@/features/library/LibraryVideoCard";
import type { MediaAsset } from "@/shared/types";

const ASSET: MediaAsset = {
  asset_id: "019c0000-0000-7000-8000-000000000001",
  folder_id: "folder-019c0000000070008000000000000001",
  media_type: "video",
  source_url: "https://www.bilibili.com/video/BV1xx411c7mD",
  source_platform: "bilibili",
  source_video_id: "BV1xx411c7mD",
  title: "从镜头语言理解电影叙事",
  author_name: "开放影像课",
  description: "课程简介",
  duration_seconds: 1280,
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
  title: "Library/LibraryVideoCard",
  component: LibraryVideoCard,
  args: {
    asset: ASSET,
    selected: false,
    view_mode: "grid",
    folder_name: "课程",
    on_selected_change: () => undefined,
    on_move: () => undefined,
    on_delete: () => undefined,
    on_open_markers: () => undefined,
    on_open_summary: () => undefined,
  },
  decorators: [
    (StoryComponent) => (
      <div className="w-80">
        <StoryComponent />
      </div>
    ),
  ],
} satisfies Meta<typeof LibraryVideoCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Grid: Story = {};

export const Selected: Story = { args: { selected: true } };

export const List: Story = {
  args: { view_mode: "list" },
  decorators: [
    (StoryComponent) => (
      <div className="w-[52rem] max-w-full">
        <StoryComponent />
      </div>
    ),
  ],
};

export const Dark: Story = {
  decorators: [
    (StoryComponent) => (
      <div className="dark min-h-screen bg-background p-6 text-foreground">
        <StoryComponent />
      </div>
    ),
  ],
};
