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

export const PreviousLibraryUnavailable: Story = {
  args: { notice: "请选择一个资料库，或选择一个空文件夹创建新的资料库。" },
};
