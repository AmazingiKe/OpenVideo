import type { Meta, StoryObj } from "@storybook/react-vite";
import { MemoryRouter } from "react-router-dom";

import { Topbar } from "@/app/Topbar";

const meta = {
  title: "App/Topbar",
  component: Topbar,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Topbar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const DownloadsActive: Story = {
  decorators: [
    (StoryComponent) => (
      <MemoryRouter initialEntries={["/downloads"]}>
        <StoryComponent />
      </MemoryRouter>
    ),
  ],
};

export const SettingsActive: Story = {
  decorators: [
    (StoryComponent) => (
      <MemoryRouter initialEntries={["/settings"]}>
        <StoryComponent />
      </MemoryRouter>
    ),
  ],
};
