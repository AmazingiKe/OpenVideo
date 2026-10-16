import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_SUBTITLE_DISPLAY_SETTINGS } from "@/features/player/subtitle_settings";
import { SubtitleSettingsControl } from "./SubtitleSettingsControl";

describe("SubtitleSettingsControl", () => {
  it("returns complete display settings when a preset changes", () => {
    const on_change = vi.fn();
    render(
      <SubtitleSettingsControl
        settings={DEFAULT_SUBTITLE_DISPLAY_SETTINGS}
        has_subtitles
        settings_pending={false}
        export_pending={false}
        export_relative_path={null}
        file_export_pending={false}
        file_exported_format={null}
        on_export_file={vi.fn()}
        error_message={null}
        on_change={on_change}
        on_export={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "字幕" }));
    fireEvent.click(screen.getByRole("radio", { name: "大" }));

    expect(on_change).toHaveBeenCalledWith({
      font_size: "large",
      position: "bottom",
      background: "shadow",
      offset_milliseconds: 0,
    });
  });

  it("starts a standalone subtitled video export", () => {
    const on_export = vi.fn();
    render(
      <SubtitleSettingsControl
        settings={DEFAULT_SUBTITLE_DISPLAY_SETTINGS}
        has_subtitles
        settings_pending={false}
        export_pending={false}
        export_relative_path={null}
        file_export_pending={false}
        file_exported_format={null}
        on_export_file={vi.fn()}
        error_message={null}
        on_change={vi.fn()}
        on_export={on_export}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "字幕" }));
    fireEvent.click(screen.getByRole("button", { name: "导出带字幕视频" }));

    expect(on_export).toHaveBeenCalledOnce();
  });

  it("disables adjustments and export before subtitles exist", () => {
    render(
      <SubtitleSettingsControl
        settings={DEFAULT_SUBTITLE_DISPLAY_SETTINGS}
        has_subtitles={false}
        settings_pending={false}
        export_pending={false}
        export_relative_path={null}
        file_export_pending={false}
        file_exported_format={null}
        on_export_file={vi.fn()}
        error_message={null}
        on_change={vi.fn()}
        on_export={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "字幕" }));

    expect(screen.getByRole("radio", { name: "大" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "导出带字幕视频" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "下载字幕文件" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "SRT" })).toBeDisabled();
  });

  it("downloads the chosen subtitle format without starting video export", () => {
    const on_export_file = vi.fn();
    const on_export = vi.fn();
    render(
      <SubtitleSettingsControl
        settings={DEFAULT_SUBTITLE_DISPLAY_SETTINGS}
        has_subtitles
        settings_pending={false}
        export_pending={false}
        export_relative_path={null}
        file_export_pending={false}
        file_exported_format={null}
        error_message={null}
        on_change={vi.fn()}
        on_export={on_export}
        on_export_file={on_export_file}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "字幕" }));
    fireEvent.click(screen.getByRole("radio", { name: "VTT" }));
    fireEvent.click(screen.getByRole("button", { name: "下载字幕文件" }));
    expect(on_export_file).toHaveBeenCalledWith("vtt");
    expect(on_export).not.toHaveBeenCalled();
  });

  it("locks export and settings during a file download and shows errors", () => {
    render(
      <SubtitleSettingsControl
        settings={DEFAULT_SUBTITLE_DISPLAY_SETTINGS}
        has_subtitles
        settings_pending={false}
        export_pending={false}
        export_relative_path={null}
        file_export_pending
        file_exported_format={null}
        error_message="字幕文件暂时不可用"
        on_change={vi.fn()}
        on_export={vi.fn()}
        on_export_file={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "字幕" }));
    expect(screen.getByRole("button", { name: "正在下载字幕" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "导出带字幕视频" }),
    ).toBeDisabled();
    expect(screen.getByRole("radio", { name: "VTT" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "大" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("字幕文件暂时不可用");
  });
});
