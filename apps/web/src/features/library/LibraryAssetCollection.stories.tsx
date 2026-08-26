import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { LibraryAssetCollection } from "@/features/library/LibraryAssetCollection";
import { FolderTree } from "@/features/library/FolderTree";
import {
  STORY_ASSETS,
  STORY_FOLDERS,
} from "@/features/library/library_story_fixtures";
import type { LibraryViewMode } from "@/features/library/LibraryVideoCard";

function StatefulLibraryAssetCollection({
  initial_selected = false,
  view_mode = "grid",
}: {
  initial_selected?: boolean;
  view_mode?: LibraryViewMode;
}) {
  const [selected_asset_ids, set_selected_asset_ids] = useState(
    initial_selected
      ? new Set(STORY_ASSETS.map((asset) => asset.asset_id))
      : new Set<string>(),
  );
  const [dragging_asset_ids, set_dragging_asset_ids] = useState<string[]>([]);

  return (
    <LibraryAssetCollection
      assets={STORY_ASSETS}
      folders={STORY_FOLDERS}
      selected_asset_ids={selected_asset_ids}
      dragging_asset_ids={dragging_asset_ids}
      view_mode={view_mode}
      on_selection_change={set_selected_asset_ids}
      on_move={() => undefined}
      on_drag_start={set_dragging_asset_ids}
      on_drag_end={() => set_dragging_asset_ids([])}
      on_delete={() => undefined}
      on_open_markers={() => undefined}
      on_open_summary={() => undefined}
    />
  );
}

function DragToFolderStory() {
  const [assets, set_assets] = useState(STORY_ASSETS);
  const [selected_asset_ids, set_selected_asset_ids] = useState(
    new Set(STORY_ASSETS.map((asset) => asset.asset_id)),
  );
  const [dragging_asset_ids, set_dragging_asset_ids] = useState<string[]>([]);

  return (
    <div className="grid gap-6 md:grid-cols-[16rem_minmax(0,1fr)]">
      <aside className="rounded-xl border bg-card p-3">
        <FolderTree
          folders={STORY_FOLDERS}
          selected_scope="all"
          expanded_folder_ids={new Set([STORY_FOLDERS[0].folder_id])}
          uncategorized_count={0}
          on_select={() => undefined}
          on_toggle={() => undefined}
          on_create={() => undefined}
          on_rename={() => undefined}
          on_move={() => undefined}
          on_delete={() => undefined}
          dragged_asset_count={dragging_asset_ids.length}
          on_assets_drop={(folder_id) => {
            set_assets((current) =>
              current.map((asset) =>
                selected_asset_ids.has(asset.asset_id)
                  ? { ...asset, folder_id }
                  : asset,
              ),
            );
            set_selected_asset_ids(new Set());
            set_dragging_asset_ids([]);
          }}
        />
      </aside>
      <LibraryAssetCollection
        assets={assets}
        folders={STORY_FOLDERS}
        selected_asset_ids={selected_asset_ids}
        dragging_asset_ids={dragging_asset_ids}
        view_mode="grid"
        on_selection_change={set_selected_asset_ids}
        on_move={() => undefined}
        on_drag_start={set_dragging_asset_ids}
        on_drag_end={() => set_dragging_asset_ids([])}
        on_delete={() => undefined}
        on_open_markers={() => undefined}
        on_open_summary={() => undefined}
      />
    </div>
  );
}

const meta = {
  title: "Library/LibraryAssetCollection",
  component: StatefulLibraryAssetCollection,
  decorators: [
    (StoryComponent) => (
      <div className="mx-auto max-w-3xl p-6">
        <StoryComponent />
      </div>
    ),
  ],
} satisfies Meta<typeof StatefulLibraryAssetCollection>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Grid: Story = {};

export const Selected: Story = {
  args: { initial_selected: true },
};

export const List: Story = {
  args: { view_mode: "list" },
};

export const Dark: Story = {
  args: { initial_selected: true },
  decorators: [
    (StoryComponent) => (
      <div className="dark min-h-screen bg-background text-foreground">
        <StoryComponent />
      </div>
    ),
  ],
};

export const DragToFolder: Story = {
  render: () => <DragToFolderStory />,
};
