import type { Meta, StoryObj } from "@storybook/react-vite";
import { Download } from "lucide-react";

import { Button } from "./button";

const meta = {
  title: "Design System/Button",
  component: Button,
  args: {
    children: "开始分析",
  },
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof Button>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Primary: Story = {};

export const Secondary: Story = {
  args: {
    variant: "secondary",
  },
};

export const WithIcon: Story = {
  render: (args) => (
    <Button {...args}>
      <Download data-icon="inline-start" />
      下载结果
    </Button>
  ),
};

export const Disabled: Story = {
  args: {
    disabled: true,
  },
};
