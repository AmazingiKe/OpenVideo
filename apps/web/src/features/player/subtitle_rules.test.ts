import { describe, expect, it } from "vitest";

import {
  active_subtitle_segment,
  subtitle_is_evidence,
} from "./subtitle_rules";

describe("subtitle_rules", () => {
  const segments = [
    {
      start_seconds: 1,
      end_seconds: 3,
      text: " 第一段字幕 ",
      emotion: null,
      audio_events: [],
    },
    {
      start_seconds: 3,
      end_seconds: 5,
      text: "第二段字幕",
      emotion: null,
      audio_events: [],
    },
  ];

  it("shows the transcript segment that covers the current playback time", () => {
    expect(active_subtitle_segment(segments, 1)?.text.trim()).toBe(
      "第一段字幕",
    );
    expect(active_subtitle_segment(segments, 2.5)?.text.trim()).toBe(
      "第一段字幕",
    );
    expect(active_subtitle_segment(segments, 3)?.text.trim()).toBe(
      "第二段字幕",
    );
  });

  it("hides subtitles outside transcript segments", () => {
    expect(active_subtitle_segment(segments, 0.5)).toBeNull();
    expect(active_subtitle_segment(segments, 5)).toBeNull();
  });

  it("marks only subtitles overlapping the clicked evidence range", () => {
    expect(
      subtitle_is_evidence(segments[0]!, {
        evidence_id: "evidence-0198d12345677890abcdef1234567890",
        start_seconds: 2.5,
        end_seconds: 3.5,
      }),
    ).toBe(true);
    expect(
      subtitle_is_evidence(segments[0]!, {
        evidence_id: "evidence-0198d12345677890abcdef1234567890",
        start_seconds: 4,
        end_seconds: 5,
      }),
    ).toBe(false);
  });
});
