import type { Meta, StoryObj } from "@storybook/react-vite";
import { Badge } from "@/components/ui/badge";
import { ScanSearch } from "lucide-react";

import { PageHeader } from "./PageHeader";

const meta = {
  title: "Design System/PageHeader",
  component: PageHeader,
  args: {
    title_id: "page_title",
    eyebrow: "视频分析",
    title: "分析视频内容",
    description: "选择视频、生成转录，并把关键内容整理为结构化片段。",
    icon: ScanSearch,
  },
  parameters: { layout: "padded" },
} satisfies Meta<typeof PageHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithAction: Story = {
  args: { action: <Badge variant="outline">本地处理</Badge> },
};
