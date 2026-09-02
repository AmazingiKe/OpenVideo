import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { STORY_ASSETS } from "@/features/library/library_story_fixtures";
import { SummaryMediaShelf } from "./SummaryMediaShelf";

const meta = {
  title: "Summary/SummaryMediaShelf",
  component: SummaryMediaShelf,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof SummaryMediaShelf>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Collapsed: Story = {
  args: story_args(false),
  render: () => <ShelfStory initial_expanded={false} />,
};

export const Expanded: Story = {
  args: story_args(true),
  render: () => <ShelfStory initial_expanded />,
};

function story_args(expanded: boolean) {
  return {
    asset: STORY_ASSETS[0],
    expanded,
    on_expanded_change: () => undefined,
    transcript: null,
  };
}

function ShelfStory({ initial_expanded }: { initial_expanded: boolean }) {
  const [expanded, set_expanded] = useState(initial_expanded);
  return (
    <div className={expanded ? "h-64" : "h-12"}>
      <SummaryMediaShelf
        asset={STORY_ASSETS[0]}
        expanded={expanded}
        on_expanded_change={set_expanded}
        transcript={null}
      />
    </div>
  );
}
