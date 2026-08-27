import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import {
  AgentArtifactCard,
  AgentRunBadge,
  AgentToolStatusCard,
} from "./AgentPanel";
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
  render: () => <AgentToolStatusCard event={FAILED_TOOL_EVENT} />,
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
