import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AnalysisToolPanel } from "./AnalysisToolPanel";
import type {
  AnalysisMode,
  AnalysisToolSection,
  MediaAsset,
  MediaMarker,
} from "@/shared/types";

const ASSET_ID = "01890f4c-7a2b-7cc2-98c4-dc0c0c07398f";
const MARKERS: MediaMarker[] = [
  {
    marker_id: "marker-0123456789abcdef0123456789abcdef",
    asset_id: ASSET_ID,
    time_seconds: 30,
    tags: ["公式"],
  },
  {
    marker_id: "marker-1123456789abcdef0123456789abcdef",
    asset_id: ASSET_ID,
    time_seconds: 90,
    tags: ["疑问"],
  },
];

describe("AnalysisToolPanel", () => {
  it("moves video metadata and the description into video information", () => {
    render_panel(["video_information"]);

    expect(screen.getByText("课程简介")).toBeInTheDocument();
    expect(screen.getByText("03:00")).toBeInTheDocument();
    expect(screen.getByText("1920 × 1080")).toBeInTheDocument();
    expect(screen.getByText("h264")).toBeInTheDocument();
    expect(screen.getByText("aac")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "哔哩哔哩" })).toHaveAttribute(
      "href",
      "https://www.bilibili.com/video/BV1xx411c7mD",
    );
  });

  it("lets the user analyze only selected markers", () => {
    const start_analysis = vi.fn();
    render_panel(["analysis"], { start_analysis });

    fireEvent.click(screen.getByRole("radio", { name: "标记" }));
    const marker_options = screen.getAllByRole("checkbox");
    expect(marker_options).toHaveLength(2);
    expect(screen.getByRole("button", { name: "分析 2 个标记" })).toBeEnabled();

    fireEvent.click(marker_options[0]);
    fireEvent.click(screen.getByRole("button", { name: "分析 1 个标记" }));

    expect(start_analysis).toHaveBeenCalledWith("markers", [
      "marker-1123456789abcdef0123456789abcdef",
    ]);
  });

  it("toggles one section normally and all sections with Shift", () => {
    const change_sections = vi.fn();
    render_panel(["video_information"], { change_sections });

    fireEvent.click(screen.getByRole("button", { name: "转录" }));
    expect(change_sections).toHaveBeenLastCalledWith([
      "video_information",
      "transcription",
    ]);

    fireEvent.click(screen.getByRole("button", { name: "分析" }), {
      shiftKey: true,
    });
    expect(change_sections).toHaveBeenLastCalledWith([
      "video_information",
      "transcription",
      "transcript_correction",
      "analysis",
    ]);
  });

  it("collapses all sections with Shift plus keyboard activation", () => {
    const change_sections = vi.fn();
    render_panel(
      [
        "video_information",
        "transcription",
        "transcript_correction",
        "analysis",
      ],
      { change_sections },
    );

    fireEvent.keyDown(screen.getByRole("button", { name: "视频信息" }), {
      key: "Enter",
      shiftKey: true,
    });
    expect(change_sections).toHaveBeenLastCalledWith([]);
  });

  it("uses an accessible narrow rail while collapsed", () => {
    const change_collapsed = vi.fn();
    render(
      <AnalysisToolPanel
        asset={create_asset()}
        markers={MARKERS}
        has_transcript={true}
        is_transcribing={false}
        on_start_transcription={vi.fn()}
        is_analyzing={false}
        on_start_analysis={vi.fn()}
        selected_transcript_count={0}
        active_correction_scope={null}
        on_correct_transcript={vi.fn()}
        open_sections={["video_information"]}
        on_open_sections_change={vi.fn()}
        collapsed
        on_collapsed_change={change_collapsed}
      />,
    );

    expect(screen.getByText("工具")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "展开工具" }));
    expect(change_collapsed).toHaveBeenCalledWith(false);
  });

  it("corrects the full transcript or the selected timeline segment", () => {
    const correct_transcript = vi.fn();
    render_panel(["transcript_correction"], {
      correct_transcript,
      selected_transcript_count: 1,
    });

    fireEvent.click(screen.getByRole("button", { name: "自动全部修正" }));
    fireEvent.click(screen.getByRole("button", { name: "选择修正" }));

    expect(correct_transcript).toHaveBeenNthCalledWith(1, "all");
    expect(correct_transcript).toHaveBeenNthCalledWith(2, "selection");
    expect(screen.getByText("已选择 1 条")).toBeInTheDocument();
  });
});

function render_panel(
  open_sections: AnalysisToolSection[],
  options: {
    start_analysis?: (mode: AnalysisMode, marker_ids: string[]) => void;
    change_sections?: (sections: AnalysisToolSection[]) => void;
    correct_transcript?: (scope: "all" | "selection") => void;
    selected_transcript_count?: number;
  } = {},
) {
  return render(
    <AnalysisToolPanel
      asset={create_asset()}
      markers={MARKERS}
      has_transcript={true}
      is_transcribing={false}
      on_start_transcription={vi.fn()}
      is_analyzing={false}
      on_start_analysis={options.start_analysis ?? vi.fn()}
      selected_transcript_count={options.selected_transcript_count ?? 0}
      active_correction_scope={null}
      on_correct_transcript={options.correct_transcript ?? vi.fn()}
      open_sections={open_sections}
      on_open_sections_change={options.change_sections ?? vi.fn()}
    />,
  );
}

function create_asset(): MediaAsset {
  return {
    asset_id: ASSET_ID,
    media_type: "video",
    source_url: "https://www.bilibili.com/video/BV1xx411c7mD",
    source_platform: "bilibili",
    source_video_id: "BV1xx411c7mD",
    title: "课程视频",
    author_name: "讲师",
    description: "课程简介",
    duration_seconds: 180,
    width: 1920,
    height: 1080,
    video_codec: "h264",
    audio_codec: "aac",
    status: "ready",
    error_message: null,
    playback_url: "/stream",
    thumbnail_url: null,
    thumbnail_storyboard: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}
