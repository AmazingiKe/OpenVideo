import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fireEvent, userEvent, waitFor, within } from "storybook/test";

import { LibraryBrowser } from "@/features/library/LibraryBrowser";
import {
  create_large_library_story_assets,
  STORY_ASSETS,
  STORY_FOLDERS,
} from "@/features/library/library_story_fixtures";
import type { MediaAsset } from "@/shared/types";

const ROOT_ASSET: MediaAsset = {
  ...STORY_ASSETS[0],
  asset_id: "019c0000-0000-7000-8000-000000000010",
  folder_id: null,
  source_video_id: "BV1xx411c7mR",
  title: "未分类的幕后访谈",
};

const FAILED_ASSET: MediaAsset = {
  ...STORY_ASSETS[1],
  asset_id: "019c0000-0000-7000-8000-000000000011",
  folder_id: null,
  source_video_id: "BV1xx411c7mF",
  title: "等待修复的采访素材",
  status: "failed",
  error_message: "下载源已失效",
  playback_url: null,
};

const STORY_LIBRARY_ASSETS = [...STORY_ASSETS, ROOT_ASSET, FAILED_ASSET];

type StoryMoveRequest = {
  asset_ids: string[];
  folder_id: string | null;
};

let latest_move_request: StoryMoveRequest | null = null;

const meta = {
  title: "Library/LibraryBrowser",
  component: LibraryBrowser,
  args: {
    className: "h-full",
    current_video_id: STORY_ASSETS[0].asset_id,
    initial_folder_id: null,
    on_open_video: () => undefined,
  },
  beforeEach() {
    const original_fetch = window.fetch;
    window.fetch = create_library_fetch(STORY_LIBRARY_ASSETS);
    return () => {
      window.fetch = original_fetch;
    };
  },
  decorators: [
    (StoryComponent) => (
      <div className="h-[720px] min-w-0 overflow-hidden bg-background p-4 text-foreground">
        <StoryComponent />
      </div>
    ),
  ],
} satisfies Meta<typeof LibraryBrowser>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WideGrid: Story = {};

export const ListView: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(
      await within(canvasElement).findByRole("radio", { name: "列表视图" }),
    );
  },
};

export const NestedFolder: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.dblClick(
      await within(canvasElement).findByRole("button", {
        name: "课程，4 个视频",
      }),
    );
  },
};

export const GlobalSearch: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.type(
      await within(canvasElement).findByRole("searchbox", {
        name: "搜索全部视频",
      }),
      "景别",
    );
  },
};

export const Narrow: Story = {
  args: { compact: true },
  decorators: [
    (StoryComponent) => (
      <div className="h-[720px] w-full overflow-hidden border bg-card p-2">
        <StoryComponent />
      </div>
    ),
  ],
};

export const Dark: Story = {
  decorators: [
    (StoryComponent) => (
      <div className="dark h-[720px] overflow-hidden bg-background p-4 text-foreground">
        <StoryComponent />
      </div>
    ),
  ],
};

export const LargeLibrary: Story = {
  beforeEach() {
    const original_fetch = window.fetch;
    window.fetch = create_library_fetch(
      create_large_library_story_assets(10_000),
    );
    return () => {
      window.fetch = original_fetch;
    };
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const first_video = await canvas.findByRole("button", {
      name: /^大型资料库视频 1，/,
    });
    await expect(
      canvasElement.querySelectorAll("[data-library-item]").length,
    ).toBeLessThan(100);

    await userEvent.click(first_video);
    const region = canvas.getByRole("region", { name: "视频库项目" });
    region.scrollTop = 5_000;
    fireEvent.scroll(region);
    await waitFor(() =>
      expect(
        canvas.queryByRole("button", { name: /^大型资料库视频 1，/ }),
      ).not.toBeInTheDocument(),
    );

    region.scrollTop = 0;
    fireEvent.scroll(region);
    const remounted_video = await canvas.findByRole("button", {
      name: /^大型资料库视频 1，/,
    });
    await expect(remounted_video).toHaveAttribute("aria-pressed", "true");
  },
};

export const CompactLargeLibrary: Story = {
  ...LargeLibrary,
  args: { compact: true },
};

export const MarqueeSelection: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const region = await canvas.findByRole("region", { name: "视频库项目" });
    const first_video = await canvas.findByRole("button", {
      name: /未分类的幕后访谈/,
    });
    const first_card = first_video.closest<HTMLElement>("[data-library-item]");
    if (!first_card) throw new Error("视频卡片未挂载");
    const card_bounds = first_card.getBoundingClientRect();

    await userEvent.pointer([
      {
        keys: "[MouseLeft>]",
        target: region,
        coords: {
          clientX: card_bounds.left - 4,
          clientY: card_bounds.top - 4,
        },
      },
      {
        target: region,
        coords: {
          clientX: card_bounds.right - 4,
          clientY: card_bounds.bottom - 4,
        },
      },
    ]);
    await waitFor(() =>
      expect(first_video).toHaveAttribute("aria-pressed", "true"),
    );
    await userEvent.pointer({ keys: "[/MouseLeft]", target: region });
  },
};

export const DragSelectedVideos: Story = {
  beforeEach() {
    latest_move_request = null;
    const original_fetch = window.fetch;
    window.fetch = create_library_fetch(STORY_LIBRARY_ASSETS, (request) => {
      latest_move_request = request;
    });
    return () => {
      window.fetch = original_fetch;
    };
  },
  play: async ({ canvasElement }) => {
    const user = userEvent.setup();
    const canvas = within(canvasElement);
    const first_video = await canvas.findByRole("button", {
      name: /未分类的幕后访谈/,
    });
    const second_video = await canvas.findByRole("button", {
      name: /等待修复的采访素材/,
    });
    await user.click(first_video);
    fireEvent.click(second_video, { ctrlKey: true });
    await expect(first_video).toHaveAttribute("aria-pressed", "true");
    await expect(second_video).toHaveAttribute("aria-pressed", "true");

    const target_folder = canvas.getByRole("button", {
      name: "课程，4 个视频",
    });
    await start_pointer_drag(user, first_video);
    await move_pointer(user, target_folder);
    await waitFor(() =>
      expect(target_folder).toHaveAttribute("data-drop-active", "true"),
    );
    await release_pointer(user, target_folder);
    const announcement = drag_announcement(canvasElement);
    await waitFor(() => expect(announcement).toHaveTextContent(/^已移动/));

    await waitFor(() =>
      expect(latest_move_request).toEqual({
        asset_ids: [ROOT_ASSET.asset_id, FAILED_ASSET.asset_id],
        folder_id: STORY_FOLDERS[0].folder_id,
      }),
    );
  },
};

export const CancelDrag: Story = {
  play: async ({ canvasElement }) => {
    const user = userEvent.setup();
    const canvas = within(canvasElement);
    const source_video = await canvas.findByRole("button", {
      name: /未分类的幕后访谈/,
    });
    const source_card = await start_pointer_drag(user, source_video);

    await user.keyboard("{Escape}");

    await waitFor(() =>
      expect(source_card).not.toHaveAttribute("data-dragging"),
    );
    await expect(drag_announcement(canvasElement)).toHaveTextContent(
      "已取消移动",
    );
  },
};

export const DragAutoScroll: Story = {
  beforeEach() {
    const original_fetch = window.fetch;
    window.fetch = create_library_fetch(
      create_large_library_story_assets(10_000),
    );
    return () => {
      window.fetch = original_fetch;
    };
  },
  play: async ({ canvasElement }) => {
    const user = userEvent.setup();
    const canvas = within(canvasElement);
    const source_video = await canvas.findByRole("button", {
      name: /^大型资料库视频 1，/,
    });
    const region = canvas.getByRole("region", { name: "视频库项目" });
    await start_pointer_drag(user, source_video);

    const region_bounds = region.getBoundingClientRect();
    await move_pointer(user, region, {
      clientX: region_bounds.left + region_bounds.width / 2,
      clientY: region_bounds.bottom - 4,
    });

    await waitFor(
      () =>
        expect(
          canvas.queryByRole("button", { name: /^大型资料库视频 1，/ }),
        ).not.toBeInTheDocument(),
      { timeout: 3_000 },
    );
    await expect(
      canvasElement.querySelector("[data-library-drag-overlay]"),
    ).toHaveTextContent("大型资料库视频 1");

    await user.keyboard("{Escape}");
    await expect(drag_announcement(canvasElement)).toHaveTextContent(
      "已取消移动",
    );
  },
};

export const InvalidDrop: Story = {
  beforeEach() {
    latest_move_request = null;
    const original_fetch = window.fetch;
    window.fetch = create_library_fetch(STORY_LIBRARY_ASSETS, (request) => {
      latest_move_request = request;
    });
    return () => {
      window.fetch = original_fetch;
    };
  },
  play: async ({ canvasElement }) => {
    const user = userEvent.setup();
    const canvas = within(canvasElement);
    const source_video = await canvas.findByRole("button", {
      name: /未分类的幕后访谈/,
    });
    const region = canvas.getByRole("region", { name: "视频库项目" });
    await start_pointer_drag(user, source_video);

    const region_bounds = region.getBoundingClientRect();
    const blank_point = {
      clientX: region_bounds.right - 16,
      clientY: region_bounds.bottom - 16,
    };
    await move_pointer(user, region, blank_point);
    await release_pointer(user, region, blank_point);

    await waitFor(() =>
      expect(drag_announcement(canvasElement)).toHaveTextContent("未移动视频"),
    );
    await expect(latest_move_request).toBeNull();
  },
};

export const MoveFailure: Story = {
  beforeEach() {
    latest_move_request = null;
    const original_fetch = window.fetch;
    window.fetch = create_library_fetch(
      STORY_LIBRARY_ASSETS,
      (request) => {
        latest_move_request = request;
      },
      false,
    );
    return () => {
      window.fetch = original_fetch;
    };
  },
  play: async ({ canvasElement }) => {
    const user = userEvent.setup();
    const canvas = within(canvasElement);
    const source_video = await canvas.findByRole("button", {
      name: /未分类的幕后访谈/,
    });
    const target_folder = canvas.getByRole("button", {
      name: "课程，4 个视频",
    });
    await start_pointer_drag(user, source_video);
    await move_pointer(user, target_folder);
    await waitFor(() =>
      expect(target_folder).toHaveAttribute("data-drop-active", "true"),
    );
    await release_pointer(user, target_folder);

    await canvas.findByText("操作未完成");
    await waitFor(() =>
      expect(drag_announcement(canvasElement)).toHaveTextContent(
        "移动到“课程”失败",
      ),
    );
    await expect(latest_move_request).toEqual({
      asset_ids: [ROOT_ASSET.asset_id],
      folder_id: STORY_FOLDERS[0].folder_id,
    });
  },
};

export const EmptyState: Story = {
  beforeEach() {
    const original_fetch = window.fetch;
    window.fetch = () => Promise.resolve(json_response([]));
    return () => {
      window.fetch = original_fetch;
    };
  },
};

export const LoadingState: Story = {
  beforeEach() {
    const original_fetch = window.fetch;
    window.fetch = () => new Promise<Response>(() => undefined);
    return () => {
      window.fetch = original_fetch;
    };
  },
};

export const ErrorState: Story = {
  beforeEach() {
    const original_fetch = window.fetch;
    window.fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ detail: "示例加载错误" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
      );
    return () => {
      window.fetch = original_fetch;
    };
  },
};

function create_library_fetch(
  library_assets: MediaAsset[],
  on_move?: (request: StoryMoveRequest) => void,
  move_succeeds = true,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return (input, init) => {
    const url = new URL(String(input), window.location.origin);
    if (url.pathname === "/api/library/folders") {
      return Promise.resolve(json_response(STORY_FOLDERS));
    }
    if (url.pathname === "/api/media/assets") {
      const search = url.searchParams.get("search")?.toLocaleLowerCase();
      const folder_id = url.searchParams.get("folder_id");
      const uncategorized = url.searchParams.get("uncategorized") === "true";
      const assets = search
        ? library_assets.filter((asset) =>
            asset.title.toLocaleLowerCase().includes(search),
          )
        : uncategorized
          ? library_assets.filter((asset) => asset.folder_id === null)
          : library_assets.filter((asset) => asset.folder_id === folder_id);
      return Promise.resolve(json_response(assets));
    }
    if (url.pathname === "/api/media/assets/move") {
      const body = typeof init?.body === "string" ? init.body : "{}";
      on_move?.(JSON.parse(body) as StoryMoveRequest);
      return Promise.resolve(
        move_succeeds
          ? json_response([])
          : new Response(JSON.stringify({ detail: "示例移动失败" }), {
              status: 500,
              headers: { "Content-Type": "application/json" },
            }),
      );
    }
    return Promise.resolve(json_response({}));
  };
}

function rectangle_center(rectangle: DOMRect) {
  return {
    clientX: rectangle.left + rectangle.width / 2,
    clientY: rectangle.top + rectangle.height / 2,
  };
}

type StoryUser = ReturnType<typeof userEvent.setup>;

async function start_pointer_drag(
  user: StoryUser,
  source_button: HTMLElement,
): Promise<HTMLElement> {
  const source_card = source_button.closest<HTMLElement>("[data-library-item]");
  if (!source_card) throw new Error("拖拽源未挂载");
  const drag_handle = within(source_card).getByRole("button", {
    name: "拖动所选视频",
  });
  const handle_center = rectangle_center(drag_handle.getBoundingClientRect());
  await user.pointer([
    {
      keys: "[MouseLeft>]",
      target: drag_handle,
      coords: handle_center,
    },
    {
      target: drag_handle,
      coords: {
        clientX: handle_center.clientX + 12,
        clientY: handle_center.clientY + 12,
      },
    },
  ]);
  await waitFor(() =>
    expect(source_card).toHaveAttribute("data-dragging", "true"),
  );
  return source_card;
}

async function move_pointer(
  user: StoryUser,
  target: HTMLElement,
  coordinates = rectangle_center(target.getBoundingClientRect()),
) {
  await user.pointer([
    { target, coords: coordinates },
    {
      target,
      coords: {
        clientX: coordinates.clientX + 1,
        clientY: coordinates.clientY + 1,
      },
    },
  ]);
}

async function release_pointer(
  user: StoryUser,
  target: HTMLElement,
  coordinates = rectangle_center(target.getBoundingClientRect()),
) {
  await user.pointer({
    keys: "[/MouseLeft]",
    target,
    coords: coordinates,
  });
}

function drag_announcement(canvas_element: HTMLElement): HTMLElement {
  const announcement = canvas_element.querySelector<HTMLElement>(
    '[aria-live="assertive"]',
  );
  if (!announcement) throw new Error("拖放状态播报未挂载");
  return announcement;
}

function json_response(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
