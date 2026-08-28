import { describe, expect, it } from "vitest";

import { build_agent_timeline } from "./AgentPanelContent";
import type { AgentEvent, AgentRun } from "@/shared/types";

describe("build_agent_timeline", () => {
  it("uses run.metrics and never exposes raw reasoning content", () => {
    const events: AgentEvent[] = [
      event(1, "run.status", { input: "问题" }),
      event(2, "message.completed", {
        content: "答案",
        reasoning_content: "不应展示的原始思维链",
        metrics: { total_ms: 99_999 },
      }),
      event(3, "run.metrics", { total_ms: 1_500, retrieval_ms: 300 }),
    ];

    const timeline = build_agent_timeline(events);
    expect(timeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "message",
          role: "assistant",
          content: "答案",
          metrics: { total_ms: 1_500, retrieval_ms: 300 },
        }),
      ]),
    );
    expect(JSON.stringify(timeline)).not.toContain("不应展示的原始思维链");
  });

  it("falls back to persisted run timestamps for the total duration", () => {
    const events = [event(1, "message.completed", { content: "答案" })];
    const runs: AgentRun[] = [
      {
        run_id: "run-1",
        session_id: "session-1",
        request_key: "request-1",
        model_id: "model-1",
        stage: "complete",
        error_code: null,
        error_message: null,
        latest_event_sequence: 1,
        created_at: "2026-08-29T00:00:00Z",
        started_at: "2026-08-29T00:00:01Z",
        updated_at: "2026-08-29T00:00:04Z",
        completed_at: "2026-08-29T00:00:04Z",
      },
    ];

    expect(build_agent_timeline(events, runs)[0]).toMatchObject({
      metrics: { total_ms: 3_000 },
    });
  });
});

function event(
  sequence: number,
  event_type: AgentEvent["event_type"],
  payload: Record<string, unknown>,
): AgentEvent {
  return {
    event_id: `event-${sequence}`,
    session_id: "session-1",
    sequence,
    run_id: "run-1",
    event_type,
    payload,
    created_at: "2026-08-29T00:00:00Z",
  };
}
