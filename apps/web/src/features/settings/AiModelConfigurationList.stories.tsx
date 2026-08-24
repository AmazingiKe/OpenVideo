import { useEffect, useState, type ComponentProps } from "react";
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
        tool_calling_mode: "auto",
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

function WithDarkMode({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    document.documentElement.classList.add("dark");
    return () => document.documentElement.classList.remove("dark");
  }, []);

  return children;
}

function InteractiveAiModelConfigurationList(
  props: ComponentProps<typeof AiModelConfigurationList>,
) {
  const [models, set_models] = useState(props.models);
  return (
    <AiModelConfigurationList
      {...props}
      models={models}
      on_change={set_models}
    />
  );
}

export const Default: Story = {};

export const Empty: Story = { args: { models: [] } };

export const Managed: Story = { args: { managed: true } };

export const Available: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "测试" }));
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
    await userEvent.click(canvas.getByRole("button", { name: "测试" }));
    await expect(canvas.getByText("不可用")).toBeInTheDocument();
    await expect(
      canvas.getByText("无法识别 LiteLLM 供应商"),
    ).toBeInTheDocument();
  },
};

export const AddDialog: Story = {
  args: { models: [] },
  render: (args) => <InteractiveAiModelConfigurationList {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "添加模型" }));
    const dialog = within(document.body).getByRole("dialog", {
      name: "添加 AI 模型",
    });
    await expect(dialog).toBeInTheDocument();
    await expect(within(dialog).getByLabelText("显示名称")).toHaveFocus();
    await userEvent.type(within(dialog).getByLabelText("显示名称"), "视觉模型");
    await userEvent.type(
      within(dialog).getByLabelText("LiteLLM 模型"),
      "openai/gpt-5",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "图片" }));
    await userEvent.click(
      within(dialog).getByRole("button", { name: "确认添加" }),
    );
    await expect(canvas.getByText("视觉模型")).toBeInTheDocument();
    await expect(canvas.getByText("openai/gpt-5")).toBeInTheDocument();
    await expect(canvas.getByText("图片")).toBeInTheDocument();
  },
};

export const DarkAddDialog: Story = {
  args: { models: [] },
  render: AddDialog.render,
  decorators: [
    (StoryComponent) => (
      <WithDarkMode>
        <StoryComponent />
      </WithDarkMode>
    ),
  ],
  play: AddDialog.play,
};
