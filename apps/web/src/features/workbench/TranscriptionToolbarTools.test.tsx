import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_MODEL_CAPABILITY_OVERRIDES,
  unknown_model_profile,
  type AiModelSummary,
  type MediaAsset,
  type TranscriptionModelDescriptor,
  type TranscriptionOptions,
} from "@/shared/types";
import {
  TranscriptionToolbarTools,
  type TranscriptCorrectionScope,
} from "./TranscriptionToolbarTools";

vi.mock("@/components/AgentPanel", () => ({
  AgentPanel: ({ task_input }: { task_input: Record<string, unknown> }) => (
    <div data-testid="transcript-correction-agent">
      {JSON.stringify(task_input)}
    </div>
  ),
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

describe("TranscriptionToolbarTools", () => {
  it("places transcription and correction actions in the timeline toolbar", () => {
    render_tools();

    expect(screen.getByRole("button", { name: "转录" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "字幕修正" }),
    ).toBeInTheDocument();
  });

  it("starts transcription from the toolbar popover", () => {
    const start_transcription = vi.fn();
    render_tools({ start_transcription, has_transcript: false });

    fireEvent.click(screen.getByRole("button", { name: "转录" }));
    expect(screen.getByText("Whisper Small")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "生成转录" }));

    expect(start_transcription).toHaveBeenCalledWith(DEFAULT_TRANSCRIPTION);
  });

  it("allows an existing transcript to be regenerated", () => {
    const start_transcription = vi.fn();
    render_tools({ start_transcription });

    fireEvent.click(screen.getByRole("button", { name: "转录" }));
    fireEvent.click(screen.getByRole("button", { name: "重新转录" }));

    expect(start_transcription).toHaveBeenCalledWith(DEFAULT_TRANSCRIPTION);
    expect(
      screen.getByText("重新转录会在成功后替换当前文字；失败时保留现有结果。"),
    ).toBeInTheDocument();
  });

  it("opens correction for the selected timeline subtitles", () => {
    render_tools({ selected_transcript_indices: [1, 2] });

    fireEvent.click(screen.getByRole("button", { name: "字幕修正" }));

    const correction_dialog = screen.getByRole("dialog", {
      name: "字幕修正",
    });
    expect(correction_dialog).toBeInTheDocument();
    expect(
      correction_dialog.closest('[data-slot="popover-content"]'),
    ).toBeInTheDocument();
    expect(
      document.querySelector('[data-slot="sheet-content"]'),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "时间线选择" })).toBeChecked();
    expect(screen.getByText("已选择 2 条")).toBeInTheDocument();
    expect(screen.getByTestId("transcript-correction-agent")).toHaveTextContent(
      '"segment_indices":[1,2]',
    );
  });

  it("disables correction until a transcript exists", () => {
    render_tools({ has_transcript: false });

    expect(screen.getByRole("button", { name: "字幕修正" })).toBeDisabled();
  });

  it("offers download and use when the selected model is not installed", () => {
    render_tools({
      has_transcript: false,
      transcription_models: [
        {
          ...TRANSCRIPTION_MODELS[0],
          installation_status: "not_installed",
        },
      ],
    });

    fireEvent.click(screen.getByRole("button", { name: "转录" }));
    expect(screen.getByRole("button", { name: "下载并使用" })).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "生成转录" }),
    ).not.toBeInTheDocument();
  });
});

type RenderOptions = {
  start_transcription?: (options: TranscriptionOptions) => void;
  selected_transcript_indices?: number[];
  has_transcript?: boolean;
  transcription_models?: TranscriptionModelDescriptor[];
};

function render_tools(options: RenderOptions = {}) {
  return render(<ControlledTools options={options} />);
}

function ControlledTools({ options }: { options: RenderOptions }) {
  const [correction_open, set_correction_open] = useState(false);
  const [correction_scope, set_correction_scope] =
    useState<TranscriptCorrectionScope>("all");
  return (
    <div className="media_timeline_toolbar">
      <div className="media_timeline_transport">
        <TranscriptionToolbarTools
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
          selected_transcript_indices={
            options.selected_transcript_indices ?? []
          }
          on_transcript_changed={vi.fn()}
          correction_open={correction_open}
          correction_scope={correction_scope}
          on_correction_open_change={set_correction_open}
          on_correction_scope_change={set_correction_scope}
        />
      </div>
    </div>
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
