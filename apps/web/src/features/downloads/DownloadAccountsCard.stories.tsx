import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";

import { DownloadAccountsCard } from "@/features/downloads/DownloadAccountsCard";

const accounts = [
  {
    account_id: "account-0198d12345677890abcdef1234567890",
    platform: "bilibili" as const,
    display_name: "Bilibili 账号",
    status: "available" as const,
    last_tested_at: "2026-08-24T08:30:00Z",
    updated_at: "2026-08-24T08:30:00Z",
  },
  {
    account_id: "account-0198d12345677890abcdef1234567891",
    platform: "douyin" as const,
    display_name: "抖音账号",
    status: "expired" as const,
    last_tested_at: "2026-08-24T08:30:00Z",
    updated_at: "2026-08-24T08:30:00Z",
  },
];

const meta = {
  title: "Downloads/DownloadAccountsCard",
  component: DownloadAccountsCard,
  args: {
    accounts: [],
    loading_platform: null,
    errors: {},
    on_save: async () => undefined,
    on_login: async () => undefined,
    on_cancel_login: async () => undefined,
    on_import_browser: async () => undefined,
    on_test: async () => undefined,
    on_disconnect: async () => undefined,
  },
} satisfies Meta<typeof DownloadAccountsCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Disconnected: Story = {};

export const MixedStatus: Story = {
  args: { accounts },
};

export const Loading: Story = {
  args: {
    accounts,
    loading_platform: "youtube",
  },
};

export const LoginWaiting: Story = {
  args: {
    on_login: () => new Promise<undefined>(() => undefined),
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getAllByRole("button", { name: "连接账号" })[1],
    );
  },
};

export const Dark: Story = {
  args: { accounts },
  decorators: [
    (Story) => (
      <div className="dark min-h-screen bg-background p-4 text-foreground">
        <Story />
      </div>
    ),
  ],
};
