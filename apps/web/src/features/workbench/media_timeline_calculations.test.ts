import { describe, expect, it } from "vitest";

import { DEFAULT_ANALYSIS_STRATEGY } from "@/shared/analysis";
import type {
  EventAnalysis,
  MediaMarker,
  MediaSegment,
  TranscriptSegment,
} from "@/shared/types";
import {
  MAXIMUM_ZOOM_PIXELS_PER_SECOND,
  MINIMUM_ZOOM_PIXELS_PER_SECOND,
  TIMELINE_TRACK_IDS,
  build_timeline_rows,
  calculate_zoom_viewport,
  consume_timeline_wheel_zoom_frame,
  create_timeline_render_window,
  extend_timeline_render_window,
  filter_timeline_rows_for_window,
  normalize_wheel_delta,
  round_marker_time,
  timeline_content_duration,
  type MediaTimelineAction,
  type TimelineRow,
} from "./media_timeline_calculations";

describe("media timeline calculations", () => {
  it("clamps zoom while preserving the pointer time", () => {
    const viewport = { zoom_pixels_per_second: 80, scroll_left: 200 };
    const result = calculate_zoom_viewport({
      viewport,
      requested_zoom: MAXIMUM_ZOOM_PIXELS_PER_SECOND * 2,
      anchor_x: 300,
      viewport_width: 800,
      scale_count: 120,
    });

    const pointer_time_before = (viewport.scroll_left + 300 - 16) / 80;
    const pointer_time_after =
      (result.scroll_left + 300 - 16) / result.zoom_pixels_per_second;
    expect(result.zoom_pixels_per_second).toBe(MAXIMUM_ZOOM_PIXELS_PER_SECOND);
    expect(pointer_time_after).toBeCloseTo(pointer_time_before);
  });

  it("clamps zoom scroll to the rendered content bounds", () => {
    const result = calculate_zoom_viewport({
      viewport: { zoom_pixels_per_second: 80, scroll_left: 8_816 },
      requested_zoom: 40,
      anchor_x: 700,
      viewport_width: 800,
      scale_count: 120,
    });

    expect(result.zoom_pixels_per_second).toBe(40);
    expect(result.scroll_left).toBe(4_016);
  });

  it("resets scroll when zoomed content fits inside the viewport", () => {
    const result = calculate_zoom_viewport({
      viewport: { zoom_pixels_per_second: 80, scroll_left: 200 },
      requested_zoom: MINIMUM_ZOOM_PIXELS_PER_SECOND,
      anchor_x: 400,
      viewport_width: 800,
      scale_count: 120,
    });

    expect(result.scroll_left).toBe(0);
  });

  it("normalizes pixel, line, page and invalid wheel deltas", () => {
    expect(normalize_wheel_delta(2, 0, 600)).toBe(2);
    expect(normalize_wheel_delta(2, 1, 600)).toBe(32);
    expect(normalize_wheel_delta(2, 2, 600)).toBe(1_200);
    expect(normalize_wheel_delta(Number.NaN, 0, 600)).toBe(0);
  });

  it("limits one wheel frame and preserves unconsumed input", () => {
    const result = consume_timeline_wheel_zoom_frame({
      viewport: { zoom_pixels_per_second: 80, scroll_left: 0 },
      events: [{ logarithmic_delta: 2, anchor_x: 200, viewport_width: 800 }],
      scale_count: 120,
    });

    expect(result.viewport.zoom_pixels_per_second).toBe(100);
    expect(result.remaining_events).toHaveLength(1);
    expect(result.remaining_events[0]?.logarithmic_delta).toBeGreaterThan(0);
  });

  it("creates and extends render windows without exceeding media bounds", () => {
    const viewport = { zoom_pixels_per_second: 100, scroll_left: 500 };
    const created = create_timeline_render_window({
      viewport,
      canvas_width: 1_000,
      duration: 60,
    });
    const extended = extend_timeline_render_window({
      render_window: { start_seconds: 0, end_seconds: 2 },
      viewport,
      canvas_width: 1_000,
      duration: 60,
    });

    expect(created.start_seconds).toBeGreaterThanOrEqual(0);
    expect(created.end_seconds).toBeLessThanOrEqual(60);
    expect(extended.start_seconds).toBeLessThanOrEqual(created.start_seconds);
    expect(extended.end_seconds).toBeGreaterThanOrEqual(created.end_seconds);
  });

  it("keeps marker actions mounted while virtualizing read-only tracks", () => {
    const rows: TimelineRow[] = [
      {
        id: TIMELINE_TRACK_IDS.marker,
        actions: [{ id: "marker", start: 0, end: 1, effectId: "marker" }],
      },
      {
        id: TIMELINE_TRACK_IDS.event,
        actions: [
          { id: "outside", start: 0, end: 1, effectId: "event" },
          { id: "inside", start: 10, end: 12, effectId: "event" },
        ],
      },
    ];

    const filtered = filter_timeline_rows_for_window(rows, {
      start_seconds: 8,
      end_seconds: 14,
    });
    expect(filtered[0]?.actions).toHaveLength(1);
    expect(filtered[1]?.actions.map((action) => action.id)).toEqual(["inside"]);
  });

  it("builds bounded rows for point markers and source content", () => {
    const transcript_segments: TranscriptSegment[] = [
      {
        start_seconds: 1,
        end_seconds: 2,
        text: "hello",
        emotion: null,
        audio_events: [],
      },
    ];
    const segments: MediaSegment[] = [
      {
        segment_id: "segment-01890f4c7a2b7cc298c4dc0c0c07398f",
        asset_id: "asset-01890f4c7a2b7cc298c4dc0c0c07398f",
        start_seconds: 3,
        end_seconds: 4,
        title: "event",
        detailed_summary: null,
        transcript_text: null,
        speaker_name: null,
        key_frame_paths: [],
        visual_description: null,
        ocr_text: null,
        marker_ids: [],
        tags: [],
      },
    ];
    const markers: MediaMarker[] = [
      {
        marker_id: "marker-01890f4c7a2b7cc298c4dc0c0c07398f",
        asset_id: "asset-01890f4c7a2b7cc298c4dc0c0c07398f",
        start_seconds: 9.95,
        end_seconds: null,
        importance: 3,
      },
    ];

    const rows = build_timeline_rows({
      transcript_segments,
      segments,
      markers,
      candidate_markers: [],
      analysis_strategy: DEFAULT_ANALYSIS_STRATEGY,
      duration: 10,
      selected_marker_id: markers[0]?.marker_id ?? null,
    });
    expect(rows).toHaveLength(3);
    expect(rows[0]?.actions[0]?.end).toBeLessThanOrEqual(10);
    expect(rows[1]?.actions).toHaveLength(1);
    expect(rows[2]?.actions).toHaveLength(1);
  });

  it("groups identical event targets and assigns overlapping targets to stable lanes", () => {
    const source_summary = {
      transcript_digest: "transcript",
      target_digest: "target",
      timeline_digest: "timeline",
    };
    const base_analysis = {
      asset_id: "asset-01890f4c7a2b7cc298c4dc0c0c07398f",
      conclusion: "conclusion",
      key_points: [],
      evidence: [],
      preset_id: "course_notes",
      preset_version: 1,
      depth: "balanced" as const,
      user_input: null,
      ai_model_id: "model-01890f4c7a2b7cc298c4dc0c0c07398f",
      source_summary,
      status: "valid" as const,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
    const analyses: EventAnalysis[] = [
      {
        ...base_analysis,
        event_analysis_id: "event-analysis-01890f4c7a2b7cc298c4dc0c0c073981",
        target: {
          source: "marker",
          marker_id: "marker-01890f4c7a2b7cc298c4dc0c0c073981",
          start_seconds: 10,
          end_seconds: 20,
        },
        title: "first",
      },
      {
        ...base_analysis,
        event_analysis_id: "event-analysis-01890f4c7a2b7cc298c4dc0c0c073982",
        target: {
          source: "marker",
          marker_id: "marker-01890f4c7a2b7cc298c4dc0c0c073981",
          start_seconds: 10,
          end_seconds: 20,
        },
        title: "second",
      },
      {
        ...base_analysis,
        event_analysis_id: "event-analysis-01890f4c7a2b7cc298c4dc0c0c073983",
        target: {
          source: "focus_selection",
          selection_id: "focus-selection-01890f4c7a2b7cc298c4dc0c0c073981",
          start_seconds: 15,
          end_seconds: 25,
        },
        title: "overlap",
      },
      {
        ...base_analysis,
        event_analysis_id: "event-analysis-01890f4c7a2b7cc298c4dc0c0c073984",
        target: {
          source: "marker",
          marker_id: "marker-01890f4c7a2b7cc298c4dc0c0c073984",
          start_seconds: 25,
          end_seconds: 30,
        },
        title: "after",
      },
    ];

    const rows = build_timeline_rows({
      transcript_segments: [],
      segments: [],
      markers: [],
      candidate_markers: [],
      analysis_strategy: DEFAULT_ANALYSIS_STRATEGY,
      duration: 40,
      selected_marker_id: null,
      event_analyses: analyses,
    });
    const event_rows = rows.filter((row) =>
      row.id.startsWith(TIMELINE_TRACK_IDS.event_analysis_prefix),
    );
    const first_lane_actions = event_rows[0]?.actions as MediaTimelineAction[];

    expect(event_rows).toHaveLength(2);
    expect(first_lane_actions).toHaveLength(2);
    expect(first_lane_actions[0]?.data.event_analysis_ids).toEqual([
      analyses[0]?.event_analysis_id,
      analyses[1]?.event_analysis_id,
    ]);
    expect(first_lane_actions[1]?.data.event_analysis_ids).toEqual([
      analyses[3]?.event_analysis_id,
    ]);
    expect(
      (event_rows[1]?.actions[0] as MediaTimelineAction).data
        .event_analysis_ids,
    ).toEqual([analyses[2]?.event_analysis_id]);
  });

  it("derives content duration and rounds marker time consistently", () => {
    expect(timeline_content_duration(null, [], [], [], [])).toBe(1);
    expect(
      timeline_content_duration(
        2,
        [
          {
            start_seconds: 0,
            end_seconds: 8,
            text: "segment",
            emotion: null,
            audio_events: [],
          },
        ],
        [],
        [],
        [],
      ),
    ).toBe(8);
    expect(round_marker_time(MINIMUM_ZOOM_PIXELS_PER_SECOND / 100)).toBe(0.05);
  });
});
