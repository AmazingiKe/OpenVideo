import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LibraryPage } from "@/pages/LibraryPage";
import {
  delete_folder,
  list_assets,
  list_folders,
  move_assets,
} from "@/shared/api";
import type { LibraryFolder, MediaAsset } from "@/shared/types";

const COURSE_ID = "folder-019c0000000070008000000000000001";
const ASSET_ID = "019c0000-0000-7000-8000-000000000001";
const refresh_assets = vi.fn().mockResolvedValue([]);

const FOLDERS: LibraryFolder[] = [
  {
    folder_id: COURSE_ID,
    name: "课程",
    parent_id: null,
    materialized_path: `/${COURSE_ID}/`,
    direct_asset_count: 1,
    recursive_asset_count: 1,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  },
];

const ASSET: MediaAsset = {
  asset_id: ASSET_ID,
  folder_id: COURSE_ID,
  media_type: "video",
  source_url: "https://example.com/video",
  source_platform: "bilibili",
  source_video_id: "video-1",
  title: "镜头语言入门",
  author_name: "开放影像课",
  description: null,
  duration_seconds: 120,
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
const SECOND_ASSET: MediaAsset = {
  ...ASSET,
  asset_id: "019c0000-0000-7000-8000-000000000002",
  source_video_id: "video-2",
  title: "镜头语言进阶",
};

vi.mock("@/app/asset_catalog", () => ({
  use_asset_catalog: () => ({
    assets: [ASSET],
    refresh_assets,
    select_asset: vi.fn(),
  }),
}));

vi.mock("@/shared/api", () => ({
  create_folder: vi.fn(),
  delete_asset: vi.fn(),
  delete_folder: vi.fn(),
  list_assets: vi.fn(),
  list_folders: vi.fn(),
  move_assets: vi.fn(),
  move_folder: vi.fn(),
  rename_folder: vi.fn(),
}));

describe("LibraryPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(list_folders).mockResolvedValue(FOLDERS);
    vi.mocked(list_assets).mockResolvedValue([ASSET]);
    vi.mocked(move_assets).mockResolvedValue([ASSET]);
    vi.mocked(delete_folder).mockResolvedValue(undefined);
    refresh_assets.mockResolvedValue([ASSET]);
  });

  it("filters the current folder and moves selected videos", async () => {
    render_page();

    expect(
      await screen.findByRole("heading", { name: "整理和查找所有视频" }),
    ).toBeInTheDocument();
    fireEvent.click(
      await screen.findByRole("button", { name: "课程，1 个视频" }),
    );

    await waitFor(() =>
      expect(list_assets).toHaveBeenCalledWith(
        expect.any(AbortSignal),
        expect.objectContaining({ folder_id: COURSE_ID }),
      ),
    );
    fireEvent.click(
      await screen.findByRole("checkbox", { name: "选择 镜头语言入门" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "移动所选" }));
    expect(
      screen.getByRole("dialog", { name: "移动视频" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "移动" }));

    await waitFor(() =>
      expect(move_assets).toHaveBeenCalledWith([ASSET_ID], COURSE_ID),
    );
  });

  it("selects all visible videos from the toolbar and keyboard", async () => {
    vi.mocked(list_assets).mockResolvedValue([ASSET, SECOND_ASSET]);
    render_page();

    const first_checkbox = await screen.findByRole("checkbox", {
      name: "选择 镜头语言入门",
    });
    const second_checkbox = screen.getByRole("checkbox", {
      name: "选择 镜头语言进阶",
    });
    fireEvent.click(screen.getByRole("button", { name: "全选当前结果" }));

    expect(first_checkbox).toBeChecked();
    expect(second_checkbox).toBeChecked();
    expect(screen.getByText("已选择 2 个视频")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "取消全选" }));
    expect(first_checkbox).not.toBeChecked();
    expect(second_checkbox).not.toBeChecked();

    fireEvent.keyDown(screen.getByRole("region", { name: "视频选择区域" }), {
      key: "a",
      ctrlKey: true,
    });
    expect(first_checkbox).toBeChecked();
    expect(second_checkbox).toBeChecked();
  });

  it("selects cards with pointer modifiers and clears selection on blank space", async () => {
    vi.mocked(list_assets).mockResolvedValue([ASSET, SECOND_ASSET]);
    render_page();

    const selection_region = await screen.findByRole("region", {
      name: "视频选择区域",
    });
    const first_card = screen.getByRole("group", { name: "镜头语言入门" });
    const second_card = screen.getByRole("group", { name: "镜头语言进阶" });
    const first_checkbox = screen.getByRole("checkbox", {
      name: "选择 镜头语言入门",
    });
    const second_checkbox = screen.getByRole("checkbox", {
      name: "选择 镜头语言进阶",
    });

    fireEvent.pointerDown(first_card, { button: 0, pointerType: "mouse" });
    fireEvent.pointerDown(second_card, {
      button: 0,
      pointerType: "mouse",
      ctrlKey: true,
    });
    expect(first_checkbox).toBeChecked();
    expect(second_checkbox).toBeChecked();

    fireEvent.pointerDown(selection_region, {
      button: 0,
      pointerId: 1,
      pointerType: "mouse",
      clientX: 240,
      clientY: 240,
    });
    fireEvent.pointerUp(selection_region, {
      button: 0,
      pointerId: 1,
      pointerType: "mouse",
      clientX: 240,
      clientY: 240,
    });
    expect(first_checkbox).not.toBeChecked();
    expect(second_checkbox).not.toBeChecked();
  });

  it("selects every card intersecting the mouse marquee", async () => {
    vi.mocked(list_assets).mockResolvedValue([ASSET, SECOND_ASSET]);
    render_page();

    const selection_region = await screen.findByRole("region", {
      name: "视频选择区域",
    });
    const first_card = screen.getByRole("group", { name: "镜头语言入门" });
    const second_card = screen.getByRole("group", { name: "镜头语言进阶" });
    vi.spyOn(selection_region, "getBoundingClientRect").mockReturnValue(
      dom_rectangle(0, 0, 600, 400),
    );
    vi.spyOn(first_card, "getBoundingClientRect").mockReturnValue(
      dom_rectangle(20, 20, 180, 180),
    );
    vi.spyOn(second_card, "getBoundingClientRect").mockReturnValue(
      dom_rectangle(320, 20, 480, 180),
    );

    fireEvent.pointerDown(selection_region, {
      button: 0,
      pointerId: 2,
      pointerType: "mouse",
      clientX: 0,
      clientY: 0,
    });
    fireEvent.pointerMove(selection_region, {
      pointerId: 2,
      pointerType: "mouse",
      clientX: 220,
      clientY: 220,
    });

    expect(
      screen.getByRole("checkbox", { name: "选择 镜头语言入门" }),
    ).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "选择 镜头语言进阶" }),
    ).not.toBeChecked();
  });

  it("requires the folder name before recursive deletion", async () => {
    render_page();

    fireEvent.pointerDown(
      await screen.findByRole("button", { name: "课程 操作" }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "永久删除" }));

    const delete_button = screen.getByRole("button", {
      name: "递归永久删除",
    });
    expect(delete_button).toBeDisabled();
    fireEvent.change(screen.getByLabelText("输入“课程”确认"), {
      target: { value: "课程" },
    });
    expect(delete_button).toBeEnabled();
    fireEvent.click(delete_button);

    await waitFor(() =>
      expect(delete_folder).toHaveBeenCalledWith(COURSE_ID, "课程"),
    );
  });
});

function render_page() {
  const query_client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={query_client}>
      <MemoryRouter initialEntries={["/library"]}>
        <LibraryPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function dom_rectangle(
  left: number,
  top: number,
  right: number,
  bottom: number,
) {
  return {
    x: left,
    y: top,
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
    toJSON: () => undefined,
  };
}
