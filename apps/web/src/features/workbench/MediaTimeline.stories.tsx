import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { DEFAULT_ANALYSIS_STRATEGY } from "@/shared/analysis";
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
  MINIMUM_ZOOM_PIXELS_PER_SECOND,
} from "./media_timeline_calculations";

const ASSET_ID = "019d3f8a-2b1c-7000-8000-000000000001";
const ZOOM_OUT_TO_MINIMUM_WHEEL_DELTA =
  Math.log(DEFAULT_ZOOM_PIXELS_PER_SECOND / MINIMUM_ZOOM_PIXELS_PER_SECOND) *
  1_000;
const POINT_MARKER: MediaMarker = {
  marker_id: "marker-019d3f8a2b1c70008000000000000001",
  asset_id: ASSET_ID,
  start_seconds: 12,
  end_seconds: null,
  importance: 2,
};
const RANGE_MARKER: MediaMarker = {
  marker_id: "marker-019d3f8a2b1c70008000000000000002",
  asset_id: ASSET_ID,
  start_seconds: 24,
  end_seconds: 31,
  importance: 5,
};
const CANDIDATE_MARKER: MediaMarker = {
  marker_id: "marker-019d3f8a2b1c70008000000000000003",
  asset_id: ASSET_ID,
  start_seconds: 38,
  end_seconds: 43,
  importance: 3,
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
  const [current_time, set_current_time] = useState(initial_time);
  const [markers, set_markers] = useState(initial_markers);
  const [selected_marker_ids, set_selected_marker_ids] = useState<Set<string>>(
    () => new Set(),
  );
  const [selected_transcript_indices, set_selected_transcript_indices] =
    useState<number[]>([]);
  const [is_paused, set_is_paused] = useState(true);
  const [playback_rate, set_playback_rate] = useState(1);

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

  return (
    <div className="h-64 w-full" data-testid="timeline-story-frame">
      <MediaTimeline
        asset_id={ASSET_ID}
        duration_seconds={duration_seconds}
        current_time={current_time}
        is_paused={is_paused}
        playback_rate={playback_rate}
        transcript={{
          asset_id: ASSET_ID,
          language: "zh",
          created_at: "2026-08-27T00:00:00Z",
          segments: transcript_segments,
        }}
        segments={analysis_segments}
        event_analyses={event_analyses}
        focus_selection={focus_selection}
        markers={markers}
        candidate_markers={candidate_markers}
        selected_marker_ids={selected_marker_ids}
        selected_transcript_indices={selected_transcript_indices}
        analysis_strategy={DEFAULT_ANALYSIS_STRATEGY}
        marker_error={marker_error}
        on_scrub={set_current_time}
        on_seek={set_current_time}
        on_toggle_playback={() => set_is_paused((current) => !current)}
        on_playback_rate_change={set_playback_rate}
        on_selected_transcript_indices_change={set_selected_transcript_indices}
        on_selected_marker_ids_change={set_selected_marker_ids}
        on_request_transcript_correction={() => undefined}
        on_add_marker={async () => undefined}
        on_update_marker={update_marker}
        on_delete_marker={async (marker_id) =>
          set_markers((current) =>
            current.filter((marker) => marker.marker_id !== marker_id),
          )
        }
        on_update_transcript={async () => undefined}
        toolbar_tools={null}
      />
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

export const Empty: Story = {
  args: {
    initial_time: 0,
    initial_markers: [],
    transcript_segments: [],
    analysis_segments: [],
  },
};

export const FullThreeTracks: Story = {
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

    editor_grid.scrollTop = 48;
    editor_grid.dispatchEvent(new Event("scroll", { bubbles: true }));
    await waitFor(() =>
      expect(track_labels?.style.transform).toBe(
        "translate3d(0px, -48px, 0px)",
      ),
    );
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

      await waitFor(() => {
        expect(story.getByLabelText("当前时间线缩放")).toHaveTextContent(
          `${MINIMUM_ZOOM_PIXELS_PER_SECOND} px/s`,
        );
      });
      expect(wheel_event.defaultPrevented).toBe(true);

      await userEvent.click(
        story.getByRole("button", { name: "重置时间线缩放" }),
      );
      await waitFor(() => {
        expect(story.getByLabelText("当前时间线缩放")).toHaveTextContent(
          `${DEFAULT_ZOOM_PIXELS_PER_SECOND} px/s`,
        );
      });
      editor_grid.scrollLeft = editor_grid.scrollWidth;
      editor_grid.dispatchEvent(new Event("scroll", { bubbles: true }));
      story.getByRole("slider", { name: "时间线缩放比例" }).focus();
      await userEvent.keyboard("{Home}");
      await waitFor(() => {
        expect(story.getByLabelText("当前时间线缩放")).toHaveTextContent(
          `${MINIMUM_ZOOM_PIXELS_PER_SECOND} px/s`,
        );
      });
      expect(runtime_errors).toEqual([]);
    } finally {
      window.removeEventListener("error", record_runtime_error);
    }
  },
};

export const Dark: Story = {
  decorators: [
    (StoryComponent) => (
      <div className="dark bg-background text-foreground">
        <StoryComponent />
      </div>
    ),
  ],
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

    story.getByRole("slider", { name: "时间线缩放比例" }).focus();
    await userEvent.keyboard("{Home}");
    await waitFor(() =>
      expect(
        canvasElement.querySelector(".media_timeline_lod_canvas"),
      ).toHaveAttribute("data-lod", "overview"),
    );
    expect(story.queryAllByRole("button", { name: /^转写：/ })).toHaveLength(0);
  },
};
