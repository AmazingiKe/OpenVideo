import { afterEach, describe, expect, it, vi } from "vitest";

import * as api from "./api";
import { poll_transcription_job } from "./poll_transcription_job";
import type { AnalysisJob } from "./types";

const PENDING_JOB = {
  job_id: "job-0198f10e3f9871239c79000000000001",
  asset_id: "asset-0198f10e3f9871239c79000000000001",
  stage: "transcribing",
  progress_percent: 20,
  message: "正在转写",
  error_message: null,
} as AnalysisJob;

const COMPLETE_JOB = { ...PENDING_JOB, stage: "complete" as const };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("poll_transcription_job", () => {
  it("releases every timer listener during long transcription polling", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const add_listener = vi.spyOn(controller.signal, "addEventListener");
    const remove_listener = vi.spyOn(controller.signal, "removeEventListener");
    const poll_count = 120;
    const get_analysis = vi
      .spyOn(api, "get_analysis")
      .mockResolvedValue(PENDING_JOB);
    const on_update = vi.fn();
    const task = poll_transcription_job(
      PENDING_JOB,
      on_update,
      controller.signal,
    );

    await vi.advanceTimersByTimeAsync(poll_count * 1000);
    expect(get_analysis).toHaveBeenCalledTimes(poll_count);
    expect(add_listener).toHaveBeenCalledTimes(poll_count + 1);
    expect(remove_listener).toHaveBeenCalledTimes(poll_count);
    for (const [event, listener] of remove_listener.mock.calls)
      expect(add_listener).toHaveBeenCalledWith(event, listener, {
        once: true,
      });

    get_analysis.mockResolvedValueOnce(COMPLETE_JOB);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(task).resolves.toEqual(COMPLETE_JOB);
    expect(on_update).toHaveBeenCalledTimes(poll_count + 1);
    expect(remove_listener).toHaveBeenCalledTimes(poll_count + 1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects an already detached observer without scheduling another poll", async () => {
    vi.useFakeTimers();
    const get_analysis = vi.spyOn(api, "get_analysis");
    const controller = new AbortController();
    controller.abort();
    await expect(
      poll_transcription_job(PENDING_JOB, vi.fn(), controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(get_analysis).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the pending timer on detach without requesting cancellation", async () => {
    vi.useFakeTimers();
    const get_analysis = vi.spyOn(api, "get_analysis");
    const controller = new AbortController();
    const task = poll_transcription_job(
      PENDING_JOB,
      vi.fn(),
      controller.signal,
    );
    const rejection = expect(task).rejects.toMatchObject({
      name: "AbortError",
    });
    controller.abort();
    await rejection;
    await vi.advanceTimersByTimeAsync(1000);
    expect(get_analysis).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores a response that arrives after the observer detached", async () => {
    vi.useFakeTimers();
    let resolve_poll!: (job: AnalysisJob) => void;
    vi.spyOn(api, "get_analysis").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolve_poll = resolve;
        }),
    );
    const on_update = vi.fn();
    const controller = new AbortController();
    const task = poll_transcription_job(
      PENDING_JOB,
      on_update,
      controller.signal,
    );
    const rejection = expect(task).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.advanceTimersByTimeAsync(1000);
    controller.abort();
    resolve_poll(COMPLETE_JOB);
    await rejection;
    expect(on_update).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["complete", "failed"] as const)(
    "does not poll a %s task",
    async (stage) => {
      const get_analysis = vi.spyOn(api, "get_analysis");
      const terminal_job = { ...PENDING_JOB, stage };
      await expect(
        poll_transcription_job(
          terminal_job,
          vi.fn(),
          new AbortController().signal,
        ),
      ).resolves.toEqual(terminal_job);
      expect(get_analysis).not.toHaveBeenCalled();
    },
  );
});
