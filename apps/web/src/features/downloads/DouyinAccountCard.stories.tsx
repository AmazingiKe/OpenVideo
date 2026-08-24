import type { Meta, StoryObj } from "@storybook/react-vite";

import { DouyinAccountCard } from "@/features/downloads/DouyinAccountCard";

const meta = {
  title: "Downloads/DouyinAccountCard",
  component: DouyinAccountCard,
  args: {
    account: null,
    is_loading: false,
    error: null,
    on_save: async () => undefined,
    on_import_browser: async () => undefined,
    on_test: async () => undefined,
    on_disconnect: async () => undefined,
  },
} satisfies Meta<typeof DouyinAccountCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Disconnected: Story = {};

export const Available: Story = {
  args: {
    account: {
      account_id: "account-0198d12345677890abcdef1234567890",
      platform: "douyin",
      display_name: "抖音账号",
      status: "available",
      last_tested_at: "2026-08-24T08:30:00Z",
      updated_at: "2026-08-24T08:30:00Z",
    },
  },
};

export const Expired: Story = {
  args: {
    account: {
      account_id: "account-0198d12345677890abcdef1234567890",
      platform: "douyin",
      display_name: "抖音账号",
      status: "expired",
      last_tested_at: "2026-08-24T08:30:00Z",
      updated_at: "2026-08-24T08:30:00Z",
    },
  },
};

export const Dark: Story = {
  ...Available,
  decorators: [
    (Story) => (
      <div className="dark min-h-screen bg-background p-4 text-foreground">
        <Story />
      </div>
    ),
  ],
};
