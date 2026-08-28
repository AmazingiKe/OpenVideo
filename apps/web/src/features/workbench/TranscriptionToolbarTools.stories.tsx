import { type ComponentProps, useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import type { MediaAsset, TranscriptionModelDescriptor } from "@/shared/types";
import {
  TranscriptionToolbarTools,
  type TranscriptCorrectionScope,
} from "./TranscriptionToolbarTools";

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
    installation_status: "installed",
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

function ControlledTranscriptionToolbarTools(
  props: ComponentProps<typeof TranscriptionToolbarTools>,
) {
  const [correction_open, set_correction_open] = useState(
    props.correction_open,
  );
  const [correction_scope, set_correction_scope] =
    useState<TranscriptCorrectionScope>(props.correction_scope);
  return (
    <div className="media_timeline_toolbar">
      <div className="media_timeline_transport">
        <TranscriptionToolbarTools
          {...props}
          correction_open={correction_open}
          correction_scope={correction_scope}
          on_correction_open_change={set_correction_open}
          on_correction_scope_change={set_correction_scope}
        />
      </div>
    </div>
  );
}

function DarkTranscriptionToolbarTools(
  props: ComponentProps<typeof TranscriptionToolbarTools>,
) {
  useEffect(() => {
    document.documentElement.classList.add("dark");
    return () => document.documentElement.classList.remove("dark");
  }, []);
  return <ControlledTranscriptionToolbarTools {...props} />;
}

const meta = {
  title: "Workbench/TranscriptionToolbarTools",
  component: TranscriptionToolbarTools,
  args: {
    asset: ASSET,
    has_transcript: true,
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
    correction_open: false,
    correction_scope: "all",
    on_correction_open_change: () => undefined,
    on_correction_scope_change: () => undefined,
  },
  render: (args) => <ControlledTranscriptionToolbarTools {...args} />,
  beforeEach() {
    const original_fetch = window.fetch;
    window.fetch = agent_fetch;
    return () => {
      window.fetch = original_fetch;
    };
  },
  decorators: [
    (StoryComponent) => (
      <div className="flex min-h-screen w-full items-end bg-background text-foreground">
        <StoryComponent />
      </div>
    ),
  ],
} satisfies Meta<typeof TranscriptionToolbarTools>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Transcribing: Story = {
  args: { is_transcribing: true },
};

export const CorrectionSelection: Story = {
  args: {
    selected_transcript_indices: [0, 1],
    correction_open: true,
    correction_scope: "selection",
  },
};

export const Dark: Story = {
  render: (args) => <DarkTranscriptionToolbarTools {...args} />,
};
