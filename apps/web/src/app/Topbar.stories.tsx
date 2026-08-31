import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

import { Topbar } from "@/app/Topbar";

const meta = {
  title: "App/Topbar",
  component: Topbar,
  parameters: { layout: "fullscreen" },
  beforeEach() {
    window.localStorage.clear();
    document.documentElement.classList.remove("dark");
    document.documentElement.removeAttribute("data-color-scheme-source");
    return () => {
      window.localStorage.clear();
      document.documentElement.classList.remove("dark");
      document.documentElement.removeAttribute("data-color-scheme-source");
    };
  },
} satisfies Meta<typeof Topbar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const DownloadsActive: Story = {
  parameters: { route: "/downloads" },
};

export const SettingsActive: Story = {
  parameters: { route: "/settings" },
};

export const ThemeToggle: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "切换到深色模式" }),
    );
    await expect(
      canvas.getByRole("button", { name: "切换到浅色模式" }),
    ).toHaveAttribute("aria-pressed", "true");
  },
};
