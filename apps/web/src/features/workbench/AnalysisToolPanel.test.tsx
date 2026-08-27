import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { AnalysisToolPanel } from "./AnalysisToolPanel";
import { DEFAULT_ANALYSIS_STRATEGY } from "@/shared/analysis";
import {
  DEFAULT_MODEL_CAPABILITY_OVERRIDES,
  unknown_model_profile,
  type AnalysisMode,
  type AnalysisToolSection,
  type AiModelSummary,
  type MediaAsset,
  type MediaMarker,
  type TranscriptionModelDescriptor,
  type TranscriptionOptions,
} from "@/shared/types";

vi.mock("@/components/AgentPanel", () => ({
  AgentPanel: () => <div>字幕纠错 Agent</div>,
}));

const ASSET_ID = "01890f4c-7a2b-7cc2-98c4-dc0c0c07398f";
const MARKERS: MediaMarker[] = [
  {
    marker_id: "marker-0123456789abcdef0123456789abcdef",
    asset_id: ASSET_ID,
    start_seconds: 30,
    end_seconds: null,
    title: "公式",
    tags: ["公式"],
    marker_range_before_seconds: null,
    marker_range_after_seconds: null,
  },
  {
    marker_id: "marker-1123456789abcdef0123456789abcdef",
    asset_id: ASSET_ID,
    start_seconds: 90,
    end_seconds: null,
    title: "疑问",
    tags: ["疑问"],
    marker_range_before_seconds: null,
    marker_range_after_seconds: null,
  },
];

const AI_MODELS: AiModelSummary[] = [
  {
    model_id: "model-0198d12345677890abcdef1234567890",
    name: "测试模型",
    litellm_model: "openai/test-model",
    input_modalities: ["text", "image"],
    capabilities: { ...DEFAULT_MODEL_CAPABILITY_OVERRIDES },
    profile: unknown_model_profile("openai", "test-model"),
  },
];

const TRANSCRIPTION_MODELS: TranscriptionModelDescriptor[] = [
  {
    engine: "faster-whisper",
    model: "small",
    name: "Whisper Small",
    description: "兼顾资源占用与识别质量。",
    accuracy: "标准",
    speed: "快",
    languages: ["多语言"],
    repository: "Systran/faster-whisper-small",
    recommended: false,
    integration_status: "available",
    installation_status: "installed",
    download_job: null,
  },
];

const DEFAULT_TRANSCRIPTION = {
  engine: "faster-whisper" as const,
  model: "small",
  language: "zh",
  device: "cpu" as const,
  compute_type: "int8" as const,
};

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
    expect(
      screen.getByRole("button", { name: "按课程笔记分析 2 个标记" }),
    ).toBeEnabled();

    fireEvent.click(marker_options[0]);
    fireEvent.click(
      screen.getByRole("button", { name: "按课程笔记分析 1 个标记" }),
    );

    expect(start_analysis).toHaveBeenCalledWith(
      "markers",
      ["marker-1123456789abcdef0123456789abcdef"],
      null,
      expect.objectContaining({ preset: "course_notes" }),
    );
  });

  it("adjusts marker priority without opening advanced settings", () => {
    render_panel(["analysis"]);

    const marker_priority = screen.getByRole("slider", {
      name: "标记优先级",
    });
    expect(marker_priority).toHaveAttribute("aria-valuenow", "100");

    fireEvent.click(screen.getByRole("radio", { name: "较高" }));
    expect(marker_priority).toHaveAttribute("aria-valuenow", "75");
    expect(screen.getByText("较高 · 75")).toBeInTheDocument();
  });

  it("toggles one section normally and all sections with Shift", () => {
    const change_sections = vi.fn();
    render_panel(["video_information"], { change_sections });

    fireEvent.click(screen.getByRole("button", { name: "转录" }));
    expect(change_sections).toHaveBeenLastCalledWith(["transcription"]);

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

  it("edits the default marker ranges independently in advanced settings", () => {
    render_panel(["analysis"]);

    fireEvent.click(screen.getByRole("button", { name: "高级设置" }));
    const before_slider = screen.getByRole("slider", {
      name: "标记前范围秒数",
    });
    const after_slider = screen.getByRole("slider", {
      name: "标记后范围秒数",
    });
    expect(before_slider).toHaveAttribute("aria-valuenow", "10");
    expect(after_slider).toHaveAttribute("aria-valuenow", "20");

    fireEvent.keyDown(before_slider, { key: "ArrowRight" });
    expect(before_slider).toHaveAttribute("aria-valuenow", "15");
    expect(after_slider).toHaveAttribute("aria-valuenow", "20");
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
        transcription_models={TRANSCRIPTION_MODELS}
        default_transcription={DEFAULT_TRANSCRIPTION}
        on_transcription_model_change={vi.fn()}
        is_analyzing={false}
        ai_models={AI_MODELS}
        analysis_strategy={DEFAULT_ANALYSIS_STRATEGY}
        set_analysis_strategy={vi.fn()}
        on_start_analysis={vi.fn()}
        analysis_proposal={null}
        on_resolve_analysis={vi.fn()}
        selected_transcript_indices={[]}
        on_transcript_changed={vi.fn()}
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

  it("selects the full transcript or the selected timeline segment", () => {
    render_panel(["transcript_correction"], {
      selected_transcript_indices: [1],
    });

    fireEvent.click(screen.getByRole("radio", { name: "时间线选择" }));
    expect(screen.getByText("已选择 1 条")).toBeInTheDocument();
    expect(screen.getByText("字幕纠错 Agent")).toBeInTheDocument();
  });

  it("starts transcription with the configured default model", () => {
    const start_transcription = vi.fn();
    render_panel(["transcription"], {
      start_transcription,
      has_transcript: false,
    });

    expect(screen.getByText("Whisper Small")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "生成转录" }));

    expect(start_transcription).toHaveBeenCalledWith(DEFAULT_TRANSCRIPTION);
  });

  it("allows an existing transcript to be regenerated with another model", () => {
    const start_transcription = vi.fn();
    render_panel(["transcription"], {
      start_transcription,
      has_transcript: true,
    });

    expect(screen.getByRole("combobox", { name: "模型" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "重新转录" }));

    expect(start_transcription).toHaveBeenCalledWith(DEFAULT_TRANSCRIPTION);
    expect(
      screen.getByText("重新转录会在成功后替换当前文字；失败时保留现有结果。"),
    ).toBeInTheDocument();
  });

  it("offers download and use when the selected model is not installed", () => {
    render_panel(["transcription"], {
      has_transcript: false,
      transcription_models: [
        {
          ...TRANSCRIPTION_MODELS[0],
          installation_status: "not_installed",
        },
      ],
    });

    expect(screen.getByRole("button", { name: "下载并使用" })).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "生成转录" }),
    ).not.toBeInTheDocument();
  });
});

function render_panel(
  open_sections: AnalysisToolSection[],
  options: {
    start_analysis?: (mode: AnalysisMode, marker_ids: string[]) => void;
    start_transcription?: (options: TranscriptionOptions) => void;
    change_sections?: (sections: AnalysisToolSection[]) => void;
    selected_transcript_indices?: number[];
    has_transcript?: boolean;
    transcription_models?: TranscriptionModelDescriptor[];
  } = {},
) {
  function AnalysisToolPanelHarness() {
    const [analysis_strategy, set_analysis_strategy] = useState(
      structuredClone(DEFAULT_ANALYSIS_STRATEGY),
    );
    return (
      <AnalysisToolPanel
        asset={create_asset()}
        markers={MARKERS}
        has_transcript={options.has_transcript ?? true}
        is_transcribing={false}
        on_start_transcription={options.start_transcription ?? vi.fn()}
        transcription_models={
          options.transcription_models ?? TRANSCRIPTION_MODELS
        }
        default_transcription={DEFAULT_TRANSCRIPTION}
        on_transcription_model_change={vi.fn()}
        is_analyzing={false}
        ai_models={AI_MODELS}
        analysis_strategy={analysis_strategy}
        set_analysis_strategy={set_analysis_strategy}
        on_start_analysis={options.start_analysis ?? vi.fn()}
        analysis_proposal={null}
        on_resolve_analysis={vi.fn()}
        selected_transcript_indices={options.selected_transcript_indices ?? []}
        on_transcript_changed={vi.fn()}
        open_sections={open_sections}
        on_open_sections_change={options.change_sections ?? vi.fn()}
      />
    );
  }
  return render(<AnalysisToolPanelHarness />);
}

function create_asset(): MediaAsset {
  return {
    asset_id: ASSET_ID,
    folder_id: null,
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
