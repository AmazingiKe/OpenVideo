import type { Meta, StoryObj } from "@storybook/react-vite";
import { RefreshCw, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { SummaryEmpty } from "./SummaryWorkspacePanels";

const meta = {
  title: "Summary/EmptyState",
  component: SummaryEmpty,
  args: {
    title: "尚未选择素材",
    description: "请先在标记页选择一个已下载的视频。",
  },
  parameters: { layout: "fullscreen" },
  decorators: [
    (StoryComponent) => (
      <div className="min-h-screen bg-background text-foreground">
        <StoryComponent />
      </div>
    ),
  ],
} satisfies Meta<typeof SummaryEmpty>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const LoadError: Story = {
  args: {
    title: "总结项目暂时无法加载",
    description: "总结索引暂时无法恢复，请稍后重试",
    icon: TriangleAlert,
    action: (
      <Button type="button" variant="outline">
        <RefreshCw data-icon="inline-start" />
        重新加载
      </Button>
    ),
  },
};

export const Retrying: Story = {
  args: {
    ...LoadError.args,
    action: (
      <Button type="button" variant="outline" disabled>
        <Spinner data-icon="inline-start" />
        正在重试
      </Button>
    ),
  },
};

export const Dark: Story = {
  ...LoadError,
  decorators: [
    (StoryComponent) => (
      <div className="dark min-h-screen bg-background text-foreground">
        <StoryComponent />
      </div>
    ),
  ],
};
