import type { Meta, StoryObj } from "@storybook/react-vite";

import { Slider } from "./slider";

const meta = {
  title: "Design System/Slider",
  component: Slider,
  args: {
    "aria-label": "音量",
    defaultValue: [50],
    max: 100,
    step: 1,
  },
  parameters: {
    layout: "centered",
  },
  render: (args) => (
    <div className="w-64">
      <Slider {...args} />
    </div>
  ),
} satisfies Meta<typeof Slider>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Disabled: Story = {
  args: {
    disabled: true,
  },
};
