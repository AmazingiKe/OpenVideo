import type { Meta, StoryObj } from "@storybook/react-vite";

import { FloatingError } from "./FloatingError";

const meta = {
  title: "Design System/FloatingError",
  component: FloatingError,
  args: { message: "视频处理失败，请检查服务状态后重试。" },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof FloatingError>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
