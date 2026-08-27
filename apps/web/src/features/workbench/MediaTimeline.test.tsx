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
import type { MediaMarker, MediaMarkerUpdate } from "@/shared/types";
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
  set_time: vi.fn(),
  set_scroll_left: vi.fn(),
  set_scroll_top: vi.fn(),
}));

vi.mock("@xzdarcy/react-timeline-editor", () => ({
  Timeline: forwardRef<TimelineState, TimelineEditor>(
    function MockTimeline(props, ref) {
      timeline_mock.current_props = props;
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
        <div data-testid="timeline-editor-instance">
          {props.editorData.map((row) => (
            <div key={row.id} data-row-id={row.id}>
              {row.actions.map((action) => (
                <div
                  key={action.id}
                  data-action-id={action.id}
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

function render_timeline(options?: {
  added_marker?: MediaMarker;
  candidate_markers?: MediaMarker[];
  update_marker?: (
    marker_id: string,
    update: MediaMarkerUpdate,
  ) => Promise<void>;
}) {
  let replace_markers: (markers: MediaMarker[]) => void = () => undefined;
  let replace_asset_id: (asset_id: string) => void = () => undefined;
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
  const transcript = {
    asset_id: ASSET_ID,
    language: "zh",
    created_at: "2026-01-01T00:00:00Z",
    segments: [
      {
        start_seconds: 5,
        end_seconds: 8,
        text: "原始转写",
        emotion: null,
        audio_events: [],
      },
    ],
  };
  const segments = [
    {
      segment_id: "segment-0198d12345677890abcdef1234567890",
      asset_id: ASSET_ID,
      start_seconds: 45,
      end_seconds: 60,
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
    replace_markers = set_markers;
    replace_asset_id = set_asset_id;
    return (
      <MediaTimeline
        asset_id={asset_id}
        duration_seconds={120}
        current_time={30.023}
        is_paused
        playback_rate={1}
        transcript={transcript}
        segments={segments}
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
  return { ...callbacks, replace_markers, replace_asset_id, result };
}

describe("MediaTimeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    timeline_mock.current_props = null;
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
    expect(timeline_mock.set_scroll_left).toHaveBeenLastCalledWith(200);
    expect(result.container).toContainElement(editor_instance);
  });

  it("keeps pointer time anchored while zooming and resets only for a new asset", () => {
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
    const pointer_time_before = (200 + 400 - 16) / 80;

    fireEvent.wheel(host, {
      altKey: true,
      clientX: 416,
      deltaY: -100,
    });

    const zoom =
      (timeline_props().scaleWidth ?? 0) / (timeline_props().scale ?? 1);
    const scroll_left = timeline_mock.set_scroll_left.mock.calls.at(-1)?.[0];
    const pointer_time_after = (scroll_left + 400 - 16) / zoom;
    expect(zoom).toBeCloseTo(88);
    expect(
      Math.abs(pointer_time_after - pointer_time_before),
    ).toBeLessThanOrEqual(0.01);

    act(() => {
      replace_markers([{ ...POINT_MARKER, importance: 5 }, RANGE_MARKER]);
    });
    expect(screen.getByTestId("timeline-editor-instance")).toBe(
      editor_instance,
    );
    expect(
      (timeline_props().scaleWidth ?? 0) / (timeline_props().scale ?? 1),
    ).toBeCloseTo(88);
    expect(timeline_mock.set_scroll_left).toHaveBeenLastCalledWith(scroll_left);

    act(() => replace_asset_id("asset-new"));
    expect(
      (timeline_props().scaleWidth ?? 0) / (timeline_props().scale ?? 1),
    ).toBe(80);
    expect(timeline_mock.set_scroll_left).toHaveBeenLastCalledWith(0);
  });
});
