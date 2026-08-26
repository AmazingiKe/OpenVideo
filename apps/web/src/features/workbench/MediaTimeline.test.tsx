import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type ReactNode, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MediaTimeline } from "./MediaTimeline";
import { DEFAULT_ANALYSIS_STRATEGY } from "@/shared/analysis";

type MockClip = {
  id: string;
  label: string;
  timelineStart: number;
  timelineEnd: number;
  color?: string;
  opacity?: number;
  metadata: {
    kind: string;
    source_id?: string;
    source_index?: number;
    marker_shape?: "default" | "manual";
    marker_anchor_seconds?: number;
    rendered_start_seconds?: number;
  };
};

type MockTrack = {
  id: string;
  name?: string;
  kind?: string;
  locked?: boolean;
  clips: MockClip[];
};

const timeline_mock = vi.hoisted(() => ({
  create_engine: vi.fn(),
  emit_event: vi.fn(),
  set_scroll_left: vi.fn(),
  set_zoom_scale: vi.fn(),
  get_clip_at_point: vi.fn(),
}));

vi.mock("@techsquidtv/canvas-timeline", () => {
  const mock_state: { engine?: MockTimelineEngine } = {};

  class MockTimelineEngine {
    tracks: MockTrack[];
    playhead_time: number;
    scrollLeft = 0;
    scrollTop = 0;
    zoomScale = 74;
    listeners = new Map<string, Set<(payload: unknown) => void>>();

    constructor(state: {
      tracks: MockTrack[];
      playheadTime: number;
      zoomScale?: number;
      scrollLeft?: number;
      scrollTop?: number;
    }) {
      this.tracks = state.tracks;
      this.playhead_time = state.playheadTime;
      this.zoomScale = state.zoomScale ?? 74;
      this.scrollLeft = state.scrollLeft ?? 0;
      this.scrollTop = state.scrollTop ?? 0;
      mock_state.engine = this;
      timeline_mock.create_engine(state);
      timeline_mock.emit_event.mockImplementation((event, payload) =>
        this.emit(String(event), payload),
      );
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

    timeToPixel(time: number) {
      return time * this.zoomScale - this.scrollLeft;
    }

    getClipAtPoint(input: unknown) {
      return timeline_mock.get_clip_at_point(input);
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
    update_marker: vi.fn().mockResolvedValue(undefined),
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
  const markers = [
    {
      marker_id: "marker-0198d12345677890abcdef1234567890",
      asset_id: ASSET_ID,
      start_seconds: 20,
      end_seconds: null,
      title: "重点",
      tags: ["重点"],
      marker_range_before_seconds: null,
      marker_range_after_seconds: null,
    },
  ];

  function TimelineHarness() {
    const [, set_selected_transcript_indices] = useState<number[]>([]);

    return (
      <MediaTimeline
        duration_seconds={120}
        current_time={30}
        transcript={transcript}
        segments={segments}
        markers={markers}
        analysis_strategy={DEFAULT_ANALYSIS_STRATEGY}
        marker_error={null}
        on_seek={callbacks.seek_to}
        on_selected_transcript_indices_change={(segment_indices) => {
          callbacks.change_selected_transcript_indices(segment_indices);
          set_selected_transcript_indices(segment_indices);
        }}
        on_add_marker={callbacks.add_marker}
        on_update_marker={callbacks.update_marker}
        on_delete_marker={callbacks.delete_marker}
        on_update_transcript={callbacks.update_transcript}
      />
    );
  }

  render(<TimelineHarness />);

  return callbacks;
}

describe("MediaTimeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    timeline_mock.get_clip_at_point.mockReturnValue(null);
  });

  it("maps media data to official canvas timeline tracks", () => {
    const { seek_to } = render_timeline();

    expect(screen.getByText("时间线")).toBeInTheDocument();
    expect(
      screen.getByRole("separator", { name: "调整轨道标题栏宽度" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("canvas-item-marker")).toBeInTheDocument();
    expect(screen.getByLabelText("canvas-item-transcript")).toBeInTheDocument();
    expect(screen.getByLabelText("canvas-item-event")).toBeInTheDocument();
    const marker_clip =
      timeline_mock.create_engine.mock.calls[0]?.[0].tracks[0].clips[0];
    expect(marker_clip).toMatchObject({ opacity: 0 });
    expect(marker_clip).not.toHaveProperty("color");
    expect(
      screen.getByRole("complementary", { name: "时间线轨道" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("M1 标记")).toBeInTheDocument();
    expect(screen.getByLabelText("T1 转写，只读")).toBeInTheDocument();
    expect(screen.getByLabelText("E1 分析事件，只读")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("canvas-item-event"));
    fireEvent.keyDown(screen.getByLabelText(/时间线画布/).parentElement!, {
      key: "ArrowRight",
    });

    expect(seek_to).toHaveBeenNthCalledWith(1, 45);
    expect(seek_to).toHaveBeenNthCalledWith(2, 31);
  });

  it("edits transcript data", async () => {
    const { change_selected_transcript_indices, update_transcript } =
      render_timeline();

    fireEvent.doubleClick(screen.getByLabelText("canvas-item-transcript"));
    expect(change_selected_transcript_indices).toHaveBeenCalledWith([0]);
    fireEvent.change(screen.getByLabelText("编辑转写文字"), {
      target: { value: "修正后的转写" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(update_transcript).toHaveBeenCalledWith(0, "修正后的转写"),
    );
  });

  it("edits marker labels beside the pointer without resetting transcript selection", async () => {
    const { change_selected_transcript_indices, update_marker } =
      render_timeline();
    const timeline = screen.getByRole("region", { name: "剪辑时间轴" });
    const marker_clip = screen.getByLabelText("canvas-item-marker");

    fireEvent.pointerDown(marker_clip, { clientX: 240, clientY: 360 });
    fireEvent.click(marker_clip);

    expect(screen.queryByLabelText("编辑标记标签")).toBeNull();
    expect(
      screen.getByRole("img", {
        name: "重点：默认范围，向前 10 秒，向后 20 秒",
      }),
    ).toHaveAttribute("data-selected", "true");

    timeline_mock.get_clip_at_point.mockReturnValue({
      clip: { id: "existing-marker" },
    });
    fireEvent.doubleClick(marker_clip, { clientX: 240, clientY: 360 });

    const marker_editor = screen.getByLabelText("编辑标记标签").closest("form");
    const marker_anchor = document.querySelector(
      ".timeline-marker-editor-anchor",
    );
    expect(marker_editor).not.toBeNull();
    expect(timeline).not.toContainElement(marker_editor);
    expect(marker_anchor).toHaveStyle({ left: "240px", top: "360px" });
    expect(change_selected_transcript_indices).not.toHaveBeenCalled();
    expect(screen.getAllByText("跟随当前分析策略")).toHaveLength(2);
    expect(screen.getByText("默认 · 10 秒")).toBeInTheDocument();
    expect(screen.getByText("默认 · 20 秒")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("编辑标记标签"), {
      target: { value: "重点, 公式" },
    });
    fireEvent.click(screen.getByRole("radio", { name: "标记前自定义" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(update_marker).toHaveBeenCalledWith(
        "marker-0198d12345677890abcdef1234567890",
        {
          start_seconds: 20,
          end_seconds: null,
          title: "重点",
          tags: ["重点", "公式"],
          marker_range_before_seconds: 10,
          marker_range_after_seconds: null,
        },
      ),
    );
    expect(screen.queryByLabelText("编辑标记标签")).toBeNull();
  });

  it("adds markers only through deliberate actions", () => {
    const { add_marker } = render_timeline();
    const canvas = screen.getByLabelText(/时间线画布/);

    fireEvent.click(canvas, { clientX: 60, clientY: 48 });
    fireEvent.contextMenu(canvas, {
      clientX: 60,
      clientY: 48,
    });
    fireEvent.pointerDown(canvas, { button: 0, clientX: 40, clientY: 48 });
    fireEvent.pointerUp(canvas, { clientX: 64, clientY: 48 });

    expect(add_marker).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "在 00:30 添加标记" }));
    fireEvent.keyDown(window, { key: "m", ctrlKey: true });

    expect(add_marker).toHaveBeenNthCalledWith(1, 30);
    expect(add_marker).toHaveBeenNthCalledWith(2, 30);
  });

  it("keeps the marker editor and draft open after a save failure", async () => {
    const { update_marker } = render_timeline();
    update_marker.mockRejectedValueOnce(new Error("request failed"));
    const marker_clip = screen.getByLabelText("canvas-item-marker");
    fireEvent.click(marker_clip);
    timeline_mock.get_clip_at_point.mockReturnValue({
      clip: { id: "existing-marker" },
    });
    fireEvent.doubleClick(marker_clip);
    const tags_input = screen.getByLabelText("编辑标记标签");
    fireEvent.change(tags_input, { target: { value: "未保存草稿" } });

    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "标记保存失败，请稍后重试",
    );
    expect(tags_input).toHaveValue("未保存草稿");
    expect(screen.getByText("编辑标记")).toBeInTheDocument();
  });

  it("creates a point marker by double-clicking empty marker track space", () => {
    const { add_marker } = render_timeline();
    const canvas = screen.getByLabelText(/时间线画布/);

    fireEvent.doubleClick(canvas, { clientX: 24, clientY: 48 });

    expect(add_marker).toHaveBeenCalledOnce();
    expect(add_marker).toHaveBeenCalledWith(24);
  });

  it("does not create a marker when double-clicking an existing clip", () => {
    const { add_marker } = render_timeline();
    timeline_mock.get_clip_at_point.mockReturnValue({
      clip: { id: "existing-marker" },
    });

    fireEvent.doubleClick(screen.getByLabelText(/时间线画布/), {
      clientX: 24,
      clientY: 48,
    });

    expect(add_marker).not.toHaveBeenCalled();
  });

  it("persists moved and resized range bounds", () => {
    const { update_marker } = render_timeline();
    const clip = {
      id: "marker-clip",
      label: "重点",
      timelineStart: 25,
      timelineEnd: 35,
      metadata: {
        kind: "marker",
        source_id: "marker-0198d12345677890abcdef1234567890",
        marker_shape: "manual",
        marker_anchor_seconds: 25,
        rendered_start_seconds: 25,
      },
    };

    timeline_mock.emit_event("clip:move", { clip, phase: "commit" });
    timeline_mock.emit_event("clip:resize", {
      clip: { ...clip, timelineEnd: 40 },
    });
    timeline_mock.emit_event("state:settled", {});

    expect(update_marker).toHaveBeenNthCalledWith(
      1,
      "marker-0198d12345677890abcdef1234567890",
      {
        start_seconds: 25,
        end_seconds: 35,
        title: "重点",
        tags: ["重点"],
        marker_range_before_seconds: null,
        marker_range_after_seconds: null,
      },
    );
    expect(update_marker).toHaveBeenNthCalledWith(
      2,
      "marker-0198d12345677890abcdef1234567890",
      {
        start_seconds: 25,
        end_seconds: 40,
        title: "重点",
        tags: ["重点"],
        marker_range_before_seconds: null,
        marker_range_after_seconds: null,
      },
    );
  });

  it("moves a default marker without turning it into a range", () => {
    const { update_marker } = render_timeline();
    const clip = {
      id: "default-marker-clip",
      label: "重点",
      timelineStart: 15,
      timelineEnd: 45,
      metadata: {
        kind: "marker",
        source_id: "marker-0198d12345677890abcdef1234567890",
        marker_shape: "default",
        marker_anchor_seconds: 20,
        rendered_start_seconds: 10,
      },
    };

    timeline_mock.emit_event("clip:move", { clip, phase: "commit" });

    expect(update_marker).toHaveBeenCalledWith(
      "marker-0198d12345677890abcdef1234567890",
      {
        start_seconds: 25,
        end_seconds: null,
        title: "重点",
        tags: ["重点"],
        marker_range_before_seconds: null,
        marker_range_after_seconds: null,
      },
    );
  });

  it("turns a default marker into a manual range after handle resizing", () => {
    const { update_marker } = render_timeline();
    const clip = {
      id: "default-marker-clip",
      label: "重点",
      timelineStart: 12,
      timelineEnd: 44,
      metadata: {
        kind: "marker",
        source_id: "marker-0198d12345677890abcdef1234567890",
        marker_shape: "default",
        marker_anchor_seconds: 20,
        rendered_start_seconds: 10,
      },
    };

    timeline_mock.emit_event("clip:resize", { clip });
    timeline_mock.emit_event("state:settled", {});

    expect(update_marker).toHaveBeenCalledWith(
      "marker-0198d12345677890abcdef1234567890",
      {
        start_seconds: 12,
        end_seconds: 44,
        title: "重点",
        tags: ["重点"],
        marker_range_before_seconds: null,
        marker_range_after_seconds: null,
      },
    );
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

  it("preserves the viewport when selecting a marker", () => {
    render_timeline();
    const timeline_canvas = screen.getByLabelText(/时间线画布/);

    fireEvent.wheel(timeline_canvas, {
      altKey: true,
      clientX: 60,
      deltaY: -100,
    });
    fireEvent.click(screen.getByLabelText("canvas-item-marker"));

    expect(timeline_mock.create_engine).toHaveBeenCalledTimes(2);
    expect(timeline_mock.create_engine.mock.calls[1]?.[0]).toMatchObject({
      zoomScale: 81.4,
      scrollLeft: 4824,
      scrollTop: 0,
    });
  });

  it("keeps the engine and viewport stable when selecting a transcript clip", () => {
    const { change_selected_transcript_indices } = render_timeline();
    const timeline_canvas = screen.getByLabelText(/时间线画布/);

    fireEvent.wheel(timeline_canvas, {
      altKey: true,
      clientX: 60,
      deltaY: -100,
    });
    fireEvent.click(screen.getByLabelText("canvas-item-transcript"));
    fireEvent.wheel(timeline_canvas, {
      altKey: true,
      clientX: 60,
      deltaY: -100,
    });

    expect(change_selected_transcript_indices).toHaveBeenCalledWith([0]);
    expect(timeline_mock.create_engine).toHaveBeenCalledTimes(1);
    expect(timeline_mock.set_zoom_scale).toHaveBeenNthCalledWith(1, 81.4);
    expect(timeline_mock.set_zoom_scale.mock.calls[1]?.[0]).toBeCloseTo(89.54);
  });
});
