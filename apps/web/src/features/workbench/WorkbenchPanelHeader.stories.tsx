import type { Meta, StoryObj } from "@storybook/react-vite";
import { LibraryBig } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { WorkbenchPanelHeader } from "./WorkbenchPanelHeader";

const meta = {
  title: "Analysis/WorkbenchPanelHeader",
  component: WorkbenchPanelHeader,
  args: {
    icon: LibraryBig,
    title: "已下载视频",
    accessory: <Badge variant="secondary">12</Badge>,
    collapse_direction: "left",
    collapse_label: "收起视频库",
    on_collapse: () => undefined,
  },
  decorators: [
    (StoryComponent) => (
      <div className="w-72 overflow-hidden border bg-card">
        <StoryComponent />
      </div>
    ),
  ],
} satisfies Meta<typeof WorkbenchPanelHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
