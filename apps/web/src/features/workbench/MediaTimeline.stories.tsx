import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";

import { DEFAULT_ANALYSIS_STRATEGY } from "@/shared/analysis";
import type { MediaMarker, MediaMarkerUpdate } from "@/shared/types";
import { MediaTimeline } from "./MediaTimeline";

const INITIAL_MARKERS: MediaMarker[] = [
  {
    marker_id: "marker-019d3f8a2b1c70008000000000000001",
    asset_id: "019d3f8a-2b1c-7000-8000-000000000001",
    start_seconds: 4,
    end_seconds: null,
    importance: 0,
  },
  {
    marker_id: "marker-019d3f8a2b1c70008000000000000002",
    asset_id: "019d3f8a-2b1c-7000-8000-000000000001",
    start_seconds: 10,
    end_seconds: 15,
    importance: 5,
  },
];

function TimelineStory() {
  const [markers, set_markers] = useState(INITIAL_MARKERS);

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
    <div className="h-72 w-full">
      <MediaTimeline
        duration_seconds={120}
        current_time={12}
        transcript={{
          asset_id: "019d3f8a-2b1c-7000-8000-000000000001",
          language: "zh",
          created_at: "2026-08-27T00:00:00Z",
          segments: [
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
          ],
        }}
        segments={[]}
        markers={markers}
        analysis_strategy={DEFAULT_ANALYSIS_STRATEGY}
        marker_error={null}
        on_seek={() => undefined}
        on_selected_transcript_indices_change={() => undefined}
        on_add_marker={async () => undefined}
        on_update_marker={update_marker}
        on_delete_marker={async (marker_id) =>
          set_markers((current) =>
            current.filter((marker) => marker.marker_id !== marker_id),
          )
        }
        on_update_transcript={async () => undefined}
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
} satisfies Meta<typeof TimelineStory>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Importance: Story = {};
