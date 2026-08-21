import type { Meta, StoryObj } from "@storybook/react-vite";

import { LibraryPathForm } from "@/features/library/LibraryPathForm";

const meta = {
  title: "Library/LibraryPathForm",
  component: LibraryPathForm,
  args: { action: "open", on_success: () => undefined },
} satisfies Meta<typeof LibraryPathForm>;

export default meta;
type Story = StoryObj<typeof meta>;

export const OpenExisting: Story = {};

export const CreateInParent: Story = { args: { action: "parent" } };

export const ManagedByEnvironment: Story = { args: { disabled: true } };
