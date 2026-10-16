import type { Meta, StoryObj } from "@storybook/react-vite";

import { PlaybackProgressNotice } from "./PlaybackProgressNotice";

const meta = {
  title: "Player/PlaybackProgressNotice",
  component: PlaybackProgressNotice,
  parameters: { layout: "padded" },
} satisfies Meta<typeof PlaybackProgressNotice>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Unavailable: Story = {
  args: { message: "暂时无法连接资料库，播放后的新进度尚未保存。" },
};
