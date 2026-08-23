import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { MediaTimeline } from "./MediaTimeline";

type MockClip = {
  id: string;
  label: string;
  timelineStart: number;
  metadata: { kind: string; source_index?: number };
};

type MockTrack = {
  id: string;
  name?: string;
  kind?: string;
  locked?: boolean;
  clips: MockClip[];
};

const timeline_mock = vi.hoisted(() => ({
  set_scroll_left: vi.fn(),
  set_zoom_scale: vi.fn(),
}));

vi.mock("@techsquidtv/canvas-timeline", () => {
  const mock_state: { engine?: MockTimelineEngine } = {};

  class MockTimelineEngine {
    tracks: MockTrack[];
    playhead_time: number;
    scrollLeft = 0;
    zoomScale = 74;
    listeners = new Map<string, Set<(payload: unknown) => void>>();

    constructor(state: { tracks: MockTrack[]; playheadTime: number }) {
      this.tracks = state.tracks;
      this.playhead_time = state.playheadTime;
      mock_state.engine = this;
    }

    getTime() {
      return this.playhead_time;
    }

    setTime(time: number) {
      this.playhead_time = time;
      this.emit("playhead:scrub", time);
    }

    pixelToTime(pixel: number) {
      return pixel;
    }

    setZoomScale(zoom_scale: number) {
      this.zoomScale = zoom_scale;
      timeline_mock.set_zoom_scale(zoom_scale);
    }

    setScrollLeft(scroll_left: number) {
      this.scrollLeft = scroll_left;
      timeline_mock.set_scroll_left(scroll_left);
    }

    on(event: string, listener: (payload: unknown) => void) {
      const listeners = this.listeners.get(event) ?? new Set();
      listeners.add(listener);
      this.listeners.set(event, listeners);
      return () => listeners.delete(listener);
    }

    emit(event: string, payload: unknown) {
      this.listeners.get(event)?.forEach((listener) => listener(payload));
    }
  }

  function current_engine() {
    if (!mock_state.engine)
      throw new Error("Timeline engine is not initialized");
    return mock_state.engine;
  }

  const passthrough = ({ children, ...props }: { children?: ReactNode }) => (
    <div {...props}>{children}</div>
  );

  return {
    CanvasRenderer: () => null,
    TimelineEngine: MockTimelineEngine,
    TimelineProvider: ({ children }: { children?: ReactNode }) => children,
    fromSeconds: (seconds: number) => seconds,
    toSeconds: (seconds: number) => seconds,
    useTimeline: () => ({
      engine: current_engine(),
      state: { tracks: current_engine().tracks },
    }),
    Timeline: {
      Root: passthrough,
      PlayheadArea: () => null,
      PlayheadGrabber: () => null,
      TrackList: passthrough,
      Track: () => null,
      TrackHeaderList: passthrough,
      TrackHeader: ({
        children,
        trackId,
        ...props
      }: {
        children?: ReactNode;
        trackId: string;
      }) => {
        void trackId;
        return <div {...props}>{children}</div>;
      },
      RangeSelector: () => null,
      ViewportScrollbar: passthrough,
      ViewportScrollbarThumb: passthrough,
      ViewportScrollbarHandle: () => null,
      ClipInteractionLayer: ({
        onClipDoubleClick,
      }: {
        onClipDoubleClick: (hit: { clip: MockClip }) => void;
      }) => (
        <>
          {current_engine().tracks.flatMap((track) =>
            track.clips.map((clip) => (
              <button
                key={clip.id}
                type="button"
                aria-label={`canvas-item-${clip.metadata.kind}`}
                onClick={() =>
                  current_engine().emit("clip:select", {
                    clip,
                    clipId: clip.id,
                  })
                }
                onDoubleClick={() => onClipDoubleClick({ clip })}
              />
            )),
          )}
        </>
      ),
    },
  };
});

const ASSET_ID = "asset-0198d12345677890abcdef1234567890";

function render_timeline() {
  const callbacks = {
    seek_to: vi.fn(),
    add_marker: vi.fn().mockResolvedValue(undefined),
    remove_marker: vi.fn().mockResolvedValue(undefined),
    update_marker_tags: vi.fn().mockResolvedValue(undefined),
    update_transcript: vi.fn().mockResolvedValue(undefined),
    change_selected_transcript_indices: vi.fn(),
  };

  render(
    <MediaTimeline
      duration_seconds={120}
      current_time={30}
      transcript={{
        asset_id: ASSET_ID,
        language: "zh",
        created_at: "2026-01-01T00:00:00Z",
        segments: [{ start_seconds: 5, end_seconds: 8, text: "原始转写" }],
      }}
      segments={[
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
      ]}
      markers={[
        {
          marker_id: "marker-0198d12345677890abcdef1234567890",
          asset_id: ASSET_ID,
          time_seconds: 20,
          tags: ["重点"],
        },
      ]}
      marker_error={null}
      selected_transcript_indices={[]}
      on_seek={callbacks.seek_to}
      on_selected_transcript_indices_change={
        callbacks.change_selected_transcript_indices
      }
      on_add_marker={callbacks.add_marker}
      on_remove_marker={callbacks.remove_marker}
      on_update_marker_tags={callbacks.update_marker_tags}
      on_update_transcript={callbacks.update_transcript}
    />,
  );

  return callbacks;
}

describe("MediaTimeline", () => {
  it("maps media data to official canvas timeline tracks", () => {
    const { seek_to } = render_timeline();

    expect(screen.getByText("Canvas Timeline")).toBeInTheDocument();
    expect(
      screen.getByRole("separator", { name: "调整轨道标题栏宽度" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("canvas-item-marker")).toBeInTheDocument();
    expect(screen.getByLabelText("canvas-item-transcript")).toBeInTheDocument();
    expect(screen.getByLabelText("canvas-item-event")).toBeInTheDocument();
    expect(
      screen.getByRole("complementary", { name: "时间线轨道" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("M1 标记，只读")).toBeInTheDocument();
    expect(screen.getByLabelText("T1 转写，只读")).toBeInTheDocument();
    expect(screen.getByLabelText("E1 分析事件，只读")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("canvas-item-event"));
    fireEvent.keyDown(screen.getByLabelText(/时间线画布/).parentElement!, {
      key: "ArrowRight",
    });

    expect(seek_to).toHaveBeenNthCalledWith(1, 45);
    expect(seek_to).toHaveBeenNthCalledWith(2, 31);
  });

  it("edits transcript and marker data", async () => {
    const {
      change_selected_transcript_indices,
      remove_marker,
      update_transcript,
    } = render_timeline();

    fireEvent.doubleClick(screen.getByLabelText("canvas-item-transcript"));
    expect(change_selected_transcript_indices).toHaveBeenCalledWith([0]);
    fireEvent.change(screen.getByLabelText("编辑转写文字"), {
      target: { value: "修正后的转写" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(update_transcript).toHaveBeenCalledWith(0, "修正后的转写"),
    );

    fireEvent.click(screen.getByLabelText("canvas-item-marker"));
    fireEvent.click(screen.getByRole("button", { name: "删除" }));

    await waitFor(() =>
      expect(remove_marker).toHaveBeenCalledWith(
        "marker-0198d12345677890abcdef1234567890",
      ),
    );
  });

  it("adds markers from the canvas and shortcut", () => {
    const { add_marker } = render_timeline();

    fireEvent.contextMenu(screen.getByLabelText(/时间线画布/), {
      clientX: 60,
    });
    fireEvent.keyDown(window, { key: "m", ctrlKey: true });

    expect(add_marker).toHaveBeenNthCalledWith(1, 60);
    expect(add_marker).toHaveBeenNthCalledWith(2, 30);
  });

  it("zooms around the pointer with Alt and the mouse wheel", () => {
    render_timeline();

    fireEvent.wheel(screen.getByLabelText(/时间线画布/), {
      altKey: true,
      clientX: 60,
      deltaY: -100,
    });

    expect(timeline_mock.set_zoom_scale).toHaveBeenCalledWith(81.4);
    expect(timeline_mock.set_scroll_left).toHaveBeenCalledWith(4824);
  });
});
