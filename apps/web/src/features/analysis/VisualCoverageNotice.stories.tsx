import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { VisualCoverageNotice } from "./VisualCoverageNotice";
import {
  create_coverage_segment,
  MIXED_VISUAL_COVERAGE_SEGMENTS,
} from "./visual_coverage_story_fixtures";

const meta = {
  title: "Analysis/VisualCoverageNotice",
  component: VisualCoverageNotice,
  parameters: { layout: "padded" },
  args: { segments: MIXED_VISUAL_COVERAGE_SEGMENTS },
} satisfies Meta<typeof VisualCoverageNotice>;

export default meta;
type Story = StoryObj<typeof meta>;

export const MixedResults: Story = {
  play: async ({ canvasElement }) => {
    const notice = within(canvasElement).getByRole("status", {
      name: "画面分析覆盖",
    });
    await expect(notice).toHaveTextContent("视觉采样 1 / 6 章 · 2 帧");
    await expect(notice).toHaveTextContent("视觉分析失败 1 章");
    await expect(notice).toHaveTextContent("不代表逐帧理解");
  },
};

export const AllSampled: Story = {
  args: { segments: [create_coverage_segment("sampled")] },
};

export const LegacyUnknown: Story = {
  args: { segments: [create_coverage_segment(undefined)] },
};

export const NotRequested: Story = {
  args: { segments: [create_coverage_segment("not_requested")] },
};

export const MissingFrames: Story = {
  args: { segments: [create_coverage_segment("no_frames")] },
};

export const Empty: Story = { args: { segments: [] } };
