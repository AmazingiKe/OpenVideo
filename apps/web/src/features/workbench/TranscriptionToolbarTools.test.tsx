import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  type MediaAsset,
  type TranscriptionModelDescriptor,
  type TranscriptionOptions,
} from "@/shared/types";
import {
  TranscriptionToolbarTools,
  type TranscriptCorrectionRequest,
  type TranscriptCorrectionScope,
} from "./TranscriptionToolbarTools";

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
    expect(screen.getByRole("radio", { name: "选择字幕" })).toBeChecked();
    expect(screen.getByText("已选择 2 条")).toBeInTheDocument();
    expect(screen.getByText("快速模板")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "处理要求" })).toHaveValue(
      "根据整段转录上下文修正错字、漏字、同音词和专业术语，保持原意与表达风格。",
    );
    expect(screen.getByRole("button", { name: "继续到助手" })).toBeEnabled();
  });

  it("allows selected subtitles to use a custom instruction", () => {
    const request_correction = vi.fn();
    render_tools({
      selected_transcript_indices: [1, 2],
      request_correction,
    });

    fireEvent.click(screen.getByRole("button", { name: "字幕修正" }));
    fireEvent.change(screen.getByRole("textbox", { name: "处理要求" }), {
      target: { value: "把已选英文字幕翻译成中文，保留专业术语。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "继续到助手" }));

    expect(request_correction).toHaveBeenCalledWith({
      scope: "selection",
      instruction: "把已选英文字幕翻译成中文，保留专业术语。",
    });
  });

  it("requires an instruction before processing all subtitles", () => {
    const request_correction = vi.fn();
    render_tools({ request_correction });

    fireEvent.click(screen.getByRole("button", { name: "字幕修正" }));

    expect(screen.getByRole("radio", { name: "全部字幕" })).toBeChecked();
    expect(screen.getByText("必填")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "处理要求" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "继续到助手" })).toBeDisabled();

    fireEvent.change(screen.getByRole("textbox", { name: "处理要求" }), {
      target: {
        value: "将英文翻译成中文，结合整段视频主题统一专业词汇。",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "继续到助手" }));

    expect(request_correction).toHaveBeenCalledWith({
      scope: "all",
      instruction: "将英文翻译成中文，结合整段视频主题统一专业词汇。",
    });
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
  request_correction?: (request: TranscriptCorrectionRequest) => void;
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
          selected_transcript_indices={
            options.selected_transcript_indices ?? []
          }
          correction_open={correction_open}
          correction_scope={correction_scope}
          on_correction_open_change={set_correction_open}
          on_correction_scope_change={set_correction_scope}
          on_request_correction={options.request_correction ?? vi.fn()}
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
