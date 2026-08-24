import type { Meta, StoryObj } from "@storybook/react-vite";

import { LibraryIndexIssuesAlert } from "@/features/library/LibraryIndexIssuesAlert";

const meta = {
  title: "Library/LibraryIndexIssuesAlert",
  component: LibraryIndexIssuesAlert,
  parameters: { layout: "padded" },
} satisfies Meta<typeof LibraryIndexIssuesAlert>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SingleIssue: Story = {
  args: {
    issues: [
      {
        asset_id: "01890f4c-7a2b-7cc2-98c4-dc0c0c07398f",
        relative_path:
          "assets/01890f4c-7a2b-7cc2-98c4-dc0c0c07398f/artifacts/timeline.json",
        code: "invalid_json",
        message: "JSON 内容无效",
      },
    ],
  },
};

export const MultipleIssues: Story = {
  args: {
    issues: [
      ...SingleIssue.args!.issues!,
      {
        asset_id: null,
        relative_path: "assets/not-an-asset",
        code: "invalid_asset_id",
        message: "素材目录名必须是 UUIDv7",
      },
    ],
  },
};

export const Dark: Story = {
  ...MultipleIssues,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="dark min-h-screen bg-background p-4 text-foreground">
        <Story />
      </div>
    ),
  ],
};
