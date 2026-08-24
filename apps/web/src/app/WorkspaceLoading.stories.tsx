import type { Meta, StoryObj } from "@storybook/react-vite";

import { WorkspaceLoading } from "./WorkspaceLoading";

const meta = {
  title: "App/WorkspaceLoading",
  component: WorkspaceLoading,
  decorators: [
    (StoryComponent) => (
      <div className="h-[640px] overflow-hidden">
        <StoryComponent />
      </div>
    ),
  ],
} satisfies Meta<typeof WorkspaceLoading>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Narrow: Story = {
  globals: {
    viewport: { value: "mobile1", isRotated: false },
  },
};
