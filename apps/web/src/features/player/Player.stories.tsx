import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { Player } from "./Player";

const DEMO_VIDEO_URL = "https://files.vidstack.io/sprite-fight/720p.mp4";

const meta = {
  title: "Media/Player",
  component: Player,
  decorators: [
    (StoryComponent) => (
      <div className="h-96 w-full bg-background p-4">
        <StoryComponent />
      </div>
    ),
  ],
  parameters: {
    layout: "fullscreen",
  },
  args: {
    src: DEMO_VIDEO_URL,
    markers: [
      { start_seconds: 3, label: "开场" },
      { start_seconds: 8, label: "动作段落" },
    ],
    subtitles: [],
    evidence_range: null,
    thumbnails: null,
  },
} satisfies Meta<typeof Player>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(await canvas.findByRole("button", { name: "播放" })).toBeVisible();
    expect(await canvas.findByRole("button", { name: "设置" })).toBeVisible();
  },
};

export const Dark: Story = {
  decorators: [
    (StoryComponent) => (
      <div className="dark h-full bg-background text-foreground">
        <StoryComponent />
      </div>
    ),
  ],
};

export const Narrow: Story = {
  globals: {
    viewport: { value: "mobile1", isRotated: false },
  },
};
