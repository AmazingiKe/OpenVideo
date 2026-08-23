import type { Meta, StoryObj } from "@storybook/react-vite";

import { AnalysisToolPanel } from "./AnalysisToolPanel";
import type { MediaAsset } from "@/shared/types";

const ASSET: MediaAsset = {
  asset_id: "01890f4c-7a2b-7cc2-98c4-dc0c0c07398f",
  media_type: "video",
  source_url: "https://www.bilibili.com/video/BV1xx411c7mD",
  source_platform: "bilibili",
  source_video_id: "BV1xx411c7mD",
  title: "从镜头语言理解电影叙事",
  author_name: "开放影像课",
  description: "从构图、运动和剪辑三个层次拆解经典场景。",
  duration_seconds: 180,
  width: 1920,
  height: 1080,
  video_codec: "h264",
  audio_codec: "aac",
  status: "ready",
  error_message: null,
  playback_url: "/stream",
  thumbnail_url: null,
  thumbnail_storyboard: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const meta = {
  title: "Analysis/AnalysisToolPanel",
  component: AnalysisToolPanel,
  args: {
    asset: ASSET,
    markers: [],
    has_transcript: false,
    is_transcribing: false,
    on_start_transcription: () => undefined,
    is_analyzing: false,
    ai_models: [],
    on_start_analysis: () => undefined,
    selected_transcript_count: 0,
    active_correction_scope: null,
    correction_agent_job: null,
    on_start_correction_agent: () => undefined,
    on_agent_response: () => undefined,
    open_sections: ["video_information"],
    on_open_sections_change: () => undefined,
    on_collapsed_change: () => undefined,
  },
  decorators: [
    (StoryComponent) => (
      <div className="dark h-[640px] w-[320px] overflow-hidden bg-background text-foreground">
        <StoryComponent />
      </div>
    ),
  ],
} satisfies Meta<typeof AnalysisToolPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const VideoInformation: Story = {};

export const AllSections: Story = {
  args: {
    has_transcript: true,
    selected_transcript_count: 1,
    open_sections: [
      "video_information",
      "transcription",
      "transcript_correction",
      "analysis",
    ],
  },
};

export const Transcribing: Story = {
  args: {
    is_transcribing: true,
    open_sections: ["transcription"],
  },
};

export const Collapsed: Story = {
  args: { collapsed: true },
  decorators: [
    (StoryComponent) => (
      <div className="h-[640px] w-12 overflow-hidden">
        <StoryComponent />
      </div>
    ),
  ],
};
