import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";

import { Card } from "@/components/ui/card";
import { DownloadSelection } from "@/features/downloads/DownloadSelection";
import type { ProbeResponse } from "@/shared/types";

const probe_result: ProbeResponse = {
  platform: "bilibili",
  is_playlist: true,
  title: "Blender 动画基础课程",
  entries: [
    {
      source_video_id: "BV1xx411c7mD_p1",
      url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
      title: "01 · 界面与基础操作",
      duration_seconds: 725,
      uploader: "OpenVideo Academy",
    },
    {
      source_video_id: "BV1xx411c7mD_p2",
      url: "https://www.bilibili.com/video/BV1xx411c7mD?p=2",
      title: "02 · 建模工作流与常用快捷键",
      duration_seconds: 1046,
      uploader: "OpenVideo Academy",
    },
    {
      source_video_id: "BV1xx411c7mD_p3",
      url: "https://www.bilibili.com/video/BV1xx411c7mD?p=3",
      title: "03 · 材质、灯光和最终渲染",
      duration_seconds: 932,
      uploader: "OpenVideo Academy",
    },
  ],
  truncated: false,
  total_count: 3,
};

const meta = {
  title: "Downloads/DownloadSelection",
  component: DownloadSelection,
  decorators: [
    (Story) => (
      <Card className="mx-auto max-w-5xl">
        <Story />
      </Card>
    ),
  ],
  args: {
    probe_result,
    visible_entries: probe_result.entries,
    selected_urls: new Set([probe_result.entries[0].url]),
    folders: [],
    target_folder_id: undefined,
    video_quality: "best",
    current_source_video_id: probe_result.entries[0].source_video_id,
    current_entry_url: probe_result.entries[0].url,
    entry_filter: "",
    is_submitting: false,
    on_entry_filter_change: () => undefined,
    on_toggle_url: () => undefined,
    on_replace_selection: () => undefined,
    on_target_folder_change: () => undefined,
    on_video_quality_change: () => undefined,
    on_start_download: () => undefined,
  },
} satisfies Meta<typeof DownloadSelection>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ListView: Story = {};

export const CardView: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("radio", { name: "卡片视图" }),
    );
  },
};

export const Narrow: Story = {
  globals: {
    viewport: { value: "mobile1", isRotated: false },
  },
};

export const Dark: Story = {
  decorators: [
    (Story) => (
      <div className="dark min-h-screen bg-background p-4 text-foreground">
        <Story />
      </div>
    ),
  ],
};
