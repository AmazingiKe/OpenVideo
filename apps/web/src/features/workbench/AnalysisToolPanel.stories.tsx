import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

import { AnalysisToolPanel } from "./AnalysisToolPanel";
import type {
  AnalysisStrategyPresetDescriptor,
  MediaAsset,
  TranscriptionModelDescriptor,
} from "@/shared/types";

const ANALYSIS_STRATEGIES: AnalysisStrategyPresetDescriptor[] = [
  {
    preset: "course_notes",
    name: "课程笔记",
    description: "突出核心概念、结论与可复习的知识结构。",
    strategy: {
      preset: "course_notes",
      weights: {
        core_concepts: 90,
        formula_derivation: 65,
        case_demonstration: 60,
        questions_conclusions: 80,
        visual_content: 55,
        user_markers: 100,
      },
      depth: "balanced",
      marker_context_seconds: 30,
    },
  },
];

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
    transcription_models: TRANSCRIPTION_MODELS,
    default_transcription: {
      engine: "faster-whisper",
      model: "large-v3-turbo",
      language: "zh",
      device: "auto",
      compute_type: "auto",
    },
    on_transcription_model_change: () => undefined,
    is_analyzing: false,
    ai_models: [],
    analysis_strategies: ANALYSIS_STRATEGIES,
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

export const DefaultStrategy: Story = {
  args: {
    has_transcript: true,
    open_sections: ["analysis"],
  },
};

export const CustomStrategy: Story = {
  args: DefaultStrategy.args,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "高级设置" }));
    const slider = canvas.getByRole("slider", { name: "核心概念权重" });
    slider.focus();
    await userEvent.keyboard("{ArrowLeft}");
    await expect(
      canvas.getByRole("combobox", { name: "分析策略" }),
    ).toHaveTextContent("自定义");
  },
};

export const AnalysisDisabled: Story = {
  args: {
    has_transcript: false,
    open_sections: ["analysis"],
  },
};

export const AnalysisRunning: Story = {
  args: {
    has_transcript: true,
    is_analyzing: true,
    open_sections: ["analysis"],
  },
};

export const NarrowStrategy: Story = {
  args: DefaultStrategy.args,
  decorators: [
    (StoryComponent) => (
      <div className="h-[640px] w-[280px] overflow-hidden bg-background text-foreground">
        <StoryComponent />
      </div>
    ),
  ],
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
