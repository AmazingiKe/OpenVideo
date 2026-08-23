import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

import { AiModelConfigurationList } from "./AiModelConfigurationList";
import type { AiModelTestResult } from "@/shared/types";

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
    on_test_model: async (): Promise<AiModelTestResult> => ({
      available: true,
      latency_ms: 86,
      message: "模型响应正常",
    }),
    on_change: () => undefined,
  },
} satisfies Meta<typeof AiModelConfigurationList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Empty: Story = { args: { models: [] } };

export const Managed: Story = { args: { managed: true } };

export const Available: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "测试模型" }));
    await expect(canvas.getByText("可用")).toBeInTheDocument();
    await expect(canvas.getByText("延迟 86 ms")).toBeInTheDocument();
  },
};

export const Unavailable: Story = {
  args: {
    on_test_model: async (): Promise<AiModelTestResult> => ({
      available: false,
      latency_ms: 24,
      message: "无法识别 LiteLLM 供应商",
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "测试模型" }));
    await expect(canvas.getByText("不可用")).toBeInTheDocument();
    await expect(
      canvas.getByText("无法识别 LiteLLM 供应商"),
    ).toBeInTheDocument();
  },
};
