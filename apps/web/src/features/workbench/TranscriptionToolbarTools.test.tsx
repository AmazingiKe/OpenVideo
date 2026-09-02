import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  type MediaAsset,
  type TranscriptionModelDescriptor,
  type TranscriptionOptions,
} from "@/shared/types";
import { TranscriptionToolbarTools } from "./TranscriptionToolbarTools";

const ASSET_ID = "01890f4c-7a2b-7cc2-98c4-dc0c0c07398f";

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
  it("keeps only transcription configuration in the timeline toolbar", () => {
    render_tools();

    expect(screen.getByRole("button", { name: "转录" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "字幕修正" }),
    ).not.toBeInTheDocument();
  });

  it("starts transcription from the toolbar popover", () => {
    const start_transcription = vi.fn();
    render_tools({ start_transcription, has_transcript: false });

    fireEvent.click(screen.getByRole("button", { name: "转录" }));
    expect(screen.getByText("Whisper Small")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "生成转录" }));

    expect(start_transcription).toHaveBeenCalledWith(DEFAULT_TRANSCRIPTION);
  });

  it("allows the task language to use automatic detection", () => {
    Element.prototype.scrollIntoView = vi.fn();
    const start_transcription = vi.fn();
    render_tools({ start_transcription, has_transcript: false });

    fireEvent.click(screen.getByRole("button", { name: "转录" }));
    const language_trigger = screen.getByRole("combobox", {
      name: "音频语言",
    });
    language_trigger.hasPointerCapture = () => false;
    language_trigger.setPointerCapture = vi.fn();
    language_trigger.releasePointerCapture = vi.fn();
    fireEvent.pointerDown(language_trigger, {
      button: 0,
      pointerType: "mouse",
    });
    fireEvent.click(screen.getByRole("option", { name: "自动检测" }));
    fireEvent.click(screen.getByRole("button", { name: "生成转录" }));

    expect(start_transcription).toHaveBeenCalledWith({
      ...DEFAULT_TRANSCRIPTION,
      language: null,
    });
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
  has_transcript?: boolean;
  transcription_models?: TranscriptionModelDescriptor[];
};

function render_tools(options: RenderOptions = {}) {
  return render(<ControlledTools options={options} />);
}

function ControlledTools({ options }: { options: RenderOptions }) {
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
    thumbnail_url: null,
    thumbnail_storyboard: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}
