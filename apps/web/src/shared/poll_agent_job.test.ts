import { afterEach, describe, expect, it, vi } from "vitest";

import { get_agent_job } from "./api";
import { poll_agent_job } from "./poll_agent_job";
import type { AgentJob } from "./types";

vi.mock("./api", () => ({ get_agent_job: vi.fn() }));

describe("poll_agent_job", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("stops polling when the agent needs user input", async () => {
    vi.useFakeTimers();
    const pending = agent_job("pending");
    const waiting = agent_job("waiting_for_input");
    vi.mocked(get_agent_job).mockResolvedValue(waiting);
    const updates = vi.fn();
    const result = poll_agent_job(
      pending,
      updates,
      new AbortController().signal,
    );

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(result).resolves.toEqual(waiting);
    expect(get_agent_job).toHaveBeenCalledOnce();
    expect(updates).toHaveBeenCalledWith(waiting);
  });
});

function agent_job(stage: AgentJob["stage"]): AgentJob {
  return {
    job_id: "agent-019c0000000070008000000000000000",
    asset_id: "019c0000-0000-7000-8000-000000000000",
    agent_type: "transcript_correction",
    execution_mode: "automatic",
    stage,
    progress_percent: 35,
    message: stage,
    ai_model_id: "model-019c0000000070008000000000000000",
    segment_indices: [0],
    transcript_checksum: "checksum",
    question: null,
    error_message: null,
    created_at: "2026-08-24T00:00:00Z",
    updated_at: "2026-08-24T00:00:00Z",
  };
}
