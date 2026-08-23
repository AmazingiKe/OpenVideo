import { get_agent_job } from "./api";
import type { AgentJob } from "./types";

const AGENT_POLL_INTERVAL_MS = 1_000;
const MAX_POLL_ATTEMPTS = 60 * 60 * 6;
const POLLING_STOP_STAGES = new Set([
  "waiting_for_input",
  "complete",
  "failed",
  "cancelled",
]);

export async function poll_agent_job(
  initial_job: AgentJob,
  on_update: (job: AgentJob) => void,
  signal: AbortSignal,
): Promise<AgentJob> {
  let current_job = initial_job;
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
    if (POLLING_STOP_STAGES.has(current_job.stage)) return current_job;
    await wait_for_poll(signal);
    current_job = await get_agent_job(current_job.job_id, signal);
    on_update(current_job);
  }
  throw new Error("Agent 任务等待超时，请稍后重新查看");
}

function wait_for_poll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(resolve, AGENT_POLL_INTERVAL_MS);
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
