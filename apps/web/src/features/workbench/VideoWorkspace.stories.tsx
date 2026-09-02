import { createRef } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { STORY_ASSETS } from "@/features/library/library_story_fixtures";
import type { PlayerHandle } from "@/features/player/Player";
import { VideoWorkspace } from "./VideoWorkspace";

const meta = {
  title: "Workbench/VideoWorkspace",
  component: VideoWorkspace,
  parameters: { layout: "fullscreen" },
  args: {
    asset: STORY_ASSETS[0],
    markers: [],
    transcript: null,
    player_ref: createRef<PlayerHandle>(),
    on_time_change: () => undefined,
    on_pause_change: () => undefined,
    on_playback_rate_change: () => undefined,
  },
  decorators: [
    (Story) => (
      <div className="h-svh">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof VideoWorkspace>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Empty: Story = {
  args: { asset: null },
};
