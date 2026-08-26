import { render, screen } from "@testing-library/react";
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
    render(
      <DownloadSelection
        probe_result={PROBE_RESULT}
        visible_entries={PROBE_RESULT.entries}
        selected_urls={new Set([PROBE_RESULT.entries[0].url])}
        folders={[]}
        target_folder_id={undefined}
        current_source_video_id={null}
        current_entry_url={null}
        entry_filter=""
        is_submitting={false}
        on_entry_filter_change={vi.fn()}
        on_toggle_url={vi.fn()}
        on_replace_selection={vi.fn()}
        on_target_folder_change={vi.fn()}
        on_start_download={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("combobox", { name: "下载目标文件夹" }),
    ).toHaveTextContent("自动分类（按合集名称）");
  });
});
