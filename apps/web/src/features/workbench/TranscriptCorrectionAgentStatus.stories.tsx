import type { Meta, StoryObj } from "@storybook/react-vite";

import { TranscriptCorrectionAgentStatus } from "./TranscriptCorrectionAgentStatus";

const meta = {
  title: "Workbench/TranscriptCorrectionAgentStatus",
  component: TranscriptCorrectionAgentStatus,
  args: {
    models: [
      {
        model_id: "model-019c0000000070008000000000000000",
        name: "长上下文模型",
        litellm_model: "openai/example",
        input_modalities: ["text"],
      },
    ],
    replacement_model_id: "model-019c0000000070008000000000000000",
    on_replacement_model_change: () => undefined,
    on_response: () => undefined,
  },
} satisfies Meta<typeof TranscriptCorrectionAgentStatus>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ContextLimit: Story = {
  args: {
    job: {
      job_id: "agent-019c0000000070008000000000000000",
      asset_id: "019c0000-0000-7000-8000-000000000000",
      agent_type: "transcript_correction",
      execution_mode: "automatic",
      stage: "waiting_for_input",
      progress_percent: 35,
      message: "当前模型无法容纳完整转录",
      ai_model_id: "model-019c0000000070008000000000000000",
      segment_indices: null,
      transcript_checksum: "checksum",
      question: {
        question_id: "question-019c0000000070008000000000000000",
        question_type: "context_limit",
        message: "当前模型无法容纳完整转录，请选择后续处理方式。",
        actions: ["change_model", "chunk", "compress", "cancel"],
      },
      error_message: null,
      created_at: "2026-08-24T00:00:00Z",
      updated_at: "2026-08-24T00:00:00Z",
    },
  },
};

export const TranscriptChanged: Story = {
  args: {
    job: {
      ...ContextLimit.args!.job!,
      question: {
        question_id: "question-019c0000000070008000000000000001",
        question_type: "transcript_changed",
        message: "任务运行期间转录已被修改。",
        actions: ["rerun_latest", "cancel"],
      },
    },
  },
};

export const DarkContextLimit: Story = {
  args: ContextLimit.args,
  decorators: [
    (StoryComponent) => (
      <div className="dark min-h-screen bg-background p-4 text-foreground">
        <StoryComponent />
      </div>
    ),
  ],
};
