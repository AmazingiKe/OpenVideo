import { useEffect, useState, type ComponentProps } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

import { AiModelConfigurationList } from "./AiModelConfigurationList";
import {
  DEFAULT_MODEL_CAPABILITY_OVERRIDES,
  unknown_model_profile,
  type AiModelTestResult,
} from "@/shared/types";

const PROFILE = {
  ...unknown_model_profile("openai", "gpt-5"),
  capabilities: {
    ...unknown_model_profile("openai", "gpt-5").capabilities,
    tools: "yes" as const,
    vision: "yes" as const,
    streaming_tools: "yes" as const,
    vision_tools: "yes" as const,
  },
  capability_sources: {
    tools: "runtime_probe" as const,
    vision: "runtime_probe" as const,
    streaming_tools: "runtime_probe" as const,
    vision_tools: "runtime_probe" as const,
  },
};

const meta = {
  title: "Settings/AiModelConfigurationList",
  component: AiModelConfigurationList,
  args: {
    models: [
      {
        model_id: "model-0198d12345677890abcdef1234567890",
        name: "在线视觉模型",
        litellm_model: "openai/gpt-5",
        api_key: "secret",
        api_base: null,
        api_version: null,
        input_modalities: ["text", "image", "audio", "video"],
        capabilities: { ...DEFAULT_MODEL_CAPABILITY_OVERRIDES },
      },
    ],
    profiles: { "model-0198d12345677890abcdef1234567890": PROFILE },
    managed: false,
    on_test_model: async (): Promise<AiModelTestResult> => ({
      available: true,
      latency_ms: 86,
      message: "模型响应正常",
      capabilities: {
        text: {
          support: "yes",
          source: "runtime_probe",
          tested: true,
          message: "文本响应正常",
        },
        tools: {
          support: "yes",
          source: "runtime_probe",
          tested: true,
          message: "基础工具调用正常",
        },
        vision: {
          support: "yes",
          source: "runtime_probe",
          tested: true,
          message: "图片输入正常",
        },
      },
      profile: PROFILE,
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

export const LegacyLocalModel: Story = {
  args: {
    models: [
      {
        ...meta.args.models[0],
        name: "旧本地模型",
        litellm_model: "ollama/qwen2.5-vl",
        api_key: null,
        api_base: "http://127.0.0.1:11434",
      },
    ],
  },
};

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
      capabilities: {
        text: {
          support: "no",
          source: "runtime_probe",
          tested: true,
          message: "文本连接失败",
        },
      },
      profile: unknown_model_profile("unknown", "invalid"),
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
