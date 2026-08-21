import type { Meta, StoryObj } from "@storybook/react-vite";

import { LibrarySetup } from "@/features/library/LibrarySetup";

const meta = {
  title: "Library/LibrarySetup",
  component: LibrarySetup,
  args: { on_library_opened: () => undefined },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof LibrarySetup>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Idle: Story = {};

export const InvalidPreviousLibrary: Story = {
  args: { error: "上次打开的目录已移动或不再是有效资料库。" },
};
