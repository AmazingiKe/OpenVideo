import { createRef } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { STORY_ASSETS } from "@/features/library/library_story_fixtures";
import type { PlayerHandle } from "@/features/player/Player";
import { VideoWorkspace } from "./VideoWorkspace";
import { fn } from "storybook/test";

const meta = {
  title: "Workbench/VideoWorkspace",
  component: VideoWorkspace,
  parameters: { layout: "fullscreen" },
  args: {
    asset: STORY_ASSETS[0],
    markers: [],
    transcript: null,
    player_ref: createRef<PlayerHandle>(),
    on_time_change: () => undefined,
    on_pause_change: () => undefined,
    on_playback_rate_change: () => undefined,
  },
  decorators: [
    (Story) => (
      <div className="h-svh">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof VideoWorkspace>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Empty: Story = {
  args: { asset: null },
};

export const ChapterGeneration: Story = {
  args: {
    transcript: {
      asset_id: STORY_ASSETS[0].asset_id,
      created_at: "2026-09-08T00:00:00Z",
      language: "zh",
      segments: [
        {
          start_seconds: 0,
          end_seconds: 10,
          text: "镜头语言课程",
          emotion: null,
          audio_events: [],
        },
      ],
    },
    on_generate_chapters: fn(),
  },
};

export const GeneratingChapters: Story = {
  args: {
    ...ChapterGeneration.args,
    chapter_generation_message: "正在核对章节主题与关键画面",
  },
};

export const ChaptersWithoutTranscript: Story = {
  args: { on_generate_chapters: fn() },
};
