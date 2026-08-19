import { get_analysis } from "./api";
import type { AnalysisJob } from "./types";

export const analysis_poll_interval_ms = 1000;
const max_poll_attempts = 60 * 60 * 6;
const terminal_stages = new Set(["complete", "failed"]);

export async function poll_analysis(
  initial_job: AnalysisJob,
  on_update: (job: AnalysisJob) => void,
  signal: AbortSignal,
): Promise<AnalysisJob> {
  let current_job = initial_job;
  for (let attempt = 0; attempt < max_poll_attempts; attempt += 1) {
    if (terminal_stages.has(current_job.stage)) {
      return current_job;
    }
    await wait_for_poll(signal);
    current_job = await get_analysis(current_job.job_id, signal);
    on_update(current_job);
  }
  throw new Error("分析任务等待超时，请稍后重新查看");
}

function wait_for_poll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(resolve, analysis_poll_interval_ms);
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
