import type { Meta, StoryObj } from "@storybook/react-vite";

import { AgentToolTrace } from "./SummaryAgentToolTrace";

const meta = {
  title: "Workbench/AgentToolTrace",
  component: AgentToolTrace,
  args: {
    trace: {
      call_id: "call-1",
      name: "search_video_evidence",
      arguments: { query: "关键结论", limit: 8 },
      result: {
        ok: true,
        evidence: [{ start_seconds: 12, text: "这里给出关键结论。" }],
      },
    },
  },
} satisfies Meta<typeof AgentToolTrace>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Complete: Story = {};

export const Running: Story = {
  args: {
    trace: {
      call_id: "call-2",
      name: "read_summary_document",
      arguments: { document_id: "document-example" },
    },
  },
};
