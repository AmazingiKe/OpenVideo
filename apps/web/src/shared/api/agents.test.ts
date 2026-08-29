import { afterEach, describe, expect, it, vi } from "vitest";

import { stream_unified_agent_run } from "./agents";

describe("stream_unified_agent_run", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("resumes from the last persisted sequence and parses streamed events", async () => {
    const fetch_mock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          "id: 8\n" +
            "event: message.delta\n" +
            'data: {"event_id":"event-8","sequence":8,"content":"继续内容"}\n\n',
          { headers: { "Content-Type": "text/event-stream" } },
        ),
      );
    vi.stubGlobal("fetch", fetch_mock);
    const received: unknown[] = [];

    await stream_unified_agent_run(
      "run-1",
      received.push.bind(received),
      undefined,
      7,
    );

    expect(fetch_mock).toHaveBeenCalledWith("/api/agent-runs/run-1/events", {
      signal: undefined,
      headers: { "Last-Event-ID": "7" },
    });
    expect(received).toEqual([
      {
        event: "message.delta",
        data: {
          event_id: "event-8",
          sequence: 8,
          content: "继续内容",
        },
      },
    ]);
  });
});
