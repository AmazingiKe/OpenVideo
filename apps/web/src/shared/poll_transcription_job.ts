import { get_analysis } from "./api";
import type { AnalysisJob } from "./types";

const TRANSCRIPTION_POLL_INTERVAL_MS = 1000;
const MAX_POLL_ATTEMPTS = 60 * 60 * 6;
const TERMINAL_STAGES = new Set(["complete", "failed"]);

export async function poll_transcription_job(
  initial_job: AnalysisJob,
  on_update: (job: AnalysisJob) => void,
  signal: AbortSignal,
): Promise<AnalysisJob> {
  let current_job = initial_job;
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
    if (TERMINAL_STAGES.has(current_job.stage)) {
      return current_job;
    }
    await wait_for_poll(signal);
    current_job = await get_analysis(current_job.job_id, signal);
    on_update(current_job);
  }
  throw new Error("转录任务等待超时，请稍后重新查看");
}

function wait_for_poll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(resolve, TRANSCRIPTION_POLL_INTERVAL_MS);
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
