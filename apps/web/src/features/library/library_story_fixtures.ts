import type { LibraryFolder, MediaAsset } from "@/shared/types";

export const STORY_FOLDERS: LibraryFolder[] = [
  {
    folder_id: "folder-019c0000000070008000000000000001",
    name: "课程",
    parent_id: null,
    materialized_path: "/folder-019c0000000070008000000000000001/",
    direct_asset_count: 2,
    recursive_asset_count: 4,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  },
  {
    folder_id: "folder-019c0000000070008000000000000002",
    name: "镜头语言",
    parent_id: "folder-019c0000000070008000000000000001",
    materialized_path:
      "/folder-019c0000000070008000000000000001/folder-019c0000000070008000000000000002/",
    direct_asset_count: 2,
    recursive_asset_count: 2,
    created_at: "2026-01-02T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
  },
];

export const STORY_ASSETS: MediaAsset[] = [
  {
    asset_id: "019c0000-0000-7000-8000-000000000001",
    folder_id: STORY_FOLDERS[0].folder_id,
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
    scrub_preview_url: null,
    thumbnail_url: null,
    thumbnail_storyboard: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  },
  {
    asset_id: "019c0000-0000-7000-8000-000000000002",
    folder_id: STORY_FOLDERS[1].folder_id,
    media_type: "video",
    source_url: "https://www.bilibili.com/video/BV1xx411c7mE",
    source_platform: "bilibili",
    source_video_id: "BV1xx411c7mE",
    title: "景别与构图的叙事作用",
    author_name: "开放影像课",
    description: "课程简介",
    duration_seconds: 960,
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
    created_at: "2026-01-02T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
  },
];

export function create_large_library_story_assets(count: number): MediaAsset[] {
  return Array.from({ length: count }, (_, index) => {
    const item_number = index + 1;
    const suffix = item_number.toString(16).padStart(12, "0");
    return {
      ...STORY_ASSETS[index % STORY_ASSETS.length],
      asset_id: `019c0000-0000-7000-8000-${suffix}`,
      folder_id: null,
      source_video_id: `STORY${item_number.toString().padStart(8, "0")}`,
      title: `大型资料库视频 ${item_number.toLocaleString("zh-CN")}`,
      created_at: new Date(
        Date.UTC(2026, 0, 1, 0, 0, item_number),
      ).toISOString(),
      updated_at: new Date(
        Date.UTC(2026, 0, 1, 0, 0, item_number),
      ).toISOString(),
    };
  });
}
