import type { Meta, StoryObj } from "@storybook/react-vite";

import { AiModelConfigurationList } from "./AiModelConfigurationList";

const meta = {
  title: "Settings/AiModelConfigurationList",
  component: AiModelConfigurationList,
  args: {
    models: [
      {
        model_id: "model-0198d12345677890abcdef1234567890",
        name: "本地视觉模型",
        litellm_model: "ollama/qwen2.5-vl",
        api_key: null,
        api_base: "http://127.0.0.1:11434",
        api_version: null,
        input_modalities: ["text", "image", "audio", "video"],
      },
    ],
    managed: false,
    on_change: () => undefined,
  },
} satisfies Meta<typeof AiModelConfigurationList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Empty: Story = { args: { models: [] } };

export const Managed: Story = { args: { managed: true } };
