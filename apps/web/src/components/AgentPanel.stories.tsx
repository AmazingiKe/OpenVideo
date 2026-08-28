import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn } from "storybook/test";

import {
  AgentArtifactCard,
  AgentReasoning,
  AgentRunBadge,
  AgentToolActivity,
} from "./AgentPanelContent";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import type { AgentArtifact, AgentEvent } from "@/shared/types";

const BASE_ARTIFACT: AgentArtifact = {
  artifact_id: "artifact-01890f4c7a2b7cc298c4dc0c0c07398f",
  run_id: "run-01890f4c7a2b7cc298c4dc0c0c07398f",
  session_id: "session-01890f4c7a2b7cc298c4dc0c0c07398f",
  agent_id: "marker",
  asset_id: "asset-01890f4c7a2b7cc298c4dc0c0c07398f",
  result_type: "marker_changes",
  payload: {
    changes: [
      {
        operation: "update",
        before: { title: "旧标题", start_seconds: 18 },
        after: { title: "核心定义", start_seconds: 18, end_seconds: 42 },
        evidence: [{ start_seconds: 18, text: "这里给出正式定义" }],
      },
    ],
  },
  status: "pending",
  error_message: null,
  created_at: "2026-08-27T08:00:00Z",
  updated_at: "2026-08-27T08:00:00Z",
};

const meta = {
  title: "Agents/UnifiedAgentPanel",
  component: AgentArtifactCard,
  decorators: [
    (Story) => (
      <div className="mx-auto w-full max-w-xl bg-background p-4 text-foreground">
        <Story />
      </div>
    ),
  ],
  args: {
    artifact: BASE_ARTIFACT,
    on_seek: fn(),
    on_resolve: fn(),
  },
} satisfies Meta<typeof AgentArtifactCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const MarkerApproval: Story = {};

export const SummaryApproval: Story = {
  args: {
    artifact: {
      ...BASE_ARTIFACT,
      agent_id: "summary",
      result_type: "summary_edit",
      payload: {
        diff: "--- 当前版本\n+++ 建议版本\n-旧结论\n+补充证据后的结论",
      },
    },
  },
};

export const SummaryMediaApproval: Story = {
  args: {
    artifact: {
      ...BASE_ARTIFACT,
      agent_id: "summary",
      result_type: "summary_media",
      payload: {
        media: {
          document_id: "document-01890f4c7a2b7cc298c4dc0c0c07398f",
          expected_revision: 2,
          media_type: "image",
          start_seconds: 126.8,
          end_seconds: null,
          insert_after: "透视投影会把三维点映射到二维平面。",
          caption: "透视投影视锥体示意图",
        },
        reason: "该画面完整展示了正文提到的视锥体结构。",
        confidence: 0.91,
      },
    },
  },
};

export const SummaryMediaApprovalDark: Story = {
  ...SummaryMediaApproval,
  render: (args) => (
    <div className="dark bg-background p-4 text-foreground">
      <AgentArtifactCard {...args} />
    </div>
  ),
};

export const TranscriptApproval: Story = {
  args: {
    artifact: {
      ...BASE_ARTIFACT,
      agent_id: "transcript_correction",
      result_type: "transcript_correction",
      payload: {
        changes: [
          {
            segment_index: 3,
            start_seconds: 12,
            end_seconds: 16,
            before: "开放式到",
            after: "开放视频",
          },
        ],
      },
    },
  },
};

export const StaleApproval: Story = {
  args: {
    artifact: {
      ...BASE_ARTIFACT,
      status: "stale",
      error_message: "原始标记已变化",
    },
  },
};

export const RunStates: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      <AgentRunBadge stage="running" />
      <AgentRunBadge stage="waiting_for_approval" />
      <AgentRunBadge stage="failed" />
      <AgentRunBadge stage="cancelled" />
    </div>
  ),
};

const FAILED_TOOL_EVENT: AgentEvent = {
  event_id: "event-01890f4c7a2b7cc298c4dc0c0c07398f",
  session_id: BASE_ARTIFACT.session_id,
  run_id: BASE_ARTIFACT.run_id,
  sequence: 4,
  event_type: "tool.status",
  payload: {
    name: "inspect_frames",
    stage: "failed",
    result: { ok: false, error_code: "vision_unavailable" },
  },
  created_at: "2026-08-27T08:00:00Z",
};

export const ToolFailure: Story = {
  render: () => <AgentToolActivity events={[FAILED_TOOL_EVENT]} />,
};

export const ToolActivity: Story = {
  render: () => (
    <AgentToolActivity
      events={[
        {
          ...FAILED_TOOL_EVENT,
          event_id: "event-01890f4c7a2b7cc298c4dc0c0c073990",
          sequence: 2,
          payload: {
            call_id: "tool-01890f4c7a2b7cc298c4dc0c0c073990",
            name: "search_evidence",
            stage: "completed",
            result: { matches: 6 },
          },
        },
        {
          ...FAILED_TOOL_EVENT,
          event_id: "event-01890f4c7a2b7cc298c4dc0c0c073991",
          sequence: 3,
          payload: {
            call_id: "tool-01890f4c7a2b7cc298c4dc0c0c073991",
            name: "inspect_frames",
            stage: "completed",
            result: { frames: 4 },
          },
        },
        {
          ...FAILED_TOOL_EVENT,
          event_id: "event-01890f4c7a2b7cc298c4dc0c0c073992",
          sequence: 4,
          payload: {
            call_id: "tool-01890f4c7a2b7cc298c4dc0c0c073992",
            name: "propose_marker_changes",
            stage: "completed",
            result: { changes: 3 },
          },
        },
      ]}
    />
  ),
  play: async ({ canvas, userEvent }) => {
    const trigger = canvas.getByRole("button", {
      name: /工具活动 · 检索视频证据等 3 项/,
    });
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(trigger);
    await expect(canvas.getByText("生成标记变更预览")).toBeVisible();
  },
};

export const DisconnectedRecovery: Story = {
  render: () => (
    <Alert>
      <AlertTitle>连接已中断</AlertTitle>
      <AlertDescription>
        重连会携带最后事件序号，并从断点继续接收。
      </AlertDescription>
    </Alert>
  ),
};

export const CollapsedReasoning: Story = {
  render: () => (
    <AgentReasoning content="正在核对标记范围、转录证据与画面信息。" />
  ),
  play: async ({ canvas }) => {
    await expect(
      canvas.getByRole("button", { name: "思考过程" }),
    ).toHaveAttribute("aria-expanded", "false");
  },
};

export const CollapsedReasoningDark: Story = {
  render: () => (
    <div className="dark bg-background p-4 text-foreground">
      <AgentReasoning content="正在核对标记范围、转录证据与画面信息。" />
    </div>
  ),
};
