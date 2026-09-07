import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { Topbar } from "@/app/Topbar";

const meta = {
  title: "App/Topbar",
  component: Topbar,
  parameters: { layout: "fullscreen" },
  beforeEach() {
    window.localStorage.clear();
    return () => {
      window.localStorage.clear();
    };
  },
} satisfies Meta<typeof Topbar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const DownloadsActive: Story = {
  parameters: { route: "/library" },
};

export const SettingsActive: Story = {
  parameters: { route: "/settings" },
};

export const SingleTheme: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.queryByRole("button", { name: /切换到.*模式/ })).toBeNull();
    const theme = getComputedStyle(document.documentElement);
    expect(theme.colorScheme).toBe("dark");
    expect(theme.getPropertyValue("--background").trim()).toBe(
      theme.getPropertyValue("--timeline-color-canvas-background").trim(),
    );
  },
};
