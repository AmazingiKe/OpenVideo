import { afterEach, describe, expect, it, vi } from "vitest";

import * as api from "./api";
import { poll_download } from "./poll_download";
import type { DownloadJob } from "./types";

const pending_job: DownloadJob = {
  job_id: "job-1",
  asset_id: "asset-1",
  stage: "pending",
  progress_percent: 0,
  message: "等待开始",
  error_message: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  name: "测试视频",
  events: [],
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("poll_download", () => {
  it("polls sequentially until completion", async () => {
    vi.useFakeTimers();
    const downloading = {
      ...pending_job,
      stage: "downloading" as const,
      progress_percent: 50,
    };
    const complete = {
      ...pending_job,
      stage: "complete" as const,
      progress_percent: 100,
    };
    vi.spyOn(api, "get_download")
      .mockResolvedValueOnce(downloading)
      .mockResolvedValueOnce(complete);
    const on_update = vi.fn();
    const promise = poll_download(
      pending_job,
      on_update,
      new AbortController().signal,
    );

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    await expect(promise).resolves.toEqual(complete);
    expect(on_update).toHaveBeenNthCalledWith(1, downloading);
    expect(on_update).toHaveBeenNthCalledWith(2, complete);
    expect(api.get_download).toHaveBeenCalledTimes(2);
  });

  it("does not poll terminal jobs", async () => {
    const get_download_spy = vi.spyOn(api, "get_download");
    const failed = {
      ...pending_job,
      stage: "failed" as const,
      error_message: "失败",
    };
    await expect(
      poll_download(failed, vi.fn(), new AbortController().signal),
    ).resolves.toEqual(failed);
    expect(get_download_spy).not.toHaveBeenCalled();
  });
});
