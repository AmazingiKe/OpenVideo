import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";

import { LibraryBrowser } from "@/features/library/LibraryBrowser";
import {
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

const meta = {
  title: "Library/LibraryBrowser",
  component: LibraryBrowser,
  args: {
    current_video_id: STORY_ASSETS[0].asset_id,
    initial_folder_id: null,
    on_open_video: () => undefined,
  },
  beforeEach() {
    const original_fetch = window.fetch;
    window.fetch = library_fetch;
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

function library_fetch(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(String(input), window.location.origin);
  if (url.pathname === "/api/library/folders") {
    return Promise.resolve(json_response(STORY_FOLDERS));
  }
  if (url.pathname === "/api/media/assets") {
    const search = url.searchParams.get("search")?.toLocaleLowerCase();
    const folder_id = url.searchParams.get("folder_id");
    const uncategorized = url.searchParams.get("uncategorized") === "true";
    const assets = search
      ? STORY_LIBRARY_ASSETS.filter((asset) =>
          asset.title.toLocaleLowerCase().includes(search),
        )
      : uncategorized
        ? STORY_LIBRARY_ASSETS.filter((asset) => asset.folder_id === null)
        : STORY_LIBRARY_ASSETS.filter((asset) => asset.folder_id === folder_id);
    return Promise.resolve(json_response(assets));
  }
  return Promise.resolve(json_response({}));
}

function json_response(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
