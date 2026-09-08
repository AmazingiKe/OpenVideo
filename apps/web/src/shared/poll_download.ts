import { get_download } from "./api";
import type { DownloadJob } from "./types";

const poll_interval_ms = 1000;
const max_poll_attempts = 60 * 60 * 6;

export async function poll_download(
  initial_job: DownloadJob,
  on_update: (job: DownloadJob) => void,
  signal: AbortSignal,
): Promise<DownloadJob> {
  let current_job = initial_job;
  for (let attempt = 0; attempt < max_poll_attempts; attempt += 1) {
    if (
      current_job.stage === "complete" ||
      current_job.stage === "failed" ||
      current_job.stage === "paused"
    ) {
      return current_job;
    }
    await wait_for_poll(signal);
    current_job = await get_download(current_job.job_id, signal);
    signal.throwIfAborted();
    on_update(current_job);
  }
  throw new Error("下载任务等待超时，请稍后重新查看媒体库");
}

function wait_for_poll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const on_abort = () => {
      window.clearTimeout(timeout);
      reject(new DOMException("请求已取消", "AbortError"));
    };
    const timeout = window.setTimeout(() => {
      signal.removeEventListener("abort", on_abort);
      resolve();
    }, poll_interval_ms);
    signal.addEventListener("abort", on_abort, { once: true });
  });
}
