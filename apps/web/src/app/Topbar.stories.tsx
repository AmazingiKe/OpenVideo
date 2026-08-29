import type { Meta, StoryObj } from "@storybook/react-vite";

import { Topbar } from "@/app/Topbar";

const meta = {
  title: "App/Topbar",
  component: Topbar,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Topbar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const DownloadsActive: Story = {
  parameters: { route: "/downloads" },
};

export const SettingsActive: Story = {
  parameters: { route: "/settings" },
};
