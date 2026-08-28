import { type ComponentProps, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { TranscriptionToolPanel } from "./TranscriptionToolPanel";
import type {
  MediaAsset,
  ToolPanelSection,
  TranscriptionModelDescriptor,
} from "@/shared/types";

const TRANSCRIPTION_MODELS: TranscriptionModelDescriptor[] = [
  {
    engine: "faster-whisper",
    model: "large-v3-turbo",
    name: "Whisper Large V3 Turbo",
    description: "高精度与推理速度的推荐平衡方案。",
    accuracy: "高",
    speed: "较快",
    languages: ["多语言"],
    repository: "dropbox-dash/faster-whisper-large-v3-turbo",
    recommended: true,
    integration_status: "available",
    installation_status: "not_installed",
    download_job: null,
  },
];

const ASSET: MediaAsset = {
  asset_id: "01890f4c-7a2b-7cc2-98c4-dc0c0c07398f",
  folder_id: null,
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
  scrub_preview_url: null,
  thumbnail_url: null,
  thumbnail_storyboard: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

function agent_fetch(input: RequestInfo | URL): Promise<Response> {
  const url = typeof input === "string" ? input : input.toString();
  if (url.includes("/api/agent-definitions")) {
    return Promise.resolve(Response.json([]));
  }
  if (url.includes("/api/agent-sessions")) {
    return Promise.resolve(Response.json([]));
  }
  return Promise.resolve(Response.json({}));
}

function ControlledTranscriptionToolPanel(
  props: ComponentProps<typeof TranscriptionToolPanel>,
) {
  const [open_sections, set_open_sections] = useState<ToolPanelSection[]>(
    props.open_sections,
  );
  return (
    <TranscriptionToolPanel
      {...props}
      open_sections={open_sections}
      on_open_sections_change={set_open_sections}
    />
  );
}

const meta = {
  title: "Workbench/TranscriptionToolPanel",
  component: TranscriptionToolPanel,
  args: {
    asset: ASSET,
    has_transcript: false,
    is_transcribing: false,
    on_start_transcription: () => undefined,
    transcription_models: TRANSCRIPTION_MODELS,
    default_transcription: {
      engine: "faster-whisper",
      model: "large-v3-turbo",
      language: "zh",
      device: "auto",
      compute_type: "auto",
    },
    on_transcription_model_change: () => undefined,
    ai_models: [],
    selected_transcript_indices: [],
    on_transcript_changed: () => undefined,
    open_sections: ["transcription"],
    on_open_sections_change: () => undefined,
    on_collapsed_change: () => undefined,
  },
  render: (args) => <ControlledTranscriptionToolPanel {...args} />,
  beforeEach() {
    const original_fetch = window.fetch;
    window.fetch = agent_fetch;
    return () => {
      window.fetch = original_fetch;
    };
  },
  decorators: [
    (StoryComponent) => (
      <div className="h-[640px] w-[320px] overflow-hidden bg-background text-foreground">
        <StoryComponent />
      </div>
    ),
  ],
} satisfies Meta<typeof TranscriptionToolPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Dark: Story = {
  decorators: [
    (StoryComponent) => (
      <div className="dark h-full bg-background text-foreground">
        <StoryComponent />
      </div>
    ),
  ],
};

export const TranscriptReady: Story = {
  args: {
    has_transcript: true,
    open_sections: ["transcription", "transcript_correction"],
  },
};

export const Transcribing: Story = {
  args: {
    is_transcribing: true,
  },
};

export const CorrectionSelection: Story = {
  args: {
    has_transcript: true,
    selected_transcript_indices: [0],
    open_sections: ["transcript_correction"],
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
