import { describe, expect, it } from "vitest";

import {
  focus_context_attachment,
  timeline_agent_focus,
  transcript_context_attachment,
} from "./timeline_agent_context";

const ASSET_ID = "asset-0198d12345677890abcdef1234567890";

describe("timeline agent context", () => {
  it("keeps selected subtitle order, text and temporal bounds", () => {
    const attachment = transcript_context_attachment(
      ASSET_ID,
      {
        asset_id: ASSET_ID,
        language: "zh",
        created_at: "2026-01-01T00:00:00Z",
        segments: [
          segment(1, 2, "第一段"),
          segment(3, 4, "第二段"),
          segment(5, 7, "第三段"),
        ],
      },
      [2, 0, 2],
    );

    expect(attachment).toMatchObject({
      kind: "transcript_selection",
      start_seconds: 1,
      end_seconds: 7,
      snapshot_text: "第一段\n第三段",
      selection_start: 0,
      selection_end: 2,
    });
  });

  it("only exposes a complete focus range", () => {
    expect(
      focus_context_attachment({
        selection_id: "focus-selection-0198d12345677890abcdef1234567890",
        asset_id: ASSET_ID,
        in_seconds: 10,
        out_seconds: null,
        revision: 1,
        updated_at: "2026-01-01T00:00:00Z",
      }),
    ).toBeNull();
  });

  it("describes the active panel and chapter without limiting video scope", () => {
    const focus = timeline_agent_focus({
      playhead_seconds: 12,
      segments: [
        media_segment("segment-1", 0, 10, "开场"),
        media_segment("segment-2", 10, 20, "核心概念"),
      ],
      selected_marker_ids: ["marker-1"],
      selected_transcript_indices: [],
      focus_selection: null,
    });

    expect(focus).toMatchObject({
      workspace: "markers",
      surface: "markers",
      label: "标记面板 · 第 2 章",
      chapter: {
        segment_id: "segment-2",
        index: 2,
        title: "核心概念",
      },
      selected_marker_ids: ["marker-1"],
    });
  });
});

function segment(start_seconds: number, end_seconds: number, text: string) {
  return {
    start_seconds,
    end_seconds,
    text,
    emotion: null,
    audio_events: [],
  };
}

function media_segment(
  segment_id: string,
  start_seconds: number,
  end_seconds: number,
  title: string,
) {
  return {
    segment_id,
    asset_id: ASSET_ID,
    start_seconds,
    end_seconds,
    title,
    detailed_summary: null,
    transcript_text: null,
    speaker_name: null,
    key_frame_paths: [],
    visual_description: null,
    ocr_text: null,
    formula_latex: [],
    marker_ids: [],
    tags: [],
  };
}
