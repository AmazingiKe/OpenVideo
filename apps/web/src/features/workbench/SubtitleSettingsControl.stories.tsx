import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";

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
    file_export_pending: false,
    file_exported_format: null,
    error_message: null,
    on_change: () => undefined,
    on_export: fn(),
    on_export_file: fn(),
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

export const Default: Story = {
  play: async ({ canvasElement, args, userEvent: user_event }) => {
    await user_event.click(
      within(canvasElement).getByRole("button", { name: "字幕" }),
    );
    const page = within(canvasElement.ownerDocument.body);
    await user_event.click(page.getByRole("radio", { name: "VTT" }));
    await user_event.keyboard("[ArrowRight]");
    await expect(page.getByRole("radio", { name: "TXT" })).toHaveFocus();
    await user_event.keyboard(" ");
    await expect(page.getByRole("radio", { name: "TXT" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await user_event.click(page.getByRole("button", { name: "下载字幕文件" }));
    await expect(args.on_export_file).toHaveBeenCalledWith("txt");
    await expect(args.on_export).not.toHaveBeenCalled();
  },
};

export const Exporting: Story = {
  args: { export_pending: true },
};

export const WithoutTranscript: Story = {
  args: { has_subtitles: false },
  play: async ({ canvasElement, userEvent: user_event }) => {
    await user_event.click(
      within(canvasElement).getByRole("button", { name: "字幕" }),
    );
    const page = within(canvasElement.ownerDocument.body);
    await expect(
      page.getByRole("button", { name: "下载字幕文件" }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "导出带字幕视频" }),
    ).toBeDisabled();
  },
};

export const DownloadingSubtitle: Story = {
  args: { file_export_pending: true },
  play: async ({ canvasElement, userEvent: user_event }) => {
    await user_event.click(
      within(canvasElement).getByRole("button", { name: "字幕" }),
    );
    const page = within(canvasElement.ownerDocument.body);
    await expect(
      page.getByRole("button", { name: "正在下载字幕" }),
    ).toBeDisabled();
    await expect(page.getByRole("radio", { name: "TXT" })).toBeDisabled();
  },
};

export const DownloadStarted: Story = {
  args: { file_exported_format: "srt" },
};

export const ExportError: Story = {
  args: { error_message: "字幕尚未生成，请完成转写后再导出。" },
};
