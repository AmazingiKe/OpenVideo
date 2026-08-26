import type { Meta, StoryObj } from "@storybook/react-vite";

import { LibraryVideoCard } from "@/features/library/LibraryVideoCard";
import { STORY_ASSETS } from "@/features/library/library_story_fixtures";

const meta = {
  title: "Library/LibraryVideoCard",
  component: LibraryVideoCard,
  args: {
    asset: STORY_ASSETS[0],
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
