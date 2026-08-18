import { get_download } from "./api";
import type { DownloadJob } from "./types";

export const poll_interval_ms = 1000;
export const max_poll_attempts = 60 * 60 * 6;

export async function poll_download(
  initial_job: DownloadJob,
  on_update: (job: DownloadJob) => void,
  signal: AbortSignal,
): Promise<DownloadJob> {
  let current_job = initial_job;
  for (let attempt = 0; attempt < max_poll_attempts; attempt += 1) {
    if (current_job.stage === "complete" || current_job.stage === "failed") {
      return current_job;
    }
    await wait_for_poll(signal);
    current_job = await get_download(current_job.job_id, signal);
    on_update(current_job);
  }
  throw new Error("下载任务等待超时，请稍后重新查看媒体库");
}

function wait_for_poll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(resolve, poll_interval_ms);
    signal.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timeout);
        reject(new DOMException("请求已取消", "AbortError"));
      },
      { once: true },
    );
  });
}
