import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TranscriptionToolPanel } from "./TranscriptionToolPanel";
import {
  DEFAULT_MODEL_CAPABILITY_OVERRIDES,
  unknown_model_profile,
  type AiModelSummary,
  type MediaAsset,
  type ToolPanelSection,
  type TranscriptionModelDescriptor,
  type TranscriptionOptions,
} from "@/shared/types";

vi.mock("@/components/AgentPanel", () => ({
  AgentPanel: () => <div>字幕纠错 Agent</div>,
}));

const ASSET_ID = "01890f4c-7a2b-7cc2-98c4-dc0c0c07398f";

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

const DEFAULT_TRANSCRIPTION: TranscriptionOptions = {
  engine: "faster-whisper",
  model: "small",
  language: "zh",
  device: "cpu",
  compute_type: "int8",
};

describe("TranscriptionToolPanel", () => {
  it("shows only transcription and correction tools", () => {
    render_panel(["transcription"]);

    expect(screen.getByText("转录工具")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "转录" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "修正转录" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "视频信息" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "分析" }),
    ).not.toBeInTheDocument();
  });

  it("toggles one section normally and all sections with Shift", () => {
    const change_sections = vi.fn();
    render_panel(["transcription"], { change_sections });

    fireEvent.click(screen.getByRole("button", { name: "修正转录" }));
    expect(change_sections).toHaveBeenLastCalledWith(["transcript_correction"]);

    fireEvent.click(screen.getByRole("button", { name: "修正转录" }), {
      shiftKey: true,
    });
    expect(change_sections).toHaveBeenLastCalledWith([
      "transcription",
      "transcript_correction",
    ]);
  });

  it("collapses all sections with Shift plus keyboard activation", () => {
    const change_sections = vi.fn();
    render_panel(["transcription", "transcript_correction"], {
      change_sections,
    });

    fireEvent.keyDown(screen.getByRole("button", { name: "转录" }), {
      key: "Enter",
      shiftKey: true,
    });
    expect(change_sections).toHaveBeenLastCalledWith([]);
  });

  it("uses an accessible narrow rail while collapsed", () => {
    const change_collapsed = vi.fn();
    render(
      <TranscriptionToolPanel
        asset={create_asset()}
        has_transcript
        is_transcribing={false}
        on_start_transcription={vi.fn()}
        transcription_models={TRANSCRIPTION_MODELS}
        default_transcription={DEFAULT_TRANSCRIPTION}
        on_transcription_model_change={vi.fn()}
        ai_models={AI_MODELS}
        selected_transcript_indices={[]}
        on_transcript_changed={vi.fn()}
        open_sections={["transcription"]}
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

  it("allows an existing transcript to be regenerated", () => {
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
  open_sections: ToolPanelSection[],
  options: {
    start_transcription?: (options: TranscriptionOptions) => void;
    change_sections?: (sections: ToolPanelSection[]) => void;
    selected_transcript_indices?: number[];
    has_transcript?: boolean;
    transcription_models?: TranscriptionModelDescriptor[];
  } = {},
) {
  return render(
    <TranscriptionToolPanel
      asset={create_asset()}
      has_transcript={options.has_transcript ?? true}
      is_transcribing={false}
      on_start_transcription={options.start_transcription ?? vi.fn()}
      transcription_models={
        options.transcription_models ?? TRANSCRIPTION_MODELS
      }
      default_transcription={DEFAULT_TRANSCRIPTION}
      on_transcription_model_change={vi.fn()}
      ai_models={AI_MODELS}
      selected_transcript_indices={options.selected_transcript_indices ?? []}
      on_transcript_changed={vi.fn()}
      open_sections={open_sections}
      on_open_sections_change={options.change_sections ?? vi.fn()}
    />,
  );
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
    scrub_preview_url: null,
    thumbnail_url: null,
    thumbnail_storyboard: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}
