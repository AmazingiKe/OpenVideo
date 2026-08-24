import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AnalysisToolPanel } from "./AnalysisToolPanel";
import type {
  AnalysisMode,
  AnalysisToolSection,
  AiModelSummary,
  MediaAsset,
  MediaMarker,
  TranscriptionModelDescriptor,
  TranscriptionOptions,
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

const AI_MODELS: AiModelSummary[] = [
  {
    model_id: "model-0198d12345677890abcdef1234567890",
    name: "测试模型",
    litellm_model: "openai/test-model",
    tool_calling_mode: "auto",
    input_modalities: ["text", "image"],
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
        transcription_models={TRANSCRIPTION_MODELS}
        default_transcription={DEFAULT_TRANSCRIPTION}
        on_transcription_model_change={vi.fn()}
        is_analyzing={false}
        ai_models={AI_MODELS}
        on_start_analysis={vi.fn()}
        selected_transcript_count={0}
        active_correction_scope={null}
        correction_agent_job={null}
        on_start_correction_agent={vi.fn()}
        on_agent_response={vi.fn()}
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
    const start_correction_agent = vi.fn();
    render_panel(["transcript_correction"], {
      start_correction_agent,
      selected_transcript_count: 1,
    });

    fireEvent.click(screen.getByRole("button", { name: "自动全部修正" }));
    fireEvent.click(screen.getByRole("button", { name: "选择修正" }));

    expect(start_correction_agent).toHaveBeenNthCalledWith(
      1,
      "all",
      AI_MODELS[0].model_id,
    );
    expect(start_correction_agent).toHaveBeenNthCalledWith(
      2,
      "selection",
      AI_MODELS[0].model_id,
    );
    expect(screen.getByText("已选择 1 条")).toBeInTheDocument();
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
    start_correction_agent?: (scope: "all" | "selection") => void;
    selected_transcript_count?: number;
    has_transcript?: boolean;
    transcription_models?: TranscriptionModelDescriptor[];
  } = {},
) {
  return render(
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
      on_start_analysis={options.start_analysis ?? vi.fn()}
      selected_transcript_count={options.selected_transcript_count ?? 0}
      active_correction_scope={null}
      correction_agent_job={null}
      on_start_correction_agent={options.start_correction_agent ?? vi.fn()}
      on_agent_response={vi.fn()}
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
