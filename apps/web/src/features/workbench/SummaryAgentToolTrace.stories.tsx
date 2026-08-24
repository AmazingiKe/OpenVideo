import type { Meta, StoryObj } from "@storybook/react-vite";

import { SummaryAgentToolTrace } from "./SummaryAgentToolTrace";

const meta = {
  title: "Workbench/SummaryAgentToolTrace",
  component: SummaryAgentToolTrace,
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
} satisfies Meta<typeof SummaryAgentToolTrace>;

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
