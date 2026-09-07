import type { Meta, StoryObj } from "@storybook/react-vite";
import { useRef, useState } from "react";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { DEFAULT_ANALYSIS_STRATEGY } from "@/shared/analysis";
import { Player, type PlayerHandle } from "@/features/player/Player";
import { format_timeline_time } from "./timeline_time";
import type {
  EventAnalysis,
  FocusSelection,
  MediaMarker,
  MediaMarkerUpdate,
  MediaSegment,
  TranscriptSegment,
} from "@/shared/types";
import { MediaTimeline } from "./MediaTimeline";
import {
  DEFAULT_ZOOM_PIXELS_PER_SECOND,
  TIMELINE_START_LEFT,
} from "./media_timeline_calculations";

const ASSET_ID = "019d3f8a-2b1c-7000-8000-000000000001";
const ZOOM_OUT_TO_MINIMUM_WHEEL_DELTA = 100_000;
const POINT_MARKER: MediaMarker = {
  marker_id: "marker-019d3f8a2b1c70008000000000000001",
  asset_id: ASSET_ID,
  start_seconds: 12,
  end_seconds: null,
  importance: 2,
  content: "",
};
const RANGE_MARKER: MediaMarker = {
  marker_id: "marker-019d3f8a2b1c70008000000000000002",
  asset_id: ASSET_ID,
  start_seconds: 24,
  end_seconds: 31,
  importance: 5,
  content: "",
};
const CANDIDATE_MARKER: MediaMarker = {
  marker_id: "marker-019d3f8a2b1c70008000000000000003",
  asset_id: ASSET_ID,
  start_seconds: 38,
  end_seconds: 43,
  importance: 3,
  content: "",
};
const TRANSCRIPT_SEGMENTS: TranscriptSegment[] = [
  {
    start_seconds: 2,
    end_seconds: 8,
    text: "介绍投影矩阵的基本结构。",
    emotion: null,
    audio_events: [],
  },
  {
    start_seconds: 9,
    end_seconds: 17,
    text: "逐步推导透视除法并验证结果。",
    emotion: null,
    audio_events: [],
  },
  {
    start_seconds: 19,
    end_seconds: 34,
    text: "对比不同视场角下的画面变化。",
    emotion: null,
    audio_events: [],
  },
];
const ANALYSIS_SEGMENTS: MediaSegment[] = [
  {
    segment_id: "segment-019d3f8a2b1c70008000000000000001",
    asset_id: ASSET_ID,
    start_seconds: 6,
    end_seconds: 18,
    title: "核心概念",
    detailed_summary: null,
    transcript_text: null,
    speaker_name: null,
    key_frame_paths: [],
    visual_description: null,
    ocr_text: null,
    formula_latex: [],
    marker_ids: [],
    tags: ["矩阵"],
  },
  {
    segment_id: "segment-019d3f8a2b1c70008000000000000002",
    asset_id: ASSET_ID,
    start_seconds: 22,
    end_seconds: 35,
    title: "公式推导",
    detailed_summary: null,
    transcript_text: null,
    speaker_name: null,
    key_frame_paths: [],
    visual_description: null,
    ocr_text: null,
    formula_latex: [],
    marker_ids: [],
    tags: ["推导"],
  },
];
const ADJACENT_ANALYSIS_SEGMENTS: MediaSegment[] = [
  {
    ...ANALYSIS_SEGMENTS[0]!,
    segment_id: "segment-019d3f8a2b1c70008000000000000003",
    start_seconds: 0,
    end_seconds: 30,
    title: "投影基础",
  },
  {
    ...ANALYSIS_SEGMENTS[1]!,
    segment_id: "segment-019d3f8a2b1c70008000000000000004",
    start_seconds: 30,
    end_seconds: 60,
    title: "矩阵推导",
  },
  {
    ...ANALYSIS_SEGMENTS[1]!,
    segment_id: "segment-019d3f8a2b1c70008000000000000005",
    start_seconds: 60,
    end_seconds: 90,
    title: "结果验证",
  },
];
const FOCUS_SELECTION: FocusSelection = {
  selection_id: "focus-selection-019d3f8a2b1c70008000000000000001",
  asset_id: ASSET_ID,
  in_seconds: 8,
  out_seconds: 36,
  revision: 1,
  updated_at: "2026-08-30T00:00:00Z",
};
const EVENT_ANALYSIS_BASE = {
  asset_id: ASSET_ID,
  conclusion: "这一段建立了分析结论。",
  key_points: [],
  evidence: [],
  preset_id: "course_notes",
  preset_version: 1,
  depth: "balanced" as const,
  user_input: null,
  ai_model_id: "model-019d3f8a2b1c70008000000000000001",
  source_summary: {
    transcript_digest: "transcript",
    target_digest: "target",
    timeline_digest: "timeline",
  },
  status: "valid" as const,
  created_at: "2026-08-30T00:00:00Z",
  updated_at: "2026-08-30T00:00:00Z",
};
const EVENT_ANALYSES: EventAnalysis[] = [
  {
    ...EVENT_ANALYSIS_BASE,
    event_analysis_id: "event-analysis-019d3f8a2b1c70008000000000000001",
    target: {
      source: "marker",
      marker_id: POINT_MARKER.marker_id,
      content: POINT_MARKER.content,
      importance: POINT_MARKER.importance,
      start_seconds: 10,
      end_seconds: 30,
    },
    title: "概念分析",
  },
  {
    ...EVENT_ANALYSIS_BASE,
    event_analysis_id: "event-analysis-019d3f8a2b1c70008000000000000002",
    target: {
      source: "focus_selection",
      selection_id: FOCUS_SELECTION.selection_id,
      start_seconds: 18,
      end_seconds: 38,
    },
    title: "重叠范围分析",
  },
];

type TimelineStoryProps = {
  with_player?: boolean;
  duration_seconds: number;
  initial_time: number;
  initial_markers: MediaMarker[];
  candidate_markers: MediaMarker[];
  transcript_segments: TranscriptSegment[];
  analysis_segments: MediaSegment[];
  event_analyses: EventAnalysis[];
  focus_selection: FocusSelection | null;
  marker_error: string | null;
};

function TimelineStory({
  with_player = false,
  duration_seconds,
  initial_time,
  initial_markers,
  candidate_markers,
  transcript_segments,
  analysis_segments,
  event_analyses,
  focus_selection,
  marker_error,
}: TimelineStoryProps) {
  const player_ref = useRef<PlayerHandle>(null);
  const [is_paused, set_is_paused] = useState(true);
  const [current_time, set_current_time] = useState(initial_time);
  const [markers, set_markers] = useState(initial_markers);
  const [selected_marker_ids, set_selected_marker_ids] = useState<Set<string>>(
    () => new Set(),
  );
  const [selected_transcript_indices, set_selected_transcript_indices] =
    useState<number[]>([]);
  const [range_selection, set_range_selection] =
    useState<FocusSelection | null>(focus_selection);

  async function update_marker(
    marker_id: string,
    update: MediaMarkerUpdate,
  ): Promise<void> {
    set_markers((current) =>
      current.map((marker) =>
        marker.marker_id === marker_id ? { ...marker, ...update } : marker,
      ),
    );
  }

  function set_range_endpoint(
    endpoint: "in_seconds" | "out_seconds",
    seconds: number,
  ) {
    set_range_selection((current) => ({
      ...(current ?? {
        selection_id: "focus-selection-019d3f8a2b1c70008000000000000002",
        asset_id: ASSET_ID,
        in_seconds: null,
        out_seconds: null,
        revision: 0,
        updated_at: "2026-08-30T00:00:00Z",
      }),
      [endpoint]: seconds,
      revision: (current?.revision ?? 0) + 1,
    }));
  }

  return (
    <div className="flex flex-col gap-4">
      {with_player ? (
        <div className="h-96">
          <Player
            chapters={analysis_segments}
            ref={player_ref}
            src="https://files.vidstack.io/sprite-fight/720p.mp4"
            on_time_change={set_current_time}
            on_pause_change={set_is_paused}
          />
        </div>
      ) : null}
      <div className="h-64 w-full" data-testid="timeline-story-frame">
        <MediaTimeline
          asset_id={ASSET_ID}
          duration_seconds={duration_seconds}
          current_time={current_time}
          is_paused={is_paused}
          read_playback_time={
            with_player
              ? () => player_ref.current?.current_time() ?? current_time
              : undefined
          }
          playback_rate={1}
          transcript={{
            asset_id: ASSET_ID,
            language: "zh",
            created_at: "2026-08-27T00:00:00Z",
            segments: transcript_segments,
          }}
          segments={analysis_segments}
          event_analyses={event_analyses}
          focus_selection={range_selection}
          markers={markers}
          candidate_markers={candidate_markers}
          selected_marker_ids={selected_marker_ids}
          selected_transcript_indices={selected_transcript_indices}
          analysis_strategy={DEFAULT_ANALYSIS_STRATEGY}
          marker_error={marker_error}
          on_scrub_start={(time) => {
            if (with_player) player_ref.current?.begin_scrub(time);
            else set_current_time(time);
          }}
          on_scrub_update={(time) => {
            if (with_player) player_ref.current?.update_scrub(time);
            else set_current_time(time);
          }}
          on_scrub_commit={(time) => {
            if (with_player) player_ref.current?.commit_scrub(time);
            else set_current_time(time);
          }}
          on_scrub_cancel={() => player_ref.current?.cancel_scrub()}
          on_seek={(time) => {
            if (with_player) player_ref.current?.seek_to(time);
            else set_current_time(time);
          }}
          on_selected_transcript_indices_change={
            set_selected_transcript_indices
          }
          on_selected_marker_ids_change={set_selected_marker_ids}
          on_set_focus_in={(seconds) =>
            set_range_endpoint("in_seconds", seconds)
          }
          on_set_focus_out={(seconds) =>
            set_range_endpoint("out_seconds", seconds)
          }
          on_clear_focus={() => set_range_selection(null)}
          on_request_transcript_correction={() => undefined}
          on_add_marker={async () => undefined}
          on_update_marker={update_marker}
          on_delete_marker={async (marker_id) =>
            set_markers((current) =>
              current.filter((marker) => marker.marker_id !== marker_id),
            )
          }
          on_update_transcript={async () => undefined}
          on_request_transcription={() => undefined}
        />
      </div>
    </div>
  );
}

const meta = {
  title: "Analysis/MediaTimeline",
  component: TimelineStory,
  parameters: {
    layout: "fullscreen",
  },
  args: {
    with_player: false,
    duration_seconds: 90,
    initial_time: 16,
    initial_markers: [POINT_MARKER, RANGE_MARKER],
    candidate_markers: [],
    transcript_segments: TRANSCRIPT_SEGMENTS,
    analysis_segments: ANALYSIS_SEGMENTS,
    event_analyses: [],
    focus_selection: null,
    marker_error: null,
  },
} satisfies Meta<typeof TimelineStory>;

export default meta;
type Story = StoryObj<typeof meta>;

async function zoom_timeline_overview(canvas_element: HTMLElement) {
  const host = within(canvas_element).getByLabelText(/时间线画布/);
  host.dispatchEvent(
    new WheelEvent("wheel", {
      altKey: true,
      bubbles: true,
      cancelable: true,
      clientX: host.getBoundingClientRect().left + TIMELINE_START_LEFT,
      deltaY: ZOOM_OUT_TO_MINIMUM_WHEEL_DELTA,
    }),
  );
  await new Promise(requestAnimationFrame);
  const grid = host.querySelector<HTMLElement>(
    ".timeline-editor-edit-area .ReactVirtualized__Grid",
  )!;
  expect(grid.scrollWidth).toBeLessThanOrEqual(grid.clientWidth + 1);
}

function timeline_story_zoom(canvas_element: HTMLElement) {
  const row = canvas_element.querySelector<HTMLElement>(
    ".timeline-editor-edit-row",
  )!;
  return parseFloat(row.style.backgroundSize.split(",")[1]!);
}

export const Empty: Story = {
  args: {
    initial_time: 0,
    initial_markers: [],
    transcript_segments: [],
    analysis_segments: [],
  },
};

export const MarkerAndTranscriptTracks: Story = {
  parameters: {
    docs: {
      description: {
        story:
          "当前播放时间固定在标尺左侧，Alt＋滚轮缩放，默认按 32px 合并短片段。",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const story_frame = within(canvasElement).getByTestId(
      "timeline-story-frame",
    );
    const timeline = story_frame.querySelector<HTMLElement>(".media_timeline");
    expect(timeline).not.toBeNull();
    const frame_bounds = story_frame.getBoundingClientRect();
    const timeline_bounds = timeline?.getBoundingClientRect();
    expect(timeline_bounds?.right).toBeCloseTo(frame_bounds.right);
    expect(timeline_bounds?.bottom).toBeCloseTo(frame_bounds.bottom);
  },
};

export const ScrollSynchronization: Story = {
  args: { initial_time: 6 },
  parameters: {
    docs: {
      description: {
        story: "原生滚动后的第一帧，标尺刻度、网格、轨道片段和播放头保持对齐。",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const host = canvasElement.querySelector<HTMLElement>(
      ".media_timeline_canvas",
    )!;
    const scroll_container = host.querySelector<HTMLElement>(
      ".timeline-editor-edit-area .ReactVirtualized__Grid",
    )!;
    const ruler = host.querySelector<HTMLCanvasElement>(
      ".timeline_ruler_canvas",
    )!;
    const context = ruler.getContext("2d")!;
    const transcript = within(host).getByRole("button", {
      name: /转写：介绍投影矩阵的基本结构/,
    }).parentElement!;
    const playhead = host.querySelector<HTMLElement>(
      ".media_timeline_playhead",
    )!;
    await new Promise(requestAnimationFrame);

    const transcript_start_seconds = 2;
    const playhead_seconds = 6;
    for (const scroll_left of [55, 110, 165, 110, 55, 0]) {
      scroll_container.scrollLeft = scroll_left;
      await new Promise(requestAnimationFrame);
      const expected_x =
        TIMELINE_START_LEFT +
        transcript_start_seconds * DEFAULT_ZOOM_PIXELS_PER_SECOND -
        scroll_container.scrollLeft;
      const grid_positions = [
        ...host.querySelectorAll<HTMLElement>(".timeline_grid_line"),
      ].map((line) => parseFloat(line.style.left));
      expect(grid_positions).toContain(expected_x);
      expect(
        transcript.getBoundingClientRect().left -
          host.getBoundingClientRect().left,
      ).toBeCloseTo(expected_x, 0);
      expect(new DOMMatrixReadOnly(playhead.style.transform).m41).toBeCloseTo(
        TIMELINE_START_LEFT +
          playhead_seconds * DEFAULT_ZOOM_PIXELS_PER_SECOND -
          scroll_container.scrollLeft,
        0,
      );
      const pixel_ratio = ruler.width / ruler.getBoundingClientRect().width;
      const tick_pixel = context.getImageData(
        Math.round(expected_x * pixel_ratio),
        ruler.height - 1,
        1,
        1,
      ).data;
      expect(tick_pixel[3]).toBeGreaterThan(0);
    }
  },
};

export const PlayerProgressSynchronization: Story = {
  args: { with_player: true, initial_time: 0, duration_seconds: 720 },
  play: async ({ canvasElement, userEvent: user_event }) => {
    const story = within(canvasElement);
    const player = story.getByLabelText("OpenVideo 播放器");
    const video = player.querySelector("video")!;
    const progress = await story.findByRole("slider", { name: "播放进度" });
    await waitFor(
      () => {
        expect(video.duration).toBeGreaterThan(0);
        expect(player).toHaveAttribute("data-can-play");
        expect(progress).not.toHaveAttribute("aria-disabled", "true");
      },
      { timeout: 15_000 },
    );
    await user_event.hover(player);
    await waitFor(() => {
      const controls = player.querySelector<HTMLElement>(".plyr__controls")!;
      expect(
        new DOMMatrixReadOnly(getComputedStyle(controls).transform).m42,
      ).toBe(0);
      expect(getComputedStyle(controls).opacity).toBe("1");
    });
    const host = story.getByLabelText(/时间线画布/);
    host.dispatchEvent(
      new WheelEvent("wheel", {
        altKey: true,
        bubbles: true,
        cancelable: true,
        deltaY: -2_000,
        clientX: host.getBoundingClientRect().left + TIMELINE_START_LEFT,
      }),
    );
    await new Promise(requestAnimationFrame);
    const grid = host.querySelector<HTMLElement>(
      ".timeline-editor-edit-area .ReactVirtualized__Grid",
    )!;
    const playhead = host.querySelector<HTMLElement>(
      ".media_timeline_playhead",
    )!;
    let requested_time = 0;
    const record_request = (event: Event) => {
      requested_time = (event as CustomEvent<number>).detail;
    };
    player.addEventListener("media-seeking-request", record_request);
    const bounds = progress.getBoundingClientRect();
    const initial_media_time = video.currentTime;
    try {
      await user_event.pointer({
        target: progress,
        keys: "[MouseLeft>]",
        coords: {
          clientX: bounds.left + bounds.width * 0.2,
          clientY: bounds.top + bounds.height / 2,
        },
      });
      for (const fraction of [0.65, 0.8, 0.4]) {
        await user_event.pointer({
          target: progress,
          coords: {
            clientX: bounds.left + bounds.width * fraction,
            clientY: bounds.top + bounds.height / 2,
          },
        });
        await new Promise(requestAnimationFrame);
        expect(requested_time).toBeCloseTo(video.duration * fraction, 0);
        expect(story.getByLabelText("当前播放时间")).toHaveTextContent(
          format_timeline_time(requested_time),
        );
        expect(new DOMMatrixReadOnly(playhead.style.transform).m41).toBeCloseTo(
          TIMELINE_START_LEFT +
            requested_time * timeline_story_zoom(canvasElement) -
            grid.scrollLeft,
          0,
        );
        expect(playhead).toHaveAttribute("data-visible", "true");
        expect(video.currentTime).toBe(initial_media_time);
      }
      await user_event.keyboard("[BracketLeft]");
      const start = host.querySelector<HTMLElement>('[data-edge="start"]')!;
      expect(parseFloat(start.style.left)).toBeCloseTo(
        new DOMMatrixReadOnly(playhead.style.transform).m41,
        0,
      );
      await user_event.pointer({
        target: progress,
        keys: "[/MouseLeft]",
        coords: {
          clientX: bounds.left + bounds.width * 0.4,
          clientY: bounds.top + bounds.height / 2,
        },
      });
      await waitFor(() =>
        expect(video.currentTime).toBeCloseTo(requested_time, 0),
      );
    } finally {
      player.removeEventListener("media-seeking-request", record_request);
    }
  },
};

export const AggregatedRangeSelection: Story = {
  args: {
    initial_time: 0,
    initial_markers: [],
    analysis_segments: [],
    transcript_segments: [
      {
        start_seconds: 5,
        end_seconds: 6,
        text: "第一段",
        emotion: null,
        audio_events: [],
      },
      {
        start_seconds: 6.1,
        end_seconds: 8,
        text: "第二段",
        emotion: null,
        audio_events: [],
      },
    ],
  },
  play: async ({ canvasElement }) => {
    const story = within(canvasElement);
    await userEvent.click(story.getByRole("button", { name: /转写：第一段/ }));
    await zoom_timeline_overview(canvasElement);
    const group = story.getByRole("button", { name: /^聚合 2/ });
    expect(group).toHaveAttribute("aria-pressed", "true");
    await userEvent.keyboard("[BracketLeft][BracketRight]");
    const host = story.getByLabelText(/时间线画布/);
    const selection = host.querySelector<HTMLElement>(
      ".media_timeline_range_selection",
    )!;
    expect(parseFloat(selection.style.width)).toBeCloseTo(
      3 * timeline_story_zoom(canvasElement),
      0,
    );
    await userEvent.click(group);
    await userEvent.keyboard("[BracketLeft][BracketRight]");
    expect(parseFloat(selection.style.width)).toBeCloseTo(
      3 * timeline_story_zoom(canvasElement),
      0,
    );
    const bounds = group.getBoundingClientRect();
    await userEvent.pointer([
      {
        target: host,
        keys: "[MouseLeft>]",
        coords: { clientX: bounds.left - 4, clientY: bounds.bottom + 4 },
      },
      {
        target: host,
        coords: {
          clientX: bounds.left + bounds.width / 3,
          clientY: bounds.top + bounds.height / 2,
        },
      },
      { target: host, keys: "[/MouseLeft]" },
    ]);
    expect(story.getByText("已框选 2 个片段")).toBeInTheDocument();
  },
};

export const DynamicAnalysisTracks: Story = {
  args: {
    event_analyses: EVENT_ANALYSES,
    focus_selection: FOCUS_SELECTION,
  },
  play: async ({ canvasElement }) => {
    const story = within(canvasElement);
    expect(story.getByLabelText("事件分析，只读")).toBeVisible();
    expect(story.getByLabelText("事件分析 2，只读")).toBeVisible();

    const timeline_canvas = story.getByLabelText(/时间线画布/);
    const timeline_grids = timeline_canvas.querySelectorAll<HTMLElement>(
      ".ReactVirtualized__Grid",
    );
    const editor_grid = timeline_grids.item(timeline_grids.length - 1);
    const track_labels = canvasElement.querySelector<HTMLElement>(
      ".media_timeline_track_labels_body",
    );
    expect(editor_grid).not.toBeNull();
    expect(track_labels).not.toBeNull();

    const resize_handle = story.getByRole("separator", {
      name: "调整转写轨道高度",
    });
    await userEvent.keyboard("{Escape}");
    resize_handle.focus();
    await userEvent.keyboard("{ArrowDown>16/}");
    editor_grid.scrollTop = 48;
    await new Promise(requestAnimationFrame);
    expect(editor_grid.scrollTop).toBeGreaterThan(0);
    expect(track_labels?.style.transform).toBe(
      `translate3d(0px, -${editor_grid.scrollTop}px, 0px)`,
    );
  },
};

export const TemporaryRangeSelection: Story = {
  play: async ({ canvasElement }) => {
    const story = within(canvasElement);
    await zoom_timeline_overview(canvasElement);
    await userEvent.click(
      await story.findByRole("button", { name: /范围标记/ }),
    );
    await userEvent.keyboard("[BracketLeft][BracketRight]");

    await waitFor(() => {
      expect(story.getByText(/范围起点 00:24；范围终点 00:31/)).toBeVisible();
    });
    expect(
      canvasElement.querySelector(".media_timeline_range_selection"),
    ).not.toBeNull();
    expect(
      canvasElement.querySelector('[data-row-id="timeline-focus-track"]'),
    ).toBeNull();
  },
};

export const ZoomBelowDefault: Story = {
  play: async ({ canvasElement }) => {
    const story = within(canvasElement);
    const timeline_canvas = story.getByLabelText(/时间线画布/);
    const timeline_grids = timeline_canvas.querySelectorAll<HTMLElement>(
      ".ReactVirtualized__Grid",
    );
    const editor_grid = timeline_grids.item(timeline_grids.length - 1);
    expect(editor_grid).not.toBeNull();

    editor_grid.scrollLeft = editor_grid.scrollWidth;
    editor_grid.dispatchEvent(new Event("scroll", { bubbles: true }));
    const runtime_errors: string[] = [];
    const record_runtime_error = (event: ErrorEvent) => {
      runtime_errors.push(event.message);
    };
    window.addEventListener("error", record_runtime_error);

    try {
      const bounds = timeline_canvas.getBoundingClientRect();
      const wheel_event = new WheelEvent("wheel", {
        altKey: true,
        bubbles: true,
        cancelable: true,
        clientX: bounds.right - 24,
        deltaY: ZOOM_OUT_TO_MINIMUM_WHEEL_DELTA,
      });
      editor_grid.dispatchEvent(wheel_event);

      await new Promise(requestAnimationFrame);
      expect(wheel_event.defaultPrevented).toBe(true);
      expect(editor_grid.scrollWidth).toBeLessThanOrEqual(
        editor_grid.clientWidth + 1,
      );
      expect(runtime_errors).toEqual([]);
    } finally {
      window.removeEventListener("error", record_runtime_error);
    }
  },
};

export const ContinuousViewportUpdates: Story = {
  args: {
    duration_seconds: 2_000,
    initial_time: 0,
    initial_markers: [],
    analysis_segments: [],
    transcript_segments: Array.from({ length: 2_000 }, (_, index) => ({
      start_seconds: index,
      end_seconds: index + 1,
      text: `连续滚动片段 ${index}`,
      emotion: null,
      audio_events: [],
    })),
  },
  play: async ({ canvasElement }) => {
    const story = within(canvasElement);
    const canvas = story.getByLabelText(/时间线画布/);
    const grid = canvas.querySelector<HTMLElement>(
      ".timeline-editor-edit-area .ReactVirtualized__Grid",
    )!;
    const frame = () => new Promise(requestAnimationFrame);
    const scroll_positions = [800, 8_000, 16_000, 800];
    let zoom = DEFAULT_ZOOM_PIXELS_PER_SECOND;
    for (const scroll_left of scroll_positions) {
      grid.scrollLeft = scroll_left;
      await frame();
      const scrolled_index = Math.ceil(grid.scrollLeft / zoom);
      const scrolled_action = story.getByRole("button", {
        name: new RegExp(`^转写：连续滚动片段 ${scrolled_index}，`),
      });
      const scrolled_block = scrolled_action.closest<HTMLElement>(
        ".timeline-editor-action",
      )!;
      const expected_scrolled_left =
        TIMELINE_START_LEFT + scrolled_index * zoom - grid.scrollLeft;
      expect(
        scrolled_block.getBoundingClientRect().left -
          grid.getBoundingClientRect().left,
      ).toBeCloseTo(expected_scrolled_left, 0);
      expect(
        grid.querySelector<HTMLElement>(
          ".ReactVirtualized__Grid__innerScrollContainer",
        )?.style.pointerEvents,
      ).not.toBe("none");
      canvas.dispatchEvent(
        new WheelEvent("wheel", {
          altKey: true,
          bubbles: true,
          cancelable: true,
          clientX: canvas.getBoundingClientRect().left + 200,
          deltaY: -50,
        }),
      );
      zoom *= Math.exp(0.05);
      await frame();
      await frame();
      const visible_index = Math.ceil(grid.scrollLeft / zoom);
      const action = story.getByRole("button", {
        name: new RegExp(`^转写：连续滚动片段 ${visible_index}，`),
      });
      const block = action.closest<HTMLElement>(".timeline-editor-action")!;
      expect(getComputedStyle(block).transitionProperty).toBe("none");
      expect(Math.abs(block.getBoundingClientRect().width - zoom)).toBeLessThan(
        1,
      );
      const expected_left = 16 + visible_index * zoom - grid.scrollLeft;
      const actual_left =
        block.getBoundingClientRect().left - grid.getBoundingClientRect().left;
      expect(Math.abs(actual_left - expected_left)).toBeLessThan(1);
    }
  },
};

export const AdjacentChaptersOverview: Story = {
  args: {
    analysis_segments: ADJACENT_ANALYSIS_SEGMENTS,
  },
  play: async ({ canvasElement }) => {
    await zoom_timeline_overview(canvasElement);
  },
};

export const LongVideoOverview: Story = {
  args: {
    duration_seconds: 7_200,
    initial_time: 3_600,
  },
  play: async ({ canvasElement }) => {
    await zoom_timeline_overview(canvasElement);

    await waitFor(() => {
      expect(timeline_story_zoom(canvasElement)).toBeGreaterThan(0);
      expect(timeline_story_zoom(canvasElement)).toBeLessThan(1);
    });
    expect(
      canvasElement.querySelectorAll(".timeline_grid_line").length,
    ).toBeLessThan(16);
  },
};

export const SelectedPointMarker: Story = {
  args: {
    initial_markers: [POINT_MARKER],
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: /点标记/ }),
    );
  },
};

export const MarqueeSelection: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement).getByLabelText(/时间线画布/);
    const bounds = canvas.getBoundingClientRect();
    await userEvent.pointer([
      {
        keys: "[MouseLeft>]",
        target: canvas,
        coords: { clientX: bounds.left + 150, clientY: bounds.top + 82 },
      },
      {
        target: canvas,
        coords: {
          clientX: Math.min(bounds.right - 8, bounds.left + 700),
          clientY: bounds.top + 126,
        },
      },
      { keys: "[/MouseLeft]" },
    ]);
    expect(
      within(canvasElement).getByRole("button", {
        name: /转写：介绍投影矩阵的基本结构/,
      }),
    ).toHaveAttribute("aria-pressed", "true");
  },
};

export const RangeMarker: Story = {
  args: {
    initial_markers: [RANGE_MARKER],
  },
};

export const CandidateMarker: Story = {
  args: {
    candidate_markers: [CANDIDATE_MARKER],
  },
};

export const SaveError: Story = {
  args: {
    marker_error: "标记时间保存失败，已恢复原位置",
  },
};

export const Narrow: Story = {
  decorators: [
    (StoryComponent) => (
      <div style={{ width: 375 }}>
        <StoryComponent />
      </div>
    ),
  ],
  globals: {
    viewport: { value: "mobile1", isRotated: false },
  },
};

const STRESS_SEGMENT_COUNT = 2_000;
const STRESS_SEGMENT_DURATION_SECONDS = 1.2;
const STRESS_TRANSCRIPT_SEGMENTS: TranscriptSegment[] = Array.from(
  { length: STRESS_SEGMENT_COUNT },
  (_, index) => ({
    start_seconds: index * STRESS_SEGMENT_DURATION_SECONDS,
    end_seconds: (index + 1) * STRESS_SEGMENT_DURATION_SECONDS,
    text: `压力测试片段 ${index + 1}`,
    emotion: null,
    audio_events: [],
  }),
);

export const TwoThousandActions: Story = {
  args: {
    duration_seconds: STRESS_SEGMENT_COUNT * STRESS_SEGMENT_DURATION_SECONDS,
    initial_markers: [],
    transcript_segments: STRESS_TRANSCRIPT_SEGMENTS,
    analysis_segments: [],
  },
  play: async ({ canvasElement }) => {
    const story = within(canvasElement);
    const transcript_actions = await story.findAllByRole("button", {
      name: /^转写：/,
    });
    expect(transcript_actions.length).toBeLessThanOrEqual(100);

    await zoom_timeline_overview(canvasElement);
    await waitFor(() =>
      expect(
        canvasElement.querySelector(".media_timeline_aggregate_hit"),
      ).toBeInTheDocument(),
    );
    expect(story.queryAllByRole("button", { name: /^转写：/ })).toHaveLength(0);
  },
};

export const MixedDensity: Story = {
  args: {
    initial_time: 0,
    transcript_segments: [
      ...Array.from({ length: 32 }, (_, index) => ({
        start_seconds: 1 + index * 0.05,
        end_seconds: 1.04 + index * 0.05,
        text: `密集片段 ${index + 1}`,
        emotion: null,
        audio_events: [],
      })),
      {
        start_seconds: 4,
        end_seconds: 9,
        text: "宽片段继续支持编辑",
        emotion: null,
        audio_events: [],
      },
    ],
  },
  play: async ({ canvasElement }) => {
    const story = within(canvasElement);
    const group = await story.findByRole("button", { name: /^聚合 32/ });
    const zoom = timeline_story_zoom(canvasElement);
    await userEvent.click(group);
    expect(group).toHaveAttribute("aria-pressed", "true");
    expect(timeline_story_zoom(canvasElement)).toBe(zoom);
    expect(
      story.getByRole("button", { name: /转写：宽片段继续支持编辑/ }),
    ).toBeVisible();
    await userEvent.dblClick(group);
    await waitFor(() =>
      expect(timeline_story_zoom(canvasElement)).not.toBe(zoom),
    );
  },
};

export const MixedDensityNarrow: Story = {
  args: MixedDensity.args,
  decorators: Narrow.decorators,
  globals: { viewport: { value: "mobile1", isRotated: false } },
};

export const RulerHover: Story = {
  play: async ({ canvasElement }) => {
    const story = within(canvasElement);
    const ruler = story.getByRole("slider", { name: "时间线播放头" });
    const current = story.getByLabelText("当前播放时间");
    const before = current.textContent;
    const bounds = ruler.getBoundingClientRect();
    await userEvent.pointer({
      target: ruler,
      coords: { clientX: bounds.left + 100, clientY: bounds.top + 12 },
    });
    const hover = story.getByLabelText("标尺悬停时间");
    expect(hover).toBeVisible();
    expect(hover).toHaveTextContent(/\d{2}:\d{2}:\d{2}\.\d{3}/);
    expect(current.textContent).toBe(before);
    await userEvent.unhover(ruler);
    expect(hover).not.toBeVisible();
    expect(canvasElement.querySelector(".media_timeline")).toHaveClass("dark");
  },
};
