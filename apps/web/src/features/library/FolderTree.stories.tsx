import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { FolderTree, type LibraryScope } from "@/features/library/FolderTree";
import { STORY_FOLDERS } from "@/features/library/library_story_fixtures";

function StatefulFolderTree({
  dragged_asset_count = 0,
}: {
  dragged_asset_count?: number;
}) {
  const [scope, set_scope] = useState<LibraryScope>("all");
  const [expanded, set_expanded] = useState(
    new Set([STORY_FOLDERS[0].folder_id]),
  );
  return (
    <FolderTree
      folders={STORY_FOLDERS}
      selected_scope={scope}
      expanded_folder_ids={expanded}
      uncategorized_count={3}
      on_select={set_scope}
      on_toggle={(folder_id) =>
        set_expanded((current) => {
          const next = new Set(current);
          if (next.has(folder_id)) next.delete(folder_id);
          else next.add(folder_id);
          return next;
        })
      }
      on_create={() => undefined}
      on_rename={() => undefined}
      on_move={() => undefined}
      on_delete={() => undefined}
      dragged_asset_count={dragged_asset_count}
      on_assets_drop={() => undefined}
    />
  );
}

const meta = {
  title: "Library/FolderTree",
  component: StatefulFolderTree,
  decorators: [
    (StoryComponent) => (
      <div className="w-72 rounded-xl border bg-card p-3">
        <StoryComponent />
      </div>
    ),
  ],
} satisfies Meta<typeof StatefulFolderTree>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Nested: Story = {};

export const DraggingTwoVideos: Story = {
  args: { dragged_asset_count: 2 },
};
