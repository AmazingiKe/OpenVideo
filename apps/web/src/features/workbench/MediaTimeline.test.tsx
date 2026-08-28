import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { forwardRef, useImperativeHandle, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  TimelineEditor,
  TimelineState,
} from "@xzdarcy/react-timeline-editor";

import { DEFAULT_ANALYSIS_STRATEGY } from "@/shared/analysis";
import type {
  MediaMarker,
  MediaMarkerUpdate,
  MediaSegment,
  TranscriptSegment,
} from "@/shared/types";
import { MediaTimeline } from "./MediaTimeline";

type MockTimelineAction =
  TimelineEditor["editorData"][number]["actions"][number] & {
    data: {
      kind: "marker" | "candidate" | "transcript" | "event";
      source_id?: string;
      source_index?: number;
      marker_shape?: "point" | "range";
      marker_anchor_seconds?: number;
      rendered_start_seconds?: number;
    };
  };

const timeline_mock = vi.hoisted(() => ({
  current_props: null as TimelineEditor | null,
  viewport_events: [] as Array<{
    type: "render" | "scroll";
    value: number;
  }>,
  set_time: vi.fn(),
  set_scroll_left: vi.fn(),
  set_scroll_top: vi.fn(),
}));

vi.mock("@xzdarcy/react-timeline-editor", () => ({
  Timeline: forwardRef<TimelineState, TimelineEditor>(
    function MockTimeline(props, ref) {
      timeline_mock.current_props = props;
      timeline_mock.viewport_events.push({
        type: "render",
        value: (props.scaleWidth ?? 0) / (props.scale ?? 1),
      });
      useImperativeHandle(
        ref,
        () =>
          ({
            setTime: timeline_mock.set_time,
            setScrollLeft: timeline_mock.set_scroll_left,
            setScrollTop: timeline_mock.set_scroll_top,
          }) as unknown as TimelineState,
      );

      return (
        <div
          data-testid="timeline-editor-instance"
          className="ReactVirtualized__Grid"
          role="grid"
          aria-readonly="true"
        >
          {props.editorData.map((row) => (
            <div key={row.id} data-row-id={row.id} role="row">
              {row.actions.map((action) => (
                <div
                  key={action.id}
                  data-action-id={action.id}
                  role="gridcell"
                  onClick={(event) =>
                    props.onClickActionOnly?.(event, {
                      action,
                      row,
                      time: action.start,
                    })
                  }
                  onDoubleClick={(event) =>
                    props.onDoubleClickAction?.(event, {
                      action,
                      row,
                      time: action.start,
                    })
                  }
                  onContextMenu={(event) =>
                    props.onContextMenuAction?.(event, {
                      action,
                      row,
                      time: action.start,
                    })
                  }
                >
                  {props.getActionRender?.(action, row)}
                </div>
              ))}
              <button
                type="button"
                aria-label={`${row.id} 空白处`}
                onDoubleClick={(event) =>
                  props.onDoubleClickRow?.(event, { row, time: 22.027 })
                }
              />
            </div>
          ))}
        </div>
      );
    },
  ),
}));

const ASSET_ID = "asset-0198d12345677890abcdef1234567890";
const POINT_MARKER: MediaMarker = {
  marker_id: "marker-0198d12345677890abcdef1234567890",
  asset_id: ASSET_ID,
  start_seconds: 20,
  end_seconds: null,
  importance: 3,
};
const RANGE_MARKER: MediaMarker = {
  marker_id: "marker-0198d12345677890abcdef1234567891",
  asset_id: ASSET_ID,
  start_seconds: 32,
  end_seconds: 36,
  importance: 5,
};
const CANDIDATE_MARKER: MediaMarker = {
  marker_id: "marker-0198d12345677890abcdef1234567892",
  asset_id: ASSET_ID,
  start_seconds: 70,
  end_seconds: 75,
  importance: 2,
};

function timeline_props(): TimelineEditor {
  if (!timeline_mock.current_props) {
    throw new Error("Timeline has not rendered");
  }
  return timeline_mock.current_props;
}

function action_by_kind(kind: MockTimelineAction["data"]["kind"]) {
  for (const row of timeline_props().editorData) {
    const action = row.actions.find(
      (item) => (item as MockTimelineAction).data.kind === kind,
    );
    if (action) return action as MockTimelineAction;
  }
  throw new Error(`Missing ${kind} action`);
}

function transcript_actions(): MockTimelineAction[] {
  const row = timeline_props().editorData.find(
    (candidate) => candidate.id === "timeline-transcript-track",
  );
  if (!row) throw new Error("Missing transcript row");
  return row.actions as MockTimelineAction[];
}

function install_animation_frame_mock() {
  let next_frame_id = 1;
  const frames = new Map<number, FrameRequestCallback>();
  const request_frame = vi
    .spyOn(window, "requestAnimationFrame")
    .mockImplementation((callback) => {
      const frame_id = next_frame_id;
      next_frame_id += 1;
      frames.set(frame_id, callback);
      return frame_id;
    });
  const cancel_frame = vi
    .spyOn(window, "cancelAnimationFrame")
    .mockImplementation((frame_id) => {
      frames.delete(frame_id);
    });

  return {
    request_frame,
    cancel_frame,
    frames,
    run_next_frame(frame_time = performance.now()) {
      const next_frame = frames.entries().next().value as
        [number, FrameRequestCallback] | undefined;
      if (!next_frame) throw new Error("Missing animation frame");
      frames.delete(next_frame[0]);
      act(() => next_frame[1](frame_time));
    },
  };
}

function render_timeline(options?: {
  added_marker?: MediaMarker;
  candidate_markers?: MediaMarker[];
  duration_seconds?: number;
  is_paused?: boolean;
  playback_rate?: number;
  transcript_segments?: TranscriptSegment[];
  analysis_segments?: MediaSegment[];
  update_marker?: (
    marker_id: string,
    update: MediaMarkerUpdate,
  ) => Promise<void>;
}) {
  let replace_markers: (markers: MediaMarker[]) => void = () => undefined;
  let replace_asset_id: (asset_id: string) => void = () => undefined;
  let refresh_parent: () => void = () => undefined;
  const callbacks = {
    scrub_to: vi.fn(),
    seek_to: vi.fn(),
    toggle_playback: vi.fn(),
    change_playback_rate: vi.fn(),
    add_marker: vi.fn().mockResolvedValue(options?.added_marker),
    update_marker:
      options?.update_marker ?? vi.fn().mockResolvedValue(undefined),
    delete_marker: vi.fn().mockResolvedValue(undefined),
    update_transcript: vi.fn().mockResolvedValue(undefined),
    change_selected_transcript_indices: vi.fn(),
  };
  const default_transcript_segments: TranscriptSegment[] = [
    {
      start_seconds: 5,
      end_seconds: 8,
      text: "原始转写",
      emotion: null,
      audio_events: [],
    },
  ];
  const default_analysis_segments: MediaSegment[] = [
    {
      segment_id: "segment-0198d12345677890abcdef1234567890",
      asset_id: ASSET_ID,
      start_seconds: 12,
      end_seconds: 18,
      title: "矩阵推导",
      detailed_summary: null,
      transcript_text: null,
      speaker_name: null,
      key_frame_paths: [],
      visual_description: null,
      ocr_text: null,
      marker_ids: [],
      tags: ["公式"],
    },
  ];

  function TimelineHarness() {
    const [asset_id, set_asset_id] = useState(ASSET_ID);
    const [markers, set_markers] = useState([POINT_MARKER, RANGE_MARKER]);
    const [, set_refresh_revision] = useState(0);
    replace_markers = set_markers;
    replace_asset_id = set_asset_id;
    refresh_parent = () => set_refresh_revision((current) => current + 1);
    return (
      <MediaTimeline
        asset_id={asset_id}
        duration_seconds={options?.duration_seconds ?? 120}
        current_time={30.023}
        is_paused={options?.is_paused ?? true}
        playback_rate={options?.playback_rate ?? 1}
        transcript={{
          asset_id: ASSET_ID,
          language: "zh",
          created_at: "2026-01-01T00:00:00Z",
          segments: options?.transcript_segments ?? default_transcript_segments,
        }}
        segments={options?.analysis_segments ?? default_analysis_segments}
        markers={markers}
        candidate_markers={options?.candidate_markers}
        analysis_strategy={DEFAULT_ANALYSIS_STRATEGY}
        marker_error={null}
        on_scrub={callbacks.scrub_to}
        on_seek={callbacks.seek_to}
        on_toggle_playback={callbacks.toggle_playback}
        on_playback_rate_change={callbacks.change_playback_rate}
        on_selected_transcript_indices_change={
          callbacks.change_selected_transcript_indices
        }
        on_add_marker={callbacks.add_marker}
        on_update_marker={callbacks.update_marker}
        on_delete_marker={callbacks.delete_marker}
        on_update_transcript={callbacks.update_transcript}
      />
    );
  }

  const result = render(<TimelineHarness />);
  return {
    ...callbacks,
    replace_markers,
    replace_asset_id,
    refresh_parent,
    result,
  };
}

describe("MediaTimeline", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    timeline_mock.current_props = null;
    timeline_mock.viewport_events.length = 0;
    timeline_mock.set_scroll_left.mockImplementation((scroll_left) => {
      timeline_mock.viewport_events.push({
        type: "scroll",
        value: scroll_left,
      });
    });
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  it("maps four action kinds without exposing mutable business objects", () => {
    const source_markers = [POINT_MARKER, RANGE_MARKER, CANDIDATE_MARKER].map(
      (marker) => ({ ...marker }),
    );
    const source_snapshot = structuredClone(source_markers);
    render_timeline({ candidate_markers: [source_markers[2]] });

    expect(timeline_props().editorData).toHaveLength(3);
    expect(timeline_props().editorData.map((row) => row.id)).toEqual([
      "timeline-marker-track",
      "timeline-transcript-track",
      "timeline-event-track",
    ]);
    const marker_action = action_by_kind("marker");
    const candidate_action = action_by_kind("candidate");
    const transcript_action = action_by_kind("transcript");
    const event_action = action_by_kind("event");
    expect(marker_action).toMatchObject({ movable: true, flexible: false });
    expect(candidate_action).toMatchObject({ movable: false, flexible: false });
    expect(transcript_action).toMatchObject({
      movable: false,
      flexible: false,
    });
    expect(event_action).toMatchObject({ movable: false, flexible: false });

    marker_action.start = 99;
    candidate_action.end = 100;
    expect(source_markers).toEqual(source_snapshot);
    expect(screen.getByLabelText("标记，可编辑")).toBeInTheDocument();
    expect(screen.getByLabelText("转写，只读")).toBeInTheDocument();
    expect(screen.getByLabelText("分析事件，只读")).toBeInTheDocument();
  });

  it("normalizes accessibility semantics only for newly added subtrees", async () => {
    render_timeline();
    const timeline_host = screen.getByLabelText(/时间线画布/);
    const editor_instance = screen.getByTestId("timeline-editor-instance");

    expect(editor_instance).toHaveAttribute("role", "group");
    expect(editor_instance).toHaveAttribute("aria-label", "时间线轨道内容");
    expect(editor_instance).not.toHaveAttribute("aria-readonly");
    expect(editor_instance.querySelector('[role="row"]')).toBeNull();
    expect(editor_instance.querySelector('[role="gridcell"]')).toBeNull();

    const host_query = vi.spyOn(timeline_host, "querySelectorAll");
    const added_grid = document.createElement("div");
    added_grid.className = "ReactVirtualized__Grid";
    added_grid.setAttribute("role", "grid");
    added_grid.setAttribute("aria-readonly", "true");
    const added_row = document.createElement("div");
    added_row.setAttribute("role", "row");
    added_grid.append(added_row);
    timeline_host.append(added_grid);

    await waitFor(() => expect(added_grid).toHaveAttribute("role", "group"));
    expect(added_grid).not.toHaveAttribute("aria-readonly");
    expect(added_row).not.toHaveAttribute("role");
    expect(host_query).not.toHaveBeenCalled();
  });

  it("limits two thousand transcript actions to the initial render window", () => {
    const segments: TranscriptSegment[] = Array.from(
      { length: 2_000 },
      (_, index) => ({
        start_seconds: index,
        end_seconds: index + 1,
        text: `转写 ${index}`,
        emotion: null,
        audio_events: [],
      }),
    );

    render_timeline({
      duration_seconds: segments.length,
      transcript_segments: segments,
      analysis_segments: [],
    });

    const actions = transcript_actions();
    expect(actions.length).toBeLessThan(100);
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.length).not.toBe(segments.length);
  });

  it("moves the render window across a boundary without changing source indices", () => {
    const animation_frames = install_animation_frame_mock();
    const segments: TranscriptSegment[] = Array.from(
      { length: 2_000 },
      (_, index) => ({
        start_seconds: index,
        end_seconds: index + 1,
        text: `转写 ${index}`,
        emotion: null,
        audio_events: [],
      }),
    );
    render_timeline({
      duration_seconds: segments.length,
      transcript_segments: segments,
      analysis_segments: [],
    });
    const initial_actions = transcript_actions();
    const initial_by_source_index = new Map(
      initial_actions.map((action) => [action.data.source_index, action]),
    );

    act(() => {
      timeline_props().onScroll?.({
        clientHeight: 144,
        clientWidth: 1024,
        scrollHeight: 144,
        scrollLeft: 1600,
        scrollTop: 0,
        scrollWidth: segments.length * 80,
      });
    });
    animation_frames.run_next_frame();

    const moved_actions = transcript_actions();
    expect(moved_actions[0]?.data.source_index).toBe(13);
    expect(moved_actions.at(-1)?.data.source_index).toBe(39);
    for (const action of moved_actions) {
      expect(action.id).toBe(`transcript-${action.data.source_index}`);
    }
    expect(
      moved_actions.find((action) => action.data.source_index === 15),
    ).toBe(initial_by_source_index.get(15));
  });

  it("keeps editor data and viewport stable inside the buffered window", () => {
    const { refresh_parent } = render_timeline();
    const editor_instance = screen.getByTestId("timeline-editor-instance");
    const initial_editor_data = timeline_props().editorData;
    const initial_zoom =
      (timeline_props().scaleWidth ?? 0) / (timeline_props().scale ?? 1);

    act(() => {
      timeline_props().onScroll?.({
        clientHeight: 144,
        clientWidth: 1024,
        scrollHeight: 144,
        scrollLeft: 80,
        scrollTop: 0,
        scrollWidth: 9600,
      });
    });
    expect(timeline_props().editorData).toBe(initial_editor_data);

    fireEvent.click(screen.getByRole("button", { name: /转写：原始转写/ }));
    expect(timeline_props().editorData).toBe(initial_editor_data);

    act(() => refresh_parent());
    expect(timeline_props().editorData).toBe(initial_editor_data);
    expect(screen.getByTestId("timeline-editor-instance")).toBe(
      editor_instance,
    );
    expect(
      (timeline_props().scaleWidth ?? 0) / (timeline_props().scale ?? 1),
    ).toBe(initial_zoom);
    expect(timeline_mock.set_scroll_left).not.toHaveBeenCalled();
    expect(timeline_mock.set_scroll_top).not.toHaveBeenCalled();
  });

  it("shares playback controls and timecode with the player state", async () => {
    const { toggle_playback, change_playback_rate } = render_timeline();

    expect(screen.getByLabelText("当前播放时间和总时长")).toHaveTextContent(
      "00:30 / 02:00",
    );
    fireEvent.click(screen.getByRole("button", { name: "播放" }));
    fireEvent.keyDown(
      screen.getByRole("combobox", { name: "播放倍速，当前 1 倍" }),
      { key: "Enter" },
    );
    fireEvent.click(await screen.findByRole("option", { name: "1.5×" }));

    expect(toggle_playback).toHaveBeenCalledOnce();
    expect(change_playback_rate).toHaveBeenCalledWith(1.5);
  });

  it("previews while dragging and seeks the source only after release", () => {
    const { scrub_to, seek_to } = render_timeline();

    act(() => timeline_props().onCursorDrag?.(42.027));
    expect(scrub_to).toHaveBeenCalledWith(42.027);
    expect(seek_to).not.toHaveBeenCalled();

    act(() => timeline_props().onCursorDragEnd?.(42.027));
    expect(seek_to).toHaveBeenCalledWith(42.027);
  });

  it("animates the playback head every display frame while playing", () => {
    vi.spyOn(performance, "now").mockReturnValue(100);
    const animation_frames = install_animation_frame_mock();
    const { result } = render_timeline({
      is_paused: false,
      playback_rate: 2,
    });
    timeline_mock.set_time.mockClear();

    animation_frames.run_next_frame(116);
    expect(timeline_mock.set_time.mock.calls.at(-1)?.[0]).toBeCloseTo(30.055);
    expect(animation_frames.frames.size).toBe(1);

    animation_frames.run_next_frame(132);
    expect(timeline_mock.set_time.mock.calls.at(-1)?.[0]).toBeCloseTo(30.087);
    const pending_frame = [...animation_frames.frames.keys()][0];

    result.unmount();
    expect(animation_frames.cancel_frame).toHaveBeenCalledWith(pending_frame);
    expect(animation_frames.frames.size).toBe(0);
  });

  it("scrubs across the full ruler and commits the aligned time on release", () => {
    const { scrub_to, seek_to } = render_timeline();
    const ruler = screen.getByRole("slider", { name: "时间线播放头" });
    vi.spyOn(ruler, "getBoundingClientRect").mockReturnValue({
      x: 16,
      y: 0,
      left: 16,
      top: 0,
      right: 816,
      bottom: 32,
      width: 800,
      height: 32,
      toJSON: () => undefined,
    });
    ruler.setPointerCapture = vi.fn();
    ruler.releasePointerCapture = vi.fn();

    fireEvent.pointerDown(ruler, {
      button: 0,
      clientX: 416,
      pointerId: 7,
    });
    fireEvent.pointerMove(ruler, { clientX: 496, pointerId: 7 });

    expect(scrub_to).toHaveBeenLastCalledWith(5.8);
    expect(seek_to).not.toHaveBeenCalled();

    fireEvent.pointerUp(ruler, { clientX: 576, pointerId: 7 });
    expect(seek_to).toHaveBeenCalledWith(6.8);
    expect(timeline_mock.set_time).toHaveBeenLastCalledWith(6.8);
  });

  it("adds markers from the toolbar, shortcut, and marker row", async () => {
    const added_marker = { ...POINT_MARKER, marker_id: "marker-added" };
    const { add_marker } = render_timeline({ added_marker });

    fireEvent.click(screen.getByRole("button", { name: /添加标记/ }));
    fireEvent.keyDown(window, { key: "m", ctrlKey: true });
    fireEvent.doubleClick(
      screen.getByRole("button", {
        name: "timeline-marker-track 空白处",
      }),
    );

    await waitFor(() => expect(add_marker).toHaveBeenCalledTimes(3));
    expect(add_marker).toHaveBeenNthCalledWith(1, 30, null);
    expect(add_marker).toHaveBeenNthCalledWith(2, 30, null);
    expect(add_marker).toHaveBeenNthCalledWith(3, 22.05, null);
  });

  it("selects, seeks, edits, and saves transcript actions", async () => {
    const { seek_to, change_selected_transcript_indices, update_transcript } =
      render_timeline();
    const transcript_button = screen.getByRole("button", {
      name: /转写：原始转写/,
    });

    fireEvent.click(transcript_button);
    fireEvent.doubleClick(transcript_button);
    fireEvent.change(screen.getByLabelText("编辑转写文字"), {
      target: { value: " 修订后的转写 " },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(seek_to).toHaveBeenCalledWith(5);
    expect(change_selected_transcript_indices).toHaveBeenCalledWith([0]);
    await waitFor(() =>
      expect(update_transcript).toHaveBeenCalledWith(0, "修订后的转写"),
    );
  });

  it("opens marker editing with Enter and preserves rating and deletion", async () => {
    const { update_marker, delete_marker } = render_timeline();
    const marker_button = screen.getAllByRole("button", {
      name: /点标记/,
    })[0];

    fireEvent.keyDown(marker_button, { key: "Enter" });
    fireEvent.change(screen.getByLabelText("开始时间（秒）"), {
      target: { value: "21.13" },
    });
    fireEvent.submit(screen.getByLabelText("开始时间（秒）").closest("form")!);
    await waitFor(() =>
      expect(update_marker).toHaveBeenCalledWith(POINT_MARKER.marker_id, {
        start_seconds: 21.15,
        end_seconds: null,
      }),
    );
    await waitFor(() =>
      expect(screen.queryByLabelText("开始时间（秒）")).not.toBeInTheDocument(),
    );

    const current_marker_button = screen.getAllByRole("button", {
      name: /点标记/,
    })[0];
    fireEvent.keyDown(current_marker_button, { key: "F10", shiftKey: true });
    fireEvent.click(
      await screen.findByRole("menuitemradio", {
        name: /★★★★★/,
      }),
    );
    await waitFor(() =>
      expect(update_marker).toHaveBeenCalledWith(POINT_MARKER.marker_id, {
        importance: 5,
      }),
    );

    fireEvent.keyDown(current_marker_button, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    fireEvent.click(await screen.findByRole("button", { name: "删除标记" }));
    await waitFor(() =>
      expect(delete_marker).toHaveBeenCalledWith(POINT_MARKER.marker_id),
    );
  });

  it("persists move and resize only at interaction end with fixed precision", async () => {
    const { update_marker } = render_timeline();
    fireEvent.click(screen.getAllByRole("button", { name: /点标记/ })[0]);
    const point_action = action_by_kind("marker");
    expect(point_action).toMatchObject({
      selected: true,
      flexible: true,
      start: 10,
      end: 40,
    });

    expect(update_marker).not.toHaveBeenCalled();
    act(() => {
      timeline_props().onActionMoveEnd?.({
        action: point_action,
        row: timeline_props().editorData[0],
        start: 11.023,
        end: 31.023,
      });
    });
    await waitFor(() => expect(update_marker).toHaveBeenCalledOnce());
    expect(update_marker).toHaveBeenLastCalledWith(POINT_MARKER.marker_id, {
      start_seconds: 21,
      end_seconds: null,
    });

    act(() => {
      timeline_props().onActionResizeEnd?.({
        action: point_action,
        row: timeline_props().editorData[0],
        start: 12.02,
        end: 31.07,
        dir: "right",
      });
    });
    await waitFor(() => expect(update_marker).toHaveBeenCalledTimes(2));
    expect(update_marker).toHaveBeenLastCalledWith(POINT_MARKER.marker_id, {
      start_seconds: 12,
      end_seconds: 31.05,
    });

    act(() => {
      timeline_props().onActionMoveEnd?.({
        action: action_by_kind("transcript"),
        row: timeline_props().editorData[1],
        start: 9,
        end: 12,
      });
    });
    expect(update_marker).toHaveBeenCalledTimes(2);
  });

  it("rolls back a failed drag while keeping the editor and viewport", async () => {
    const update_marker = vi.fn().mockRejectedValue(new Error("保存失败"));
    const { result } = render_timeline({ update_marker });
    const editor_instance = screen.getByTestId("timeline-editor-instance");
    act(() => {
      timeline_props().onScroll?.({
        clientHeight: 144,
        clientWidth: 800,
        scrollHeight: 144,
        scrollLeft: 200,
        scrollTop: 0,
        scrollWidth: 9600,
      });
    });
    fireEvent.click(screen.getAllByRole("button", { name: /点标记/ })[0]);
    const original_action = action_by_kind("marker");

    act(() => {
      timeline_props().onActionMoveEnd?.({
        action: original_action,
        row: timeline_props().editorData[0],
        start: 13,
        end: 33,
      });
    });

    expect(
      await screen.findByText("标记时间保存失败，已恢复原位置"),
    ).toBeInTheDocument();
    expect(action_by_kind("marker").start).toBe(10);
    expect(screen.getByTestId("timeline-editor-instance")).toBe(
      editor_instance,
    );
    expect(timeline_mock.set_scroll_left).not.toHaveBeenCalled();
    expect(result.container).toContainElement(editor_instance);
  });

  it("keeps third-party scale geometry stable across zoom thresholds", () => {
    render_timeline();

    function expect_stable_geometry() {
      expect(timeline_props()).toMatchObject({
        scale: 1,
        scaleSplitCount: 1,
        minScaleCount: 120,
        maxScaleCount: 120,
      });
    }

    expect_stable_geometry();
    const zoom_out = screen.getByRole("button", { name: "缩小时间线" });
    for (let index = 0; index < 5; index += 1) {
      fireEvent.click(zoom_out);
      expect_stable_geometry();
    }
    expect(timeline_props().scaleWidth).toBeLessThan(27.43);

    const zoom_in = screen.getByRole("button", { name: "放大时间线" });
    for (let index = 0; index < 12; index += 1) {
      fireEvent.click(zoom_in);
      expect_stable_geometry();
    }
    expect(timeline_props().scaleWidth).toBe(320);
  });

  it("normalizes wheel units and applies exponential zoom in event order", () => {
    const animation_frames = install_animation_frame_mock();
    render_timeline();
    const host = screen.getByLabelText(/时间线画布/);
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 800,
      bottom: 176,
      width: 800,
      height: 176,
      toJSON: () => undefined,
    });

    fireEvent.wheel(host, {
      altKey: true,
      clientX: 400,
      deltaY: -16,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
    });
    fireEvent.wheel(host, {
      altKey: true,
      clientX: 300,
      deltaY: -1,
      deltaMode: WheelEvent.DOM_DELTA_LINE,
    });
    fireEvent.wheel(host, {
      altKey: true,
      clientX: 200,
      deltaY: -16 / 176,
      deltaMode: WheelEvent.DOM_DELTA_PAGE,
    });

    expect(animation_frames.frames.size).toBe(1);
    animation_frames.run_next_frame();
    expect(timeline_props().scaleWidth).toBeCloseTo(80 * Math.exp(0.048));
    expect(timeline_mock.set_scroll_left).toHaveBeenCalledOnce();
  });

  it("limits wheel zoom to one viewport commit and 0.8x–1.25x per frame", () => {
    const animation_frames = install_animation_frame_mock();
    render_timeline();
    const host = screen.getByLabelText(/时间线画布/);
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 800,
      bottom: 176,
      width: 800,
      height: 176,
      toJSON: () => undefined,
    });

    fireEvent.wheel(host, {
      altKey: true,
      clientX: 400,
      deltaY: -1_000,
    });
    animation_frames.run_next_frame();

    expect(timeline_props().scaleWidth).toBe(100);
    expect(timeline_mock.set_scroll_left).toHaveBeenCalledOnce();
    expect(animation_frames.frames.size).toBe(1);

    animation_frames.run_next_frame();
    expect(timeline_props().scaleWidth).toBe(125);
    expect(timeline_mock.set_scroll_left).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "重置时间线缩放" }));
    timeline_mock.set_scroll_left.mockClear();
    fireEvent.wheel(host, {
      altKey: true,
      clientX: 400,
      deltaY: 1_000,
    });
    animation_frames.run_next_frame();
    expect(timeline_props().scaleWidth).toBe(64);
    expect(timeline_mock.set_scroll_left).not.toHaveBeenCalled();
  });

  it("keeps editor data mounted during wheel zoom until idle settlement", () => {
    vi.useFakeTimers();
    const animation_frames = install_animation_frame_mock();
    const segments: TranscriptSegment[] = Array.from(
      { length: 2_000 },
      (_, index) => ({
        start_seconds: index,
        end_seconds: index + 1,
        text: `转写 ${index}`,
        emotion: null,
        audio_events: [],
      }),
    );
    render_timeline({
      duration_seconds: segments.length,
      transcript_segments: segments,
      analysis_segments: [],
    });
    const initial_editor_data = timeline_props().editorData;
    const editor_instance = screen.getByTestId("timeline-editor-instance");
    const host = screen.getByLabelText(/时间线画布/);
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 800,
      bottom: 176,
      width: 800,
      height: 176,
      toJSON: () => undefined,
    });

    fireEvent.wheel(host, {
      altKey: true,
      clientX: 400,
      deltaY: -50,
    });
    animation_frames.run_next_frame();

    expect(timeline_props().editorData).toBe(initial_editor_data);
    expect(screen.getByTestId("timeline-editor-instance")).toBe(
      editor_instance,
    );
    act(() => vi.advanceTimersByTime(100));
    expect(timeline_props().editorData).not.toBe(initial_editor_data);
    expect(transcript_actions().length).toBeLessThan(100);
    vi.useRealTimers();
  });

  it("batches Alt wheel zoom while preserving each event pointer anchor", () => {
    const animation_frames = install_animation_frame_mock();
    const { replace_markers, replace_asset_id } = render_timeline();
    const editor_instance = screen.getByTestId("timeline-editor-instance");
    const host = screen.getByLabelText(/时间线画布/);
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue({
      x: 16,
      y: 0,
      left: 16,
      top: 0,
      right: 816,
      bottom: 176,
      width: 800,
      height: 176,
      toJSON: () => undefined,
    });
    act(() => {
      timeline_props().onScroll?.({
        clientHeight: 144,
        clientWidth: 800,
        scrollHeight: 144,
        scrollLeft: 200,
        scrollTop: 0,
        scrollWidth: 9600,
      });
    });
    timeline_mock.set_scroll_left.mockClear();
    timeline_mock.viewport_events.length = 0;

    fireEvent.wheel(host, {
      altKey: true,
      clientX: 416,
      deltaY: -100,
    });
    fireEvent.wheel(host, {
      altKey: true,
      clientX: 216,
      deltaY: -50,
    });

    expect(animation_frames.frames.size).toBe(1);
    expect(
      (timeline_props().scaleWidth ?? 0) / (timeline_props().scale ?? 1),
    ).toBe(80);
    expect(timeline_mock.set_scroll_left).not.toHaveBeenCalled();

    animation_frames.run_next_frame();

    const zoom =
      (timeline_props().scaleWidth ?? 0) / (timeline_props().scale ?? 1);
    const scroll_left = timeline_mock.set_scroll_left.mock.calls.at(-1)?.[0];
    const first_zoom = 80 * Math.exp(0.1);
    const first_scroll_left = ((200 + 400 - 16) / 80) * first_zoom + 16 - 400;
    const second_pointer_time = (first_scroll_left + 200 - 16) / first_zoom;
    const pointer_time_after = (scroll_left + 200 - 16) / zoom;
    expect(zoom).toBeCloseTo(80 * Math.exp(0.15));
    expect(timeline_mock.set_scroll_left).toHaveBeenCalledOnce();
    const zoom_scroll_index = timeline_mock.viewport_events.findIndex(
      (event) => event.type === "scroll" && event.value === scroll_left,
    );
    const zoom_render_index = timeline_mock.viewport_events.findIndex(
      (event) => event.type === "render" && event.value === zoom,
    );
    expect(zoom_scroll_index).toBeGreaterThanOrEqual(0);
    expect(zoom_render_index).toBeGreaterThan(zoom_scroll_index);
    expect(
      Math.abs(pointer_time_after - second_pointer_time),
    ).toBeLessThanOrEqual(0.01);

    act(() => {
      replace_markers([{ ...POINT_MARKER, importance: 5 }, RANGE_MARKER]);
    });
    expect(screen.getByTestId("timeline-editor-instance")).toBe(
      editor_instance,
    );
    expect(
      (timeline_props().scaleWidth ?? 0) / (timeline_props().scale ?? 1),
    ).toBeCloseTo(80 * Math.exp(0.15));
    expect(timeline_mock.set_scroll_left).toHaveBeenLastCalledWith(scroll_left);

    act(() => replace_asset_id("asset-new"));
    expect(
      (timeline_props().scaleWidth ?? 0) / (timeline_props().scale ?? 1),
    ).toBe(80);
    expect(timeline_mock.set_scroll_left).toHaveBeenLastCalledWith(0);
  });

  it("cancels pending wheel tasks for tools, asset switches, and unmount", () => {
    const animation_frames = install_animation_frame_mock();
    const { replace_asset_id, result } = render_timeline();
    const host = screen.getByLabelText(/时间线画布/);
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 800,
      bottom: 176,
      width: 800,
      height: 176,
      toJSON: () => undefined,
    });

    fireEvent.wheel(host, {
      altKey: true,
      clientX: 400,
      deltaY: -100,
    });
    const tool_cancelled_frame = [...animation_frames.frames.keys()][0];
    fireEvent.click(screen.getByRole("button", { name: "放大时间线" }));
    expect(animation_frames.cancel_frame).toHaveBeenCalledWith(
      tool_cancelled_frame,
    );
    expect(animation_frames.frames.size).toBe(0);
    expect(
      (timeline_props().scaleWidth ?? 0) / (timeline_props().scale ?? 1),
    ).toBe(100);

    fireEvent.wheel(host, {
      altKey: true,
      clientX: 400,
      deltaY: -100,
    });
    const asset_cancelled_frame = [...animation_frames.frames.keys()][0];
    act(() => replace_asset_id("asset-new"));
    expect(animation_frames.cancel_frame).toHaveBeenCalledWith(
      asset_cancelled_frame,
    );
    expect(animation_frames.frames.size).toBe(0);

    const clear_timeout = vi.spyOn(window, "clearTimeout");
    fireEvent.wheel(host, {
      altKey: true,
      clientX: 400,
      deltaY: -100,
    });
    animation_frames.run_next_frame();
    fireEvent.click(screen.getByRole("button", { name: "重置时间线缩放" }));
    expect(clear_timeout).toHaveBeenCalled();

    fireEvent.wheel(host, {
      altKey: true,
      clientX: 400,
      deltaY: -100,
    });
    const unmount_cancelled_frame = [...animation_frames.frames.keys()][0];
    result.unmount();
    expect(animation_frames.cancel_frame).toHaveBeenCalledWith(
      unmount_cancelled_frame,
    );
    expect(animation_frames.frames.size).toBe(0);
  });
});
