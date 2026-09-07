import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, waitFor } from "storybook/test";

import { STORY_ASSETS } from "@/features/library/library_story_fixtures";
import type { SummaryPlayerGeometry } from "@/shared/types";
import { FloatingSummaryPlayer } from "./FloatingSummaryPlayer";

const meta = {
  title: "Summary/FloatingSummaryPlayer",
  component: FloatingSummaryPlayer,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof FloatingSummaryPlayer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Minimized: Story = {
  args: story_args(false),
  render: () => <PlayerStory initial_open={false} />,
  play: async ({ canvas, canvasElement, userEvent }) => {
    const video = canvasElement.querySelector("video");
    const surface = canvasElement.querySelector("section")!;
    // 逐帧采样验证真实过渡，避免只验证最终可见状态而漏掉瞬间跳变。
    canvas.getByRole("button", { name: "参考视频" }).click();
    const opacity_samples: number[] = [];
    for (let frame = 0; frame < 24; frame += 1) {
      await new Promise(requestAnimationFrame);
      opacity_samples.push(Number(getComputedStyle(surface).opacity));
    }
    await expect(opacity_samples.some((value) => value > 0 && value < 1)).toBe(
      true,
    );
    await expect(surface).toHaveAttribute("aria-hidden", "false");
    await userEvent.click(
      canvas.getByRole("button", { name: "最小化参考视频" }),
    );
    await waitFor(() => expect(surface).not.toBeVisible());
    await userEvent.click(canvas.getByRole("button", { name: "参考视频" }));
    await waitFor(() => expect(surface).toBeVisible());
    await expect(canvasElement.querySelector("video")).toBe(video);
  },
};

export const Open: Story = {
  args: story_args(true),
  render: () => <PlayerStory initial_open />,
};

function story_args(open: boolean) {
  return {
    asset: STORY_ASSETS[0],
    geometry: null,
    open,
    on_geometry_change: () => undefined,
    on_open_change: () => undefined,
    transcript: null,
  };
}

function PlayerStory({ initial_open }: { initial_open: boolean }) {
  const [open, set_open] = useState(initial_open);
  const [geometry, set_geometry] = useState<SummaryPlayerGeometry | null>(null);
  return (
    <div className="relative h-screen overflow-hidden bg-background">
      <div className="mx-auto flex h-full max-w-3xl flex-col gap-4 p-8">
        <div className="h-10 rounded-lg bg-muted" />
        <div className="flex-1 rounded-xl border bg-card" />
      </div>
      <FloatingSummaryPlayer
        asset={STORY_ASSETS[0]}
        geometry={geometry}
        open={open}
        on_geometry_change={set_geometry}
        on_open_change={set_open}
        transcript={null}
      />
    </div>
  );
}
