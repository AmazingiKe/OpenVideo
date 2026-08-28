import type { Meta, StoryObj } from "@storybook/react-vite";

import { EventAnalysisCard } from "./EventAnalysisCard";

const meta = {
  title: "Analysis/EventAnalysisCard",
  component: EventAnalysisCard,
  args: {
    on_seek: () => undefined,
    on_delete: () => undefined,
    analysis: {
      event_analysis_id: "event-analysis-0198f000000070008000000000000001",
      asset_id: "asset-0198f000000070008000000000000001",
      target: {
        source: "marker",
        marker_id: "marker-0198f000000070008000000000000001",
        start_seconds: 42,
        end_seconds: 75,
      },
      title: "关键概念的定义与边界",
      conclusion: "这一段先建立概念边界，再通过反例说明常见误区。",
      key_points: ["定义先于案例", "反例用于排除相邻概念"],
      evidence: [
        {
          start_seconds: 48,
          end_seconds: 55,
          text: "讲者给出了概念的必要条件。",
          source: "transcript",
        },
      ],
      preset_id: "course_notes",
      preset_version: 1,
      depth: "balanced",
      user_input: null,
      ai_model_id: "model-1",
      source_summary: {
        transcript_digest: "a",
        target_digest: "b",
        timeline_digest: "c",
      },
      status: "valid",
      created_at: "2026-08-28T00:00:00Z",
      updated_at: "2026-08-28T00:00:00Z",
    },
  },
} satisfies Meta<typeof EventAnalysisCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Stale: Story = {
  args: {
    analysis: { ...meta.args.analysis, status: "stale" },
  },
};
