import type { Meta, StoryObj } from "@storybook/react-vite";

import { VisualIndexSettingsPanel } from "./VisualIndexSettings";

const meta = {
  title: "Settings/VisualIndexSettings",
  component: VisualIndexSettingsPanel,
  args: {
    status: {
      state: "not_prepared",
      progress_percent: 0,
      message: "视觉索引尚未准备",
      model_name: "google/siglip2-base-patch16-224",
      model_revision: "997aaec",
      indexed_frames: 0,
      total_frames: 0,
      model_loaded: false,
      error_message: null,
      updated_at: "2026-08-31T10:00:00Z",
    },
    pending: false,
    error: null,
    on_prepare: () => undefined,
    on_unload: () => undefined,
  },
  decorators: [
    (StoryComponent) => (
      <div className="max-w-3xl bg-background p-8 text-foreground">
        <StoryComponent />
      </div>
    ),
  ],
} satisfies Meta<typeof VisualIndexSettingsPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NotPrepared: Story = {};

export const Indexing: Story = {
  args: {
    status: {
      ...meta.args.status,
      state: "indexing",
      progress_percent: 46,
      message: "正在建立画面索引 92/200",
      indexed_frames: 92,
      total_frames: 200,
    },
  },
};

export const ReadyUnloaded: Story = {
  args: {
    status: {
      ...meta.args.status,
      state: "ready",
      progress_percent: 100,
      message: "视觉索引已就绪，共 200 帧",
      indexed_frames: 200,
      total_frames: 200,
    },
  },
};

export const ReadyLoadedDark: Story = {
  args: {
    status: {
      ...meta.args.status,
      state: "ready",
      progress_percent: 100,
      message: "视觉索引已就绪，共 200 帧",
      indexed_frames: 200,
      total_frames: 200,
      model_loaded: true,
    },
  },
  decorators: [
    (StoryComponent) => (
      <div className="dark max-w-3xl bg-background p-8 text-foreground">
        <StoryComponent />
      </div>
    ),
  ],
};
