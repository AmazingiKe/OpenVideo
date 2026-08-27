import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DownloadSelection } from "@/features/downloads/DownloadSelection";
import type { ProbeResponse } from "@/shared/types";

const PROBE_RESULT: ProbeResponse = {
  platform: "bilibili",
  is_playlist: true,
  title: "课程第一季",
  entries: [
    {
      source_video_id: "BV1xx411c7mD_p1",
      url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
      title: "第一集",
      duration_seconds: 60,
      uploader: "讲师",
    },
  ],
  truncated: false,
  total_count: 1,
};

describe("DownloadSelection", () => {
  it("defaults playlist downloads to automatic classification", () => {
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    const on_video_quality_change = vi.fn();
    render(
      <DownloadSelection
        probe_result={PROBE_RESULT}
        visible_entries={PROBE_RESULT.entries}
        selected_urls={new Set([PROBE_RESULT.entries[0].url])}
        folders={[]}
        target_folder_id={undefined}
        video_quality="best"
        current_source_video_id={null}
        current_entry_url={null}
        entry_filter=""
        is_submitting={false}
        on_entry_filter_change={vi.fn()}
        on_toggle_url={vi.fn()}
        on_replace_selection={vi.fn()}
        on_target_folder_change={vi.fn()}
        on_video_quality_change={on_video_quality_change}
        on_start_download={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("combobox", { name: "目标文件夹" }),
    ).toHaveTextContent("自动分类（按合集名称）");
    expect(
      screen.getByRole("combobox", { name: "视频清晰度" }),
    ).toHaveTextContent("最佳画质（推荐）");
    expect(
      screen.getByRole("radiogroup", { name: "视频列表显示方式" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "卡片视图" }));
    expect(
      screen.getByRole("list", { name: "卡片视图中的可下载视频" }),
    ).toBeInTheDocument();

    const quality_trigger = screen.getByRole("combobox", {
      name: "视频清晰度",
    });
    quality_trigger.hasPointerCapture = () => false;
    quality_trigger.setPointerCapture = vi.fn();
    quality_trigger.releasePointerCapture = vi.fn();
    fireEvent.pointerDown(quality_trigger, {
      button: 0,
      pointerType: "mouse",
    });
    fireEvent.click(screen.getByRole("option", { name: "全高清 · 1080p" }));
    expect(on_video_quality_change).toHaveBeenCalledWith("1080p");
  });
});
