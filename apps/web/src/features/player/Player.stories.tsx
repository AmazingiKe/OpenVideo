import type { Meta, StoryObj } from "@storybook/react-vite";
import { type ComponentProps, useRef, useState } from "react";
import { expect, fireEvent, within } from "storybook/test";

import { Player, type PlayerHandle } from "./Player";
import type { ScrubPreviewMetrics } from "./use_scrub_frame_preview";

const DEMO_VIDEO_URL = "https://files.vidstack.io/sprite-fight/720p.mp4";

const meta = {
  title: "Media/Player",
  component: Player,
  decorators: [
    (StoryComponent) => (
      <div className="h-96 w-full bg-background p-4">
        <StoryComponent />
      </div>
    ),
  ],
  parameters: {
    layout: "fullscreen",
  },
  args: {
    src: DEMO_VIDEO_URL,
    markers: [
      { start_seconds: 3, label: "开场" },
      { start_seconds: 8, label: "动作段落" },
    ],
    subtitles: [],
    evidence_range: null,
    fallback_storyboard: null,
  },
} satisfies Meta<typeof Player>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(await canvas.findByRole("button", { name: "播放" })).toBeVisible();
    expect(await canvas.findByRole("button", { name: "设置" })).toBeVisible();
    expect(await canvas.findByRole("button", { name: "上一帧" })).toBeVisible();
    expect(await canvas.findByRole("button", { name: "下一帧" })).toBeVisible();
    expect(canvas.getByLabelText("当前精确时间")).toBeVisible();
  },
};

export const DeferredSeekRefresh: Story = {
  args: {
    subtitles: [
      {
        start_seconds: 0,
        end_seconds: 5,
        text: "开场字幕",
        emotion: null,
        audio_events: [],
      },
      {
        start_seconds: 5,
        end_seconds: 12,
        text: "跳转后字幕",
        emotion: null,
        audio_events: [],
      },
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const player = canvas.getByLabelText("OpenVideo 播放器");
    expect(await canvas.findByText("开场字幕")).toBeVisible();

    fireEvent(
      player,
      new CustomEvent("media-seeking-request", {
        bubbles: true,
        composed: true,
        detail: 8,
      }),
    );

    expect(canvas.getByText("开场字幕")).toBeVisible();
    expect(canvas.queryByText("跳转后字幕")).not.toBeInTheDocument();
  },
};

export const Dark: Story = {
  decorators: [
    (StoryComponent) => (
      <div className="dark h-full bg-background text-foreground">
        <StoryComponent />
      </div>
    ),
  ],
};

export const Narrow: Story = {
  globals: {
    viewport: { value: "mobile1", isRotated: false },
  },
};

export const SubtitleOffset: Story = {
  args: {
    subtitles: [
      {
        start_seconds: 1,
        end_seconds: 8,
        text: "偏移后的字幕与同一媒体时钟同步",
        emotion: null,
        audio_events: [],
      },
    ],
    subtitle_display: {
      font_size: "medium",
      position: "bottom",
      background: "solid",
      offset_milliseconds: 500,
    },
  },
};

export const PerformanceProbe: Story = {
  render: (args) => <PerformanceProbePlayer {...args} />,
};

function PerformanceProbePlayer(props: ComponentProps<typeof Player>) {
  const player_ref = useRef<PlayerHandle>(null);
  const [metrics, set_metrics] = useState<ScrubPreviewMetrics | null>(null);
  const [unavailable_reason, set_unavailable_reason] = useState<string | null>(
    null,
  );
  const query = new URLSearchParams(window.location.search);
  const source_url = query.get("source") ?? props.src;
  const duration_seconds = Number(query.get("duration")) || 12;
  return (
    <div className="grid h-full grid-rows-[auto_minmax(0,1fr)] gap-2">
      <div className="space-y-2">
        <output
          aria-label="拖动取帧性能"
          className="block rounded-md border bg-card px-3 py-2 text-xs text-muted-foreground tabular-nums"
        >
          {unavailable_reason
            ? `unavailable · ${unavailable_reason}`
            : metrics
              ? `${metrics.mode} · ${metrics.preview_width}×${metrics.preview_height} · ${metrics.decode_milliseconds.toFixed(1)} ms · ${metrics.range_request_count} Range · ${metrics.bytes_read} bytes · request ${metrics.requested_time_seconds.toFixed(3)} s · frame ${metrics.frame_time_seconds.toFixed(3)} s`
              : "拖动进度条后显示取帧指标"}
        </output>
        <label className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2 text-xs text-muted-foreground">
          诊断目标时间
          <input
            aria-label="拖动取帧诊断目标"
            className="w-full accent-primary"
            type="range"
            min={0}
            max={duration_seconds}
            step="any"
            defaultValue={0}
            onInput={(event) =>
              player_ref.current?.update_scrub(Number(event.currentTarget.value))
            }
          />
        </label>
      </div>
      <Player
        ref={player_ref}
        {...props}
        src={source_url}
        on_scrub_preview_metrics={(next_metrics) => {
          set_unavailable_reason(null);
          set_metrics(next_metrics);
        }}
        on_scrub_preview_unavailable={set_unavailable_reason}
      />
    </div>
  );
}
