import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";

import { ResponseStream } from "./response-stream";

const meta = {
  title: "Assistant/ResponseStream",
  component: ResponseStream,
  args: {
    text_stream: "回答会按字符平滑显示，不再整块跳出。",
    stream_live: false,
    className: "text-sm leading-relaxed",
  },
  decorators: [
    (Story) => (
      <div className="max-w-md rounded-lg border bg-muted p-4 text-foreground">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ResponseStream>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Typewriter: Story = {
  play: async ({ canvas }) => {
    await expect(
      await canvas.findByText("回答会按字符平滑显示，不再整块跳出。"),
    ).toBeVisible();
  },
};
