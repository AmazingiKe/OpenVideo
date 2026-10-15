import { useState, type ComponentProps } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { BailianAsrSettings } from "./BailianAsrSettings";

const meta = {
  title: "Settings/BailianAsrSettings",
  component: BailianAsrSettings,
  args: {
    value: { region: "beijing", api_key_configured: false },
    on_save: async () => ({ region: "beijing", api_key_configured: true }),
    on_test: async () => ({
      configured: true,
      message: "百炼鉴权与上传凭证正常。",
    }),
  },
  render: (args) => <InteractiveBailianAsrSettings {...args} />,
  decorators: [
    (StoryComponent) => (
      <div className="mx-auto max-w-4xl p-8">
        <StoryComponent />
      </div>
    ),
  ],
} satisfies Meta<typeof BailianAsrSettings>;

export default meta;
type Story = StoryObj<typeof meta>;

function InteractiveBailianAsrSettings(
  props: ComponentProps<typeof BailianAsrSettings>,
) {
  const [value, set_value] = useState(props.value);
  return (
    <BailianAsrSettings
      {...props}
      value={value}
      on_save={async (update) => {
        const next = {
          region: update.region ?? value.region,
          api_key_configured:
            update.api_key === undefined
              ? value.api_key_configured
              : Boolean(update.api_key),
        };
        set_value(next);
        return next;
      }}
    />
  );
}

export const NotConfigured: Story = {};
export const Configured: Story = {
  args: { value: { region: "beijing", api_key_configured: true } },
};
export const Singapore: Story = {
  args: { value: { region: "singapore", api_key_configured: true } },
};
export const ConnectionFailure: Story = {
  args: {
    value: { region: "beijing", api_key_configured: true },
    on_test: async () => {
      throw new Error("密钥无效或服务区域不匹配。");
    },
  },
};
