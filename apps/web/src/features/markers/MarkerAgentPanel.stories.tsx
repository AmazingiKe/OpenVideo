import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";

import { MarkerProposalCard } from "./MarkerAgentPanel";
import type { MarkerProposal } from "@/shared/types";

const ASSET_ID = "asset-01890f4c7a2b7cc298c4dc0c0c07398f";
const POINT_MARKER = {
  marker_id: "marker-01890f4c7a2b7cc298c4dc0c0c07398f",
  asset_id: ASSET_ID,
  start_seconds: 18,
  end_seconds: null,
  title: "核心定义",
  tags: ["概念", "重点"],
};
const RANGE_MARKER = {
  marker_id: "marker-11890f4c7a2b7cc298c4dc0c0c07398f",
  asset_id: ASSET_ID,
  start_seconds: 42,
  end_seconds: 58,
  title: "完整推导过程",
  tags: ["公式"],
};
const PENDING_PROPOSAL: MarkerProposal = {
  proposal_id: "proposal-01890f4c7a2b7cc298c4dc0c0c07398f",
  session_id: "session-01890f4c7a2b7cc298c4dc0c0c07398f",
  asset_id: ASSET_ID,
  status: "pending",
  created_at: "2026-08-24T08:00:00Z",
  changes: [
    {
      operation: "create",
      before: [],
      after: POINT_MARKER,
      reason: "讲者在此处首次给出完整定义。",
      evidence: ["00:18 转录：这里给出正式定义"],
    },
    {
      operation: "update",
      before: [POINT_MARKER],
      after: RANGE_MARKER,
      reason: "单个时间点不足以覆盖完整推导。",
      evidence: ["00:42–00:58 公式推导连续出现"],
    },
    {
      operation: "merge",
      before: [POINT_MARKER, RANGE_MARKER],
      after: { ...RANGE_MARKER, title: "定义与推导" },
      reason: "两个相邻标记属于同一知识单元。",
      evidence: [],
    },
    {
      operation: "delete",
      before: [POINT_MARKER],
      after: null,
      reason: "内容与后续范围标记重复。",
      evidence: [],
    },
  ],
};

const meta = {
  title: "Markers/MarkerProposalCard",
  component: MarkerProposalCard,
  decorators: [
    (Story) => (
      <div className="w-full max-w-96 bg-background p-4 text-foreground">
        <Story />
      </div>
    ),
  ],
  args: {
    proposal: PENDING_PROPOSAL,
    resolving: false,
    on_seek: fn(),
    on_resolve: fn(),
  },
} satisfies Meta<typeof MarkerProposalCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Pending: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "整批接受" }));
    await expect(args.on_resolve).toHaveBeenCalledWith("accept");
  },
};

export const Accepted: Story = {
  args: {
    proposal: { ...PENDING_PROPOSAL, status: "accepted" },
  },
};

export const Stale: Story = {
  args: {
    proposal: { ...PENDING_PROPOSAL, status: "stale" },
  },
};

export const Dark: Story = {
  decorators: [
    (Story) => (
      <div className="dark min-h-screen bg-background">
        <Story />
      </div>
    ),
  ],
};
