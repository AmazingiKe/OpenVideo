import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LibraryBrowser } from "@/features/library/LibraryBrowser";
import {
  create_folder,
  delete_asset,
  delete_folder,
  list_assets,
  list_folders,
  move_assets,
  rename_folder,
} from "@/shared/api";
import type { LibraryFolder, MediaAsset } from "@/shared/types";

const COURSE_ID = "folder-019c0000000070008000000000000001";
const CAMERA_ID = "folder-019c0000000070008000000000000002";
const ROOT_ASSET_ID = "019c0000-0000-7000-8000-000000000001";
const SECOND_ROOT_ASSET_ID = "019c0000-0000-7000-8000-000000000002";
const COURSE_ASSET_ID = "019c0000-0000-7000-8000-000000000003";
const FAILED_ASSET_ID = "019c0000-0000-7000-8000-000000000004";

const FOLDERS: LibraryFolder[] = [
  folder(COURSE_ID, "课程", null, 1, 2),
  folder(CAMERA_ID, "镜头语言", COURSE_ID, 1, 1),
];

const ASSETS: MediaAsset[] = [
  asset(ROOT_ASSET_ID, "未分类访谈", null),
  asset(SECOND_ROOT_ASSET_ID, "未分类花絮", null),
  asset(COURSE_ASSET_ID, "课程正片", COURSE_ID),
  asset(FAILED_ASSET_ID, "失败素材", CAMERA_ID, "failed"),
];

vi.mock("@/shared/api", () => ({
  create_folder: vi.fn(),
  delete_asset: vi.fn(),
  delete_folder: vi.fn(),
  list_assets: vi.fn(),
  list_folders: vi.fn(),
  media_url: (path: string) => path,
  move_assets: vi.fn(),
  move_folder: vi.fn(),
  rename_folder: vi.fn(),
}));

describe("LibraryBrowser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(list_folders).mockResolvedValue(FOLDERS);
    vi.mocked(list_assets).mockImplementation(async (_signal, options) => {
      if (options?.search) {
        const search = options.search.toLocaleLowerCase();
        return ASSETS.filter((candidate) =>
          candidate.title.toLocaleLowerCase().includes(search),
        );
      }
      if (options?.uncategorized) {
        return ASSETS.filter((candidate) => candidate.folder_id === null);
      }
      return ASSETS.filter(
        (candidate) => candidate.folder_id === options?.folder_id,
      );
    });
    vi.mocked(move_assets).mockResolvedValue([]);
    vi.mocked(delete_asset).mockResolvedValue(undefined);
    vi.mocked(delete_folder).mockResolvedValue(undefined);
    vi.mocked(rename_folder).mockResolvedValue(FOLDERS[0]);
    vi.mocked(create_folder).mockResolvedValue(
      folder("folder-019c0000000070008000000000000003", "新文件夹", null, 0, 0),
    );
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  it("shows only direct children and restores the current folder after global search", async () => {
    render_browser();

    expect(
      await screen.findByRole("button", { name: "课程，2 个视频" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /未分类访谈/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /镜头语言/ }),
    ).not.toBeInTheDocument();

    fireEvent.doubleClick(
      screen.getByRole("button", { name: "课程，2 个视频" }),
    );
    expect(
      await screen.findByRole("button", { name: "镜头语言，1 个视频" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /课程正片/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /未分类访谈/ }),
    ).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "搜索全部视频" }), {
      target: { value: "访谈" },
    });
    expect(
      await screen.findByRole("button", { name: /未分类访谈/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /镜头语言/ }),
    ).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "搜索全部视频" }), {
      target: { value: "" },
    });
    expect(
      await screen.findByRole("button", { name: "镜头语言，1 个视频" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("breadcrumb")).toHaveTextContent("课程");
  });

  it("supports video multi-selection while folders remain exclusive", async () => {
    render_browser();
    const first = await screen.findByRole("button", { name: /未分类访谈/ });
    const second = screen.getByRole("button", { name: /未分类花絮/ });
    const course = screen.getByRole("button", { name: "课程，2 个视频" });

    fireEvent.click(first);
    fireEvent.click(second, { ctrlKey: true });
    expect(first).toHaveAttribute("aria-pressed", "true");
    expect(second).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByText("已选择 2 个视频")).toHaveLength(2);

    fireEvent.click(course);
    expect(course).toHaveAttribute("aria-pressed", "true");
    expect(first).toHaveAttribute("aria-pressed", "false");
    expect(second).toHaveAttribute("aria-pressed", "false");
  });

  it("opens ready videos by double click or Enter and blocks failed videos", async () => {
    const on_open_video = vi.fn();
    render_browser({ on_open_video });
    const ready = await screen.findByRole("button", { name: /未分类访谈/ });

    fireEvent.doubleClick(ready);
    expect(on_open_video).toHaveBeenCalledWith(
      expect.objectContaining({ asset_id: ROOT_ASSET_ID }),
    );
    ready.focus();
    fireEvent.keyDown(ready, { key: "Enter" });
    expect(on_open_video).toHaveBeenCalledTimes(2);

    fireEvent.doubleClick(
      screen.getByRole("button", { name: "课程，2 个视频" }),
    );
    fireEvent.doubleClick(
      await screen.findByRole("button", { name: "镜头语言，1 个视频" }),
    );
    const failed = await screen.findByRole("button", { name: /失败素材/ });
    fireEvent.doubleClick(failed);
    expect(on_open_video).toHaveBeenCalledTimes(2);
    expect(failed).toHaveAttribute("aria-disabled", "true");
  });

  it("handles Space selection, Backspace navigation and view controls", async () => {
    render_browser();
    const course = await screen.findByRole("button", {
      name: "课程，2 个视频",
    });
    fireEvent.doubleClick(course);
    const course_video = await screen.findByRole("button", {
      name: /课程正片/,
    });
    fireEvent.click(course_video);
    fireEvent.keyDown(screen.getByRole("region", { name: "视频库项目" }), {
      key: " ",
    });
    expect(course_video).toHaveAttribute("aria-pressed", "false");

    fireEvent.keyDown(screen.getByRole("region", { name: "视频库项目" }), {
      key: "Backspace",
    });
    expect(
      await screen.findByRole("button", { name: "课程，2 个视频" }),
    ).toBeInTheDocument();

    const slider = screen.getByRole("slider", { name: "缩略图尺寸" });
    expect(slider).toHaveAttribute("aria-valuenow", "208");
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(slider).toHaveAttribute("aria-valuenow", "224");

    const sort_trigger = screen.getByRole("combobox", { name: "项目排序" });
    sort_trigger.hasPointerCapture = () => false;
    sort_trigger.setPointerCapture = vi.fn();
    sort_trigger.releasePointerCapture = vi.fn();
    fireEvent.pointerDown(sort_trigger, {
      button: 0,
      pointerType: "mouse",
    });
    fireEvent.click(await screen.findByRole("option", { name: "标题 A–Z" }));
    await waitFor(() =>
      expect(list_assets).toHaveBeenCalledWith(
        expect.any(AbortSignal),
        expect.objectContaining({ sort_by: "title", sort_order: "asc" }),
      ),
    );
    fireEvent.click(screen.getByRole("radio", { name: "列表视图" }));
    expect(
      screen.queryByRole("slider", { name: "缩略图尺寸" }),
    ).not.toBeInTheDocument();
    expect(list_assets).toHaveBeenCalledWith(
      expect.any(AbortSignal),
      expect.objectContaining({ sort_by: "created_at", sort_order: "desc" }),
    );
  });

  it("selects every video intersecting the mouse marquee", async () => {
    render_browser();
    const selection_region = await screen.findByRole("region", {
      name: "视频库项目",
    });
    const first = await screen.findByRole("button", { name: /未分类访谈/ });
    const second = await screen.findByRole("button", { name: /未分类花絮/ });
    vi.spyOn(selection_region, "getBoundingClientRect").mockReturnValue(
      dom_rectangle(0, 0, 600, 400),
    );
    vi.spyOn(first, "getBoundingClientRect").mockReturnValue(
      dom_rectangle(20, 20, 180, 180),
    );
    vi.spyOn(second, "getBoundingClientRect").mockReturnValue(
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
    expect(first).toHaveAttribute("aria-pressed", "true");
    expect(second).toHaveAttribute("aria-pressed", "false");
  });

  it("moves every selected video by dragging it onto a folder", async () => {
    render_browser();
    const first = await screen.findByRole("button", { name: /未分类访谈/ });
    const second = screen.getByRole("button", { name: /未分类花絮/ });
    fireEvent.click(first);
    fireEvent.click(second, { ctrlKey: true });
    const data_transfer = {
      effectAllowed: "none",
      dropEffect: "none",
      setData: vi.fn(),
    };
    fireEvent.dragStart(first, { dataTransfer: data_transfer });
    const target = screen.getByRole("button", { name: "课程，2 个视频" });
    fireEvent.dragOver(target, { dataTransfer: data_transfer });
    fireEvent.drop(target, { dataTransfer: data_transfer });

    await waitFor(() =>
      expect(move_assets).toHaveBeenCalledWith(
        [ROOT_ASSET_ID, SECOND_ROOT_ASSET_ID],
        COURSE_ID,
      ),
    );
  });

  it("creates and renames folders from the shared management UI", async () => {
    render_browser();
    await screen.findByRole("button", { name: "课程，2 个视频" });
    fireEvent.click(screen.getByRole("button", { name: "新建文件夹" }));
    fireEvent.change(screen.getByLabelText("文件夹名称"), {
      target: { value: "新项目" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(create_folder).toHaveBeenCalledWith("新项目", null),
    );

    const course = screen.getByRole("button", { name: "课程，2 个视频" });
    fireEvent.contextMenu(course);
    fireEvent.click(await screen.findByRole("menuitem", { name: "重命名" }));
    fireEvent.change(screen.getByLabelText("文件夹名称"), {
      target: { value: "精品课程" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(rename_folder).toHaveBeenCalledWith(COURSE_ID, "精品课程"),
    );
  });

  it("requires the folder name before recursive deletion", async () => {
    render_browser();
    const course = await screen.findByRole("button", {
      name: "课程，2 个视频",
    });
    fireEvent.contextMenu(course);
    fireEvent.click(await screen.findByRole("menuitem", { name: "永久删除" }));

    const delete_button = screen.getByRole("button", {
      name: "递归永久删除",
    });
    expect(delete_button).toBeDisabled();
    fireEvent.change(screen.getByLabelText("输入“课程”确认"), {
      target: { value: "课程" },
    });
    fireEvent.click(delete_button);
    await waitFor(() =>
      expect(delete_folder).toHaveBeenCalledWith(COURSE_ID, "课程"),
    );
  });

  it("keeps failed videos available for permanent deletion", async () => {
    render_browser();
    fireEvent.doubleClick(
      await screen.findByRole("button", { name: "课程，2 个视频" }),
    );
    fireEvent.doubleClick(
      await screen.findByRole("button", { name: "镜头语言，1 个视频" }),
    );
    const failed = await screen.findByRole("button", { name: /失败素材/ });
    fireEvent.contextMenu(failed);
    fireEvent.click(await screen.findByRole("menuitem", { name: "删除所选" }));
    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));

    await waitFor(() =>
      expect(delete_asset).toHaveBeenCalledWith(FAILED_ASSET_ID),
    );
  });
});

function render_browser({
  on_open_video = vi.fn(),
}: {
  on_open_video?: (asset: MediaAsset) => void | Promise<void>;
} = {}) {
  const query_client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  return render(
    <QueryClientProvider client={query_client}>
      <div className="h-[640px]">
        <LibraryBrowser
          initial_folder_id={null}
          on_open_video={on_open_video}
        />
      </div>
    </QueryClientProvider>,
  );
}

function folder(
  folder_id: string,
  name: string,
  parent_id: string | null,
  direct_asset_count: number,
  recursive_asset_count: number,
): LibraryFolder {
  const parent_path = parent_id ? `/${COURSE_ID}` : "";
  return {
    folder_id,
    name,
    parent_id,
    materialized_path: `${parent_path}/${folder_id}/`,
    direct_asset_count,
    recursive_asset_count,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function asset(
  asset_id: string,
  title: string,
  folder_id: string | null,
  status: MediaAsset["status"] = "ready",
): MediaAsset {
  return {
    asset_id,
    folder_id,
    media_type: "video",
    source_url: "https://example.com/video",
    source_platform: "bilibili",
    source_video_id: asset_id,
    title,
    author_name: "开放影像课",
    description: null,
    duration_seconds: 120,
    width: 1920,
    height: 1080,
    video_codec: "h264",
    audio_codec: "aac",
    status,
    error_message: status === "failed" ? "转码失败" : null,
    playback_url: status === "ready" ? "/stream" : null,
    scrub_preview_url: null,
    thumbnail_url: null,
    thumbnail_storyboard: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
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
