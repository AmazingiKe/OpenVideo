import { useEffect, useState, type ComponentProps } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

import { AgentPreferencesSettings } from "./AgentPreferencesSettings";
import {
  DEFAULT_MODEL_CAPABILITY_OVERRIDES,
  type AgentPreferences,
  type AiModelConfiguration,
} from "@/shared/types";

const MODELS: AiModelConfiguration[] = [
  {
    model_id: "model-0198d12345677890abcdef1234567890",
    name: "快速文本模型",
    litellm_model: "openai/gpt-5-mini",
    api_key: null,
    api_base: null,
    api_version: null,
    input_modalities: ["text"],
    capabilities: { ...DEFAULT_MODEL_CAPABILITY_OVERRIDES },
  },
  {
    model_id: "model-0198d12345677890abcdef1234567891",
    name: "复杂视觉模型",
    litellm_model: "openai/gpt-5",
    api_key: null,
    api_base: null,
    api_version: null,
    input_modalities: ["text", "image", "video"],
    capabilities: { ...DEFAULT_MODEL_CAPABILITY_OVERRIDES },
  },
];

const DEFAULT_PREFERENCES: AgentPreferences = {
  permission_mode: "smart_approval",
  fast_model_id: MODELS[0].model_id,
  complex_model_id: MODELS[1].model_id,
  vision_model_id: MODELS[1].model_id,
  default_thinking_mode: "auto",
  max_concurrent_runs: 4,
  always_allowed_grants: [],
};

const meta = {
  title: "Settings/AgentPreferencesSettings",
  component: AgentPreferencesSettings,
  parameters: { layout: "padded" },
  args: {
    value: DEFAULT_PREFERENCES,
    models: MODELS,
    on_change: () => undefined,
  },
  render: (args) => <InteractiveAgentPreferencesSettings {...args} />,
} satisfies Meta<typeof AgentPreferencesSettings>;

export default meta;
type Story = StoryObj<typeof meta>;

function InteractiveAgentPreferencesSettings(
  props: ComponentProps<typeof AgentPreferencesSettings>,
) {
  const [value, set_value] = useState(props.value);
  return (
    <AgentPreferencesSettings {...props} value={value} on_change={set_value} />
  );
}

function WithDarkMode({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    document.documentElement.classList.add("dark");
    return () => document.documentElement.classList.remove("dark");
  }, []);
  return children;
}

export const Default: Story = {};

export const FullAccessWarning: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("radio", { name: "完全访问" }));
    await expect(
      canvas.getByText("完全访问会跳过逐次批准"),
    ).toBeInTheDocument();
  },
};

export const EmptyModels: Story = {
  args: {
    models: [],
    value: {
      ...DEFAULT_PREFERENCES,
      fast_model_id: null,
      complex_model_id: null,
      vision_model_id: null,
    },
  },
};

export const WithPersistentGrant: Story = {
  args: {
    value: {
      ...DEFAULT_PREFERENCES,
      always_allowed_grants: [
        {
          grant_id: "grant-0198d12345677890abcdef1234567892",
          capability: "artifact.apply.summary_edit",
          resource_scope: "current_item",
          resource_id: "0198d123-4567-7890-abcd-ef1234567890",
          scope: "always",
          request_id: null,
          session_id: null,
        },
      ],
    },
  },
};

export const Mobile: Story = {
  parameters: { viewport: { defaultViewport: "mobile1" } },
};

export const Dark: Story = {
  decorators: [
    (Story) => (
      <WithDarkMode>
        <Story />
      </WithDarkMode>
    ),
  ],
};
