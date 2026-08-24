import type { Meta, StoryObj } from "@storybook/react-vite";

import { TranscriptionModelSettings } from "./TranscriptionModelSettings";
import type { TranscriptionModelDescriptor } from "@/shared/types";

const MODELS: TranscriptionModelDescriptor[] = [
  {
    engine: "faster-whisper",
    model: "small",
    name: "Whisper Small",
    description: "兼顾资源占用与识别质量。",
    accuracy: "标准",
    speed: "快",
    languages: ["多语言"],
    repository: "Systran/faster-whisper-small",
    recommended: false,
    integration_status: "available",
    installation_status: "installed",
    download_job: null,
  },
  {
    engine: "faster-whisper",
    model: "large-v3-turbo",
    name: "Whisper Large V3 Turbo",
    description: "高精度与推理速度的推荐平衡方案。",
    accuracy: "高",
    speed: "较快",
    languages: ["多语言", "粤语"],
    repository: "dropbox-dash/faster-whisper-large-v3-turbo",
    recommended: true,
    integration_status: "available",
    installation_status: "not_installed",
    download_job: null,
  },
  {
    engine: "qwen3-asr",
    model: "qwen3-asr-1.7b",
    name: "Qwen3-ASR 1.7B",
    description: "中文高精度方案，使用 ForcedAligner 生成准确时间戳，仅支持 CUDA。",
    accuracy: "最高",
    speed: "较慢",
    languages: ["中文", "22 种中文方言"],
    repository: "Qwen/Qwen3-ASR-1.7B",
    recommended: false,
    integration_status: "available",
    installation_status: "not_installed",
    download_job: null,
  },
  {
    engine: "sensevoice",
    model: "sensevoice-small",
    name: "SenseVoice Small",
    description: "低延迟多语言转录，同时保存声音事件与情绪标签，支持 CPU 回退。",
    accuracy: "高",
    speed: "很快",
    languages: ["中文", "粤语"],
    repository: "FunAudioLLM/SenseVoiceSmall",
    recommended: false,
    integration_status: "available",
    installation_status: "failed",
    download_job: {
      job_id: "model-download-0198d12345677890abcdef1234567891",
      engine: "sensevoice",
      model: "sensevoice-small",
      stage: "failed",
      progress_percent: 24,
      downloaded_bytes: 240,
      total_bytes: 1000,
      message: "模型下载失败",
      error_message: "网络连接已中断",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:01Z",
    },
  },
];

const meta = {
  title: "Settings/TranscriptionModelSettings",
  component: TranscriptionModelSettings,
  args: {
    models: MODELS,
    value: {
      engine: "faster-whisper",
      model: "small",
      language: "zh",
      device: "cpu",
      compute_type: "int8",
    },
    on_change: () => undefined,
    on_model_change: () => undefined,
  },
  decorators: [
    (StoryComponent) => (
      <div className="mx-auto max-w-5xl p-8">
        <StoryComponent />
      </div>
    ),
  ],
} satisfies Meta<typeof TranscriptionModelSettings>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const UnavailableDefault: Story = {
  args: {
    value: {
      engine: "faster-whisper",
      model: "large-v3-turbo",
      language: "zh",
      device: "auto",
      compute_type: "auto",
    },
  },
};

export const Dark: Story = {
  decorators: [
    (StoryComponent) => (
      <div className="dark bg-background p-8 text-foreground">
        <StoryComponent />
      </div>
    ),
  ],
};
