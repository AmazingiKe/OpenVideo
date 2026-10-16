import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";

import { RecentVideos } from "./RecentVideos";
import { STORY_ASSETS } from "./library_story_fixtures";

const RECENT_ASSETS = STORY_ASSETS.map((asset, index) => ({
  ...asset,
  playback: {
    position_seconds: index === 0 ? 360 : 960,
    playback_rate: index === 0 ? 1.5 : 1,
    last_watched_at: "2026-10-17T00:00:00Z",
  },
}));

const meta = {
  title: "Library/RecentVideos",
  component: RecentVideos,
  parameters: { layout: "padded" },
  args: { assets: RECENT_ASSETS, on_open: fn(), on_retry: fn() },
} satisfies Meta<typeof RecentVideos>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Recent: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const resume = canvas.getByRole("button", {
      name: `继续观看：${RECENT_ASSETS[0].title}`,
    });
    await userEvent.tab();
    await expect(resume).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await expect(args.on_open).toHaveBeenCalledWith(RECENT_ASSETS[0]);
    await expect(
      canvas.getByRole("button", {
        name: `重新观看：${RECENT_ASSETS[1].title}`,
      }),
    ).toBeVisible();
  },
};

export const LongTitle: Story = {
  args: {
    assets: [
      {
        ...RECENT_ASSETS[0],
        title:
          "从镜头语言理解电影叙事：长视频课程中的构图、景别与光影，以及每个细节如何讲述故事",
        author_name: "开放影像课程与视听语言研究工作室",
        duration_seconds: null,
      },
    ],
  },
};

export const EmptyHistory: Story = { args: { assets: [] } };
export const Loading: Story = { args: { assets: [], loading: true } };
export const Failed: Story = {
  args: { assets: [], error: "资料库暂时无法访问，请检查外部存储。" },
  play: async ({ canvasElement, args }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "重试" }),
    );
    await expect(args.on_retry).toHaveBeenCalledOnce();
  },
};
