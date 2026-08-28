import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  STORY_ASSETS,
  STORY_FOLDERS,
} from "@/features/library/library_story_fixtures";
import { MarkerLibraryPanel } from "./MarkerLibraryPanel";

const meta = {
  title: "Markers/MarkerLibraryPanel",
  component: MarkerLibraryPanel,
  args: {
    current_video_id: STORY_ASSETS[0].asset_id,
    initial_folder_id: null,
    on_collapsed_change: () => undefined,
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
      <div className="h-[720px] w-80 overflow-hidden border bg-background text-foreground">
        <StoryComponent />
      </div>
    ),
  ],
} satisfies Meta<typeof MarkerLibraryPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Collapsed: Story = {
  args: { collapsed: true },
  decorators: [
    (StoryComponent) => (
      <div className="h-[720px] w-12 overflow-hidden bg-background text-foreground">
        <StoryComponent />
      </div>
    ),
  ],
};

export const CompactCollapsed: Story = {
  args: { collapsed: true, compact: true },
  decorators: [
    (StoryComponent) => (
      <div className="w-[min(100vw,40rem)] overflow-hidden bg-background text-foreground">
        <StoryComponent />
      </div>
    ),
  ],
};

export const Dark: Story = {
  decorators: [
    (StoryComponent) => (
      <div className="dark h-[720px] w-80 overflow-hidden border bg-background text-foreground">
        <StoryComponent />
      </div>
    ),
  ],
};

function library_fetch(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(String(input), window.location.origin);
  if (url.pathname === "/api/library/folders") {
    return Promise.resolve(json_response(STORY_FOLDERS));
  }
  if (url.pathname === "/api/media/assets") {
    const folder_id = url.searchParams.get("folder_id");
    return Promise.resolve(
      json_response(
        STORY_ASSETS.filter((asset) => asset.folder_id === folder_id),
      ),
    );
  }
  return Promise.resolve(json_response({}));
}

function json_response(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
