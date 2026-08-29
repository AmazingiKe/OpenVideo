import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import { AgentContextSource } from "./AgentContextSource";

const meta = {
  title: "Agent/AgentContextSource",
  component: AgentContextSource,
  args: {
    attachment: {
      draft_id: "attachment-draft-0198d12345677890abcdef1234567890",
      kind: "time_range",
      asset_id: "asset-0198d12345677890abcdef1234567890",
      label: "时间线理解范围",
      start_seconds: 62,
      end_seconds: 91,
    },
    on_add: fn(),
  },
} satisfies Meta<typeof AgentContextSource>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
