import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";

import { DEFAULT_ANALYSIS_STRATEGY } from "@/shared/analysis";
import type {
  MediaMarker,
  MediaMarkerUpdate,
  MediaSegment,
  TranscriptSegment,
} from "@/shared/types";
import { MediaTimeline } from "./MediaTimeline";

const ASSET_ID = "019d3f8a-2b1c-7000-8000-000000000001";
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
    marker_ids: [],
    tags: ["推导"],
  },
];

type TimelineStoryProps = {
  duration_seconds: number;
  initial_time: number;
  initial_markers: MediaMarker[];
  candidate_markers: MediaMarker[];
  transcript_segments: TranscriptSegment[];
  analysis_segments: MediaSegment[];
  marker_error: string | null;
};

function TimelineStory({
  duration_seconds,
  initial_time,
  initial_markers,
  candidate_markers,
  transcript_segments,
  analysis_segments,
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
    const transcript_actions = await within(canvasElement).findAllByRole(
      "button",
      { name: /^转写：/ },
    );
    expect(transcript_actions.length).toBeLessThanOrEqual(100);
  },
};
