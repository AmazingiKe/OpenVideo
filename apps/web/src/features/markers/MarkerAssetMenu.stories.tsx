import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, type ReactNode } from "react";

import { MarkerAssetMenu } from "@/features/markers/MarkerAssetMenu";
import type { MediaAsset } from "@/shared/types";

const SELECTED_ASSET_ID = "019c0000-0000-7000-8000-000000000001";
const STORY_ASSETS: MediaAsset[] = [
  create_asset(SELECTED_ASSET_ID, "产品发布会完整回放", "OpenVideo"),
  create_asset(
    "019c0000-0000-7000-8000-000000000002",
    "访谈素材：创作工作流",
    "Amazing iKe",
  ),
];

const meta = {
  title: "Markers/MarkerAssetMenu",
  component: MarkerAssetMenu,
  args: {
    assets: STORY_ASSETS,
    selected_asset_id: SELECTED_ASSET_ID,
    on_select: () => undefined,
  },
} satisfies Meta<typeof MarkerAssetMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Empty: Story = {
  args: { assets: [], selected_asset_id: null },
};

export const Dark: Story = {
  decorators: [
    (StoryComponent) => (
      <DarkMode>
        <StoryComponent />
      </DarkMode>
    ),
  ],
};

function DarkMode({ children }: { children: ReactNode }) {
  useEffect(() => {
    document.documentElement.classList.add("dark");
    return () => document.documentElement.classList.remove("dark");
  }, []);
  return <div className="min-h-screen bg-background">{children}</div>;
}

function create_asset(
  asset_id: string,
  title: string,
  author_name: string,
): MediaAsset {
  return {
    asset_id,
    folder_id: null,
    media_type: "video",
    source_url: "https://example.com/video",
    source_platform: "bilibili",
    source_video_id: null,
    title,
    author_name,
    description: null,
    duration_seconds: 3661,
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
}
