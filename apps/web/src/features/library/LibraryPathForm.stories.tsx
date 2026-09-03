import type { Meta, StoryObj } from "@storybook/react-vite";

import { LibraryPathForm } from "@/features/library/LibraryPathForm";

const meta = {
  title: "Library/LibraryPathForm",
  component: LibraryPathForm,
  args: { on_success: () => undefined },
} satisfies Meta<typeof LibraryPathForm>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const ManagedByEnvironment: Story = { args: { disabled: true } };

export const Dark: Story = {
  render: (args) => (
    <div className="dark min-h-screen bg-background p-4 text-foreground">
      <LibraryPathForm {...args} />
    </div>
  ),
};
