import type { Meta, StoryObj } from "@storybook/react-vite";

import { DEFAULT_SUBTITLE_DISPLAY_SETTINGS } from "@/features/player/subtitle_settings";
import { SubtitleSettingsControl } from "./SubtitleSettingsControl";

const meta = {
  title: "Workbench/SubtitleSettingsControl",
  component: SubtitleSettingsControl,
  args: {
    settings: DEFAULT_SUBTITLE_DISPLAY_SETTINGS,
    has_subtitles: true,
    settings_pending: false,
    export_pending: false,
    export_relative_path: null,
    error_message: null,
    on_change: () => undefined,
    on_export: () => undefined,
  },
  decorators: [
    (StoryComponent) => (
      <div className="flex min-h-80 justify-end bg-background p-8 text-foreground">
        <StoryComponent />
      </div>
    ),
  ],
} satisfies Meta<typeof SubtitleSettingsControl>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Exporting: Story = {
  args: { export_pending: true },
};

export const WithoutTranscript: Story = {
  args: { has_subtitles: false },
};
