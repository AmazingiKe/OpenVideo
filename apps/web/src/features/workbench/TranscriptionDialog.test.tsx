import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  get_cloud_submission_status,
  resolve_cloud_submission,
} from "@/shared/api/cloud_submission";

import {
  type MediaAsset,
  type TranscriptionModelDescriptor,
  type TranscriptionOptions,
} from "@/shared/types";
import { TranscriptionDialog } from "./TranscriptionDialog";

vi.mock("@/shared/api/cloud_submission", () => ({
  get_cloud_submission_status: vi.fn(),
  resolve_cloud_submission: vi.fn(),
}));

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

describe("TranscriptionDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(get_cloud_submission_status).mockResolvedValue(null);
  });

  it("shows transcription configuration", () => {
    render_tools();

    expect(screen.getByRole("dialog", { name: "转写" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "字幕修正" }),
    ).not.toBeInTheDocument();
  });

  it("starts transcription from the dialog", () => {
    const start_transcription = vi.fn();
    render_tools({ start_transcription, has_transcript: false });

    expect(screen.getByText("Whisper Small")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "生成转写" }));

    expect(start_transcription).toHaveBeenCalledWith(DEFAULT_TRANSCRIPTION);
  });

  it("allows the task language to use automatic detection", () => {
    Element.prototype.scrollIntoView = vi.fn();
    const start_transcription = vi.fn();
    render_tools({ start_transcription, has_transcript: false });

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
    fireEvent.click(screen.getByRole("button", { name: "生成转写" }));

    expect(start_transcription).toHaveBeenCalledWith({
      ...DEFAULT_TRANSCRIPTION,
      language: null,
    });
  });

  it("allows an existing transcript to be regenerated", () => {
    const start_transcription = vi.fn();
    render_tools({ start_transcription });

    fireEvent.click(screen.getByRole("button", { name: "重新转写" }));

    expect(start_transcription).toHaveBeenCalledWith(DEFAULT_TRANSCRIPTION);
    expect(
      screen.getByText("重新转写会在成功后替换当前文字；失败时保留现有结果。"),
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

    expect(screen.getByRole("button", { name: "下载并使用" })).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "生成转写" }),
    ).not.toBeInTheDocument();
  });

  it("starts batch cloud transcription without local runtime or download controls", () => {
    const start_transcription = vi.fn();
    const cloud_options: TranscriptionOptions = {
      engine: "bailian",
      model: "paraformer-v2",
      language: "zh",
      device: "auto",
      compute_type: "auto",
    };
    render_tools({
      start_transcription,
      has_transcript: false,
      asset_count: 3,
      default_transcription: cloud_options,
      transcription_models: [
        {
          ...TRANSCRIPTION_MODELS[0],
          engine: "bailian",
          model: "paraformer-v2",
          name: "百炼 Paraformer",
          description: "云端录音文件识别。",
        },
      ],
    });

    expect(screen.getByText("云端转写 · 按量计费")).toBeInTheDocument();
    expect(
      screen.getByText(/所选 3 个视频的音频将上传至阿里云百炼/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/CPU|CUDA|int8/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "下载并使用" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "转写 3 个视频" }));
    expect(start_transcription).toHaveBeenCalledWith(cloud_options);
  });

  it("requires explicit verification before unlocking an unknown cloud submission", async () => {
    const status = {
      job_id: "job-019c0000000070008000000000000000",
      uncertain: true,
      cloud_task_id: null,
      options: DEFAULT_TRANSCRIPTION,
    };
    vi.mocked(get_cloud_submission_status).mockResolvedValue(status);
    vi.mocked(resolve_cloud_submission).mockResolvedValue({
      ...status,
      uncertain: false,
    });
    const start_transcription = vi.fn();
    render_tools({ start_transcription, has_transcript: false });
    await screen.findByText("上次云端提交结果待确认");
    expect(screen.getByRole("button", { name: "生成转写" })).toBeDisabled();
    const unlock = screen.getByRole("button", { name: "解除提交锁定" });
    expect(unlock).toBeDisabled();
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "已核实未生成云端任务，允许下次重新提交",
      }),
    );
    fireEvent.click(unlock);
    await waitFor(() =>
      expect(resolve_cloud_submission).toHaveBeenCalledWith(
        ASSET_ID,
        status.job_id,
        { confirm_not_submitted: true },
        expect.any(AbortSignal),
      ),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "生成转写" })).toBeEnabled(),
    );
    expect(start_transcription).not.toHaveBeenCalled();
  });

  it("can associate an existing provider task and restore its original options", async () => {
    const options: TranscriptionOptions = {
      engine: "bailian",
      model: "paraformer-v2",
      language: "en",
      device: "auto",
      compute_type: "auto",
    };
    const status = {
      job_id: "job-019c0000000070008000000000000000",
      uncertain: true,
      cloud_task_id: null,
      options,
    };
    vi.mocked(get_cloud_submission_status).mockResolvedValue(status);
    vi.mocked(resolve_cloud_submission).mockResolvedValue({
      ...status,
      uncertain: false,
      cloud_task_id: "known-provider-task",
    });
    const start_transcription = vi.fn();
    render_tools({
      start_transcription,
      has_transcript: false,
      transcription_models: [
        TRANSCRIPTION_MODELS[0],
        {
          ...TRANSCRIPTION_MODELS[0],
          engine: "bailian",
          model: "paraformer-v2",
          name: "百炼 Paraformer",
        },
      ],
    });
    await screen.findByText("上次云端提交结果待确认");
    fireEvent.change(screen.getByRole("textbox", { name: "已有百炼任务号" }), {
      target: { value: "known-provider-task" },
    });
    fireEvent.click(screen.getByRole("button", { name: "关联已有任务" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "生成转写" })).toBeEnabled(),
    );
    expect(start_transcription).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "生成转写" }));
    expect(start_transcription).toHaveBeenCalledWith(options);
  });
});

type RenderOptions = {
  start_transcription?: (options: TranscriptionOptions) => void;
  has_transcript?: boolean;
  transcription_models?: TranscriptionModelDescriptor[];
  default_transcription?: TranscriptionOptions;
  asset_count?: number;
};

function render_tools(options: RenderOptions = {}) {
  return render(
    <TranscriptionDialog
      open
      on_open_change={vi.fn()}
      asset={create_asset()}
      asset_count={options.asset_count}
      has_transcript={options.has_transcript ?? true}
      is_transcribing={false}
      on_start_transcription={options.start_transcription ?? vi.fn()}
      transcription_models={
        options.transcription_models ?? TRANSCRIPTION_MODELS
      }
      default_transcription={
        options.default_transcription ?? DEFAULT_TRANSCRIPTION
      }
      on_transcription_model_change={vi.fn()}
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
    thumbnail_url: null,
    thumbnail_storyboard: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}
