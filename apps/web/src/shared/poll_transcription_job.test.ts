import { afterEach, describe, expect, it, vi } from "vitest";

import { get_analysis } from "./api";
import { DEFAULT_ANALYSIS_STRATEGY } from "./analysis";
import { poll_transcription_job } from "./poll_transcription_job";
import type { AnalysisJob } from "./types";

vi.mock("./api", () => ({ get_analysis: vi.fn() }));

const JOB: AnalysisJob = {
  job_id: "job-019c012345677abc8123456789abcdea",
  asset_id: "asset-019c012345677abc8123456789abcdef",
  operation: "transcription",
  mode: "full",
  ai_model_id: null,
  strategy: DEFAULT_ANALYSIS_STRATEGY,
  capabilities: ["transcript"],
  stage: "cancelling",
  progress_percent: 20,
  message: "正在安全停止",
  error_message: null,
  proposal_base_digest: null,
  proposed_segments: [],
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("poll_transcription_job", () => {
  it("observes a safe stop until the server confirms cancellation", async () => {
    vi.useFakeTimers();
    const cancelled = { ...JOB, stage: "cancelled" } as const;
    vi.mocked(get_analysis).mockResolvedValueOnce(cancelled);
    const on_update = vi.fn();
    const request = poll_transcription_job(
      JOB,
      on_update,
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(1000);
    await expect(request).resolves.toEqual(cancelled);
    expect(get_analysis).toHaveBeenCalledOnce();
    expect(on_update).toHaveBeenCalledWith(cancelled);
  });

  it("ignores a late progress response after observation is aborted", async () => {
    vi.useFakeTimers();
    let resolve_job!: (job: AnalysisJob) => void;
    vi.mocked(get_analysis).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolve_job = resolve;
        }),
    );
    const on_update = vi.fn();
    const controller = new AbortController();
    const request = poll_transcription_job(JOB, on_update, controller.signal);
    const rejection = expect(request).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.advanceTimersByTimeAsync(1000);
    controller.abort();
    resolve_job({ ...JOB, stage: "complete" });
    await rejection;
    expect(on_update).not.toHaveBeenCalled();
  });
});
