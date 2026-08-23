import type { Meta, StoryObj } from "@storybook/react-vite";

import { AiModelSelect } from "@/components/AiModelSelect";
import type { AiModelSummary } from "@/shared/types";

const MODELS: AiModelSummary[] = [
  {
    model_id: "model-0198d12345677890abcdef1234567890",
    name: "内容模型",
    litellm_model: "anthropic/claude-sonnet-4-5",
    input_modalities: ["text"],
  },
  {
    model_id: "model-0198d12345677890abcdef1234567891",
    name: "视觉模型",
    litellm_model: "openai/gpt-5.6-terra",
    input_modalities: ["text", "image"],
  },
];

const meta = {
  title: "Components/AiModelSelect",
  component: AiModelSelect,
  args: {
    id: "ai-model",
    label: "执行模型",
    models: MODELS,
    value: MODELS[0].model_id,
    on_change: () => undefined,
    description: "任务只会向后端发送模型标识。",
  },
  decorators: [
    (StoryComponent) => (
      <div className="max-w-sm p-6">
        <StoryComponent />
      </div>
    ),
  ],
} satisfies Meta<typeof AiModelSelect>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Optional: Story = {
  args: { value: null, allow_without_model: true },
};

export const Empty: Story = {
  args: { models: [], value: null },
};
