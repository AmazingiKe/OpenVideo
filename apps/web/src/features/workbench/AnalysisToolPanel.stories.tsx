import { type ComponentProps, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

import { AnalysisToolPanel } from "./AnalysisToolPanel";
import { DEFAULT_ANALYSIS_STRATEGY } from "@/shared/analysis";
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
      marker_range_before_seconds: 10,
      marker_range_after_seconds: 20,
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
    return Promise.resolve(
      Response.json([
        {
          definition: {
            agent_id: "transcript_correction",
            title: "字幕纠错",
            description: "校对选中的字幕片段并生成整批修改预览。",
            mode: "task",
            prompt: "字幕校对",
            required_capabilities: ["tools", "long_context"],
            minimum_context_tokens: 32000,
            tools: [
              {
                name: "correct_transcript",
                description: "校对字幕",
                prerequisites: [],
              },
            ],
            required_tools: ["correct_transcript"],
            requires_approval: true,
            result_type: "transcript_correction",
            input_mode: "task",
          },
          available: false,
          compatible_model_ids: [],
          capability_model_ids: {},
          unavailable_reason: "没有满足能力要求的模型",
        },
      ]),
    );
  }
  if (url.includes("/api/agent-sessions")) {
    return Promise.resolve(Response.json([]));
  }
  return Promise.resolve(Response.json({}));
}

function ControlledAnalysisToolPanel(
  props: ComponentProps<typeof AnalysisToolPanel>,
) {
  const [analysis_strategy, set_analysis_strategy] = useState(
    structuredClone(props.analysis_strategy),
  );
  return (
    <AnalysisToolPanel
      {...props}
      analysis_strategy={analysis_strategy}
      set_analysis_strategy={set_analysis_strategy}
    />
  );
}

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
    analysis_strategy: DEFAULT_ANALYSIS_STRATEGY,
    set_analysis_strategy: () => undefined,
    on_start_analysis: () => undefined,
    analysis_proposal: null,
    on_resolve_analysis: () => undefined,
    selected_transcript_indices: [],
    on_transcript_changed: () => undefined,
    open_sections: ["video_information"],
    on_open_sections_change: () => undefined,
    on_collapsed_change: () => undefined,
  },
  render: (args) => <ControlledAnalysisToolPanel {...args} />,
  beforeEach() {
    const original_fetch = window.fetch;
    window.fetch = agent_fetch;
    return () => {
      window.fetch = original_fetch;
    };
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
    selected_transcript_indices: [0],
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
