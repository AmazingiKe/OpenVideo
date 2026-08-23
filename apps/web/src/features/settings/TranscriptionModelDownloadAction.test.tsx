import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TranscriptionModelDownloadAction } from "./TranscriptionModelDownloadAction";
import {
  download_transcription_model,
  get_transcription_model_download,
} from "@/shared/api";
import type {
  TranscriptionModelDescriptor,
  TranscriptionModelDownloadJob,
} from "@/shared/types";

vi.mock("@/shared/api", () => ({
  download_transcription_model: vi.fn(),
  get_transcription_model_download: vi.fn(),
}));

const MODEL: TranscriptionModelDescriptor = {
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
  installation_status: "not_installed",
  download_job: null,
};

const PENDING_JOB: TranscriptionModelDownloadJob = {
  job_id: "model-download-0198d12345677890abcdef1234567890",
  engine: "faster-whisper",
  model: "small",
  stage: "pending",
  progress_percent: 0,
  downloaded_bytes: 0,
  total_bytes: null,
  message: "等待下载",
  error_message: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(download_transcription_model).mockResolvedValue(PENDING_JOB);
  vi.mocked(get_transcription_model_download).mockResolvedValue({
    ...PENDING_JOB,
    stage: "complete",
    progress_percent: 100,
    downloaded_bytes: 100,
    total_bytes: 100,
    message: "模型已安装",
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("TranscriptionModelDownloadAction", () => {
  it("downloads an uninstalled model and reports completion", async () => {
    const change_model = vi.fn();
    const complete = vi.fn();
    render(
      <TranscriptionModelDownloadAction
        model={MODEL}
        action_label="下载并使用"
        on_change={change_model}
        on_complete={complete}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "下载并使用" }));
    });
    expect(screen.getByRole("button", { name: /下载中 0%/ })).toBeDisabled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(download_transcription_model).toHaveBeenCalledWith(
      "faster-whisper",
      "small",
    );
    expect(change_model).toHaveBeenLastCalledWith(
      expect.objectContaining({ installation_status: "installed" }),
    );
    expect(complete).toHaveBeenCalledOnce();
  });
});
