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
  });
});
