import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AnalysisTimeline } from "./AnalysisTimeline";

const ASSET_ID = "01890f4c-7a2b-7cc2-98c4-dc0c0c07398f";

describe("AnalysisTimeline", () => {
  it("shows events and seeks through the shared playback progress", () => {
    const seek_to = vi.fn();
    const add_marker = vi.fn();
    render(
      <AnalysisTimeline
        duration_seconds={120}
        current_time={30}
        transcript={null}
        markers={[]}
        marker_error={null}
        segments={[
          {
            segment_id: "segment-0123456789abcdef0123456789abcdef",
            asset_id: ASSET_ID,
            start_seconds: 45,
            end_seconds: 60,
            title: "矩阵推导",
            detailed_summary: null,
            transcript_text: null,
            speaker_name: null,
            key_frame_paths: [],
            visual_description: null,
            ocr_text: null,
            marker_ids: [],
            tags: ["公式"],
          },
        ]}
        on_seek={seek_to}
        on_add_marker={add_marker}
        on_remove_marker={vi.fn()}
        on_update_marker_tags={vi.fn()}
        on_update_transcript={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("当前播放时间")).toHaveTextContent(
      "00:30 / 02:00",
    );
    fireEvent.keyDown(screen.getByRole("slider", { name: "时间轴拖动区域" }), {
      key: "ArrowRight",
    });
    fireEvent.click(screen.getByRole("button", { name: /矩阵推导/ }));
    fireEvent.keyDown(window, { key: "m", ctrlKey: true });

    expect(seek_to).toHaveBeenNthCalledWith(1, 31);
    expect(seek_to).toHaveBeenNthCalledWith(2, 45);
    expect(add_marker).toHaveBeenCalledWith(30);
  });

  it("adds a marker at the right-clicked timeline position", () => {
    const add_marker = vi.fn();
    const timeline_view = render(
      <AnalysisTimeline
        duration_seconds={120}
        current_time={0}
        transcript={null}
        markers={[]}
        marker_error={null}
        segments={[]}
        on_seek={vi.fn()}
        on_add_marker={add_marker}
        on_remove_marker={vi.fn()}
        on_update_marker_tags={vi.fn()}
        on_update_transcript={vi.fn()}
      />,
    );
    const timeline = within(timeline_view.container).getByRole("slider", {
      name: "时间轴拖动区域",
    });
    vi.spyOn(timeline, "getBoundingClientRect").mockReturnValue({
      left: 100,
      right: 500,
      width: 400,
      top: 0,
      bottom: 200,
      height: 200,
      x: 100,
      y: 0,
      toJSON: () => ({}),
    });

    fireEvent.contextMenu(timeline, { clientX: 300 });

    expect(add_marker).toHaveBeenCalledWith(60);
  });

  it("edits and saves a transcript clip on the timeline", async () => {
    const update_transcript = vi.fn().mockResolvedValue(undefined);
    render(
      <AnalysisTimeline
        duration_seconds={120}
        current_time={0}
        transcript={{
          asset_id: ASSET_ID,
          language: "zh",
          created_at: "2026-01-01",
          segments: [
            { start_seconds: 12, end_seconds: 18, text: "错误的转写" },
          ],
        }}
        markers={[]}
        marker_error={null}
        segments={[]}
        on_seek={vi.fn()}
        on_add_marker={vi.fn()}
        on_remove_marker={vi.fn()}
        on_update_marker_tags={vi.fn()}
        on_update_transcript={update_transcript}
      />,
    );

    fireEvent.doubleClick(screen.getByRole("button", { name: /错误的转写/ }));
    const editor = screen.getByLabelText("编辑 00:12 转写");
    fireEvent.change(editor, { target: { value: "修正后的转写" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(update_transcript).toHaveBeenCalledWith(0, "修正后的转写");
  });

  it("manages marker tags directly on the timeline", () => {
    const update_marker_tags = vi.fn().mockResolvedValue(undefined);
    render(
      <AnalysisTimeline
        duration_seconds={120}
        current_time={0}
        transcript={null}
        markers={[
          {
            marker_id: "marker-0123456789abcdef0123456789abcdef",
            asset_id: ASSET_ID,
            time_seconds: 30,
            tags: ["重点"],
          },
        ]}
        marker_error={null}
        segments={[]}
        on_seek={vi.fn()}
        on_add_marker={vi.fn()}
        on_remove_marker={vi.fn()}
        on_update_marker_tags={update_marker_tags}
        on_update_transcript={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "跳转到标记 00:30" }));
    fireEvent.change(screen.getByLabelText("编辑 00:30 标记标签"), {
      target: { value: "重点, 公式" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(update_marker_tags).toHaveBeenCalledWith(
      "marker-0123456789abcdef0123456789abcdef",
      ["重点", "公式"],
    );
  });
});
