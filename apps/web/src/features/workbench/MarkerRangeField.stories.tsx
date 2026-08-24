import type { Meta, StoryObj } from "@storybook/react-vite";

import { MarkerRangeField } from "./MarkerRangeField";

const meta = {
  title: "Workbench/MarkerRangeField",
  component: MarkerRangeField,
  parameters: { layout: "centered" },
  decorators: [
    (Story) => (
      <div className="w-80 rounded-lg border bg-card p-4 text-card-foreground">
        <Story />
      </div>
    ),
  ],
  args: {
    id: "marker-range",
    label: "向前范围",
    default_value: 10,
    on_change: () => undefined,
  },
} satisfies Meta<typeof MarkerRangeField>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Inherited: Story = {
  args: { value: null },
};

export const Overridden: Story = {
  args: { value: 25 },
};

export const Disabled: Story = {
  args: { value: null, disabled: true },
};

export const Dark: Story = {
  args: { value: 25 },
  decorators: [
    (Story) => (
      <div className="dark rounded-xl bg-background p-8 text-foreground">
        <Story />
      </div>
    ),
  ],
};
