import type { Meta, StoryObj } from "@storybook/react-vite";

import type { SummaryIllustrationJob } from "@/shared/types";
import { SummaryIllustrationProgress } from "./SummaryIllustrationProgress";

const BASE_JOB: SummaryIllustrationJob = {
  job_id: "summary-illustration-job-0198dbf912347abc8123456789abcdef",
  asset_id: "0198dbf9-1234-7abc-8123-456789abcdef",
  version_id: "summary-version-0198dbf912347abc8123456789abcdef",
  planning_model_id: "model-0198dbf912347abc8123456789abcdef",
  vision_model_id: "model-0198dbf912347abc8123456789abcdee",
  stage: "validating",
  progress_percent: 64,
  message: "正在验证候选画面",
  slots: [
    {
      slot_id: "illustration-slot-0198dbf912347abc8123456789abcdef",
      document_id: "document-0198dbf912347abc8123456789abcdef",
      heading_path: ["材质设置", "调整粗糙度"],
      target_excerpt: "打开材质面板并调整粗糙度。",
      retrieval_query: "材质面板 粗糙度",
      caption: "粗糙度参数位置",
      status: "validating",
      candidate_times: [42, 45, 49],
      selected_time: null,
      confidence: null,
      source_excerpt: "在右侧材质面板找到粗糙度。",
      source_types: ["transcript", "ocr"],
      media_id: null,
      message: "正在验证画面是否真正支持笔记",
    },
    {
      slot_id: "illustration-slot-0198dbf912347abc8123456789abcdee",
      document_id: "document-0198dbf912347abc8123456789abcdef",
      heading_path: ["最终效果"],
      target_excerpt: "最终画面会出现清晰反射。",
      retrieval_query: "最终效果 清晰反射",
      caption: "材质最终效果",
      status: "locating",
      candidate_times: [],
      selected_time: null,
      confidence: null,
      source_excerpt: null,
      source_types: [],
      media_id: null,
      message: "正在检索对应的视频证据",
    },
  ],
  inserted_count: 0,
  skipped_count: 0,
  error_message: null,
  created_at: "2026-08-31T10:00:00Z",
  updated_at: "2026-08-31T10:00:08Z",
};

const meta = {
  title: "Summary/IllustrationProgress",
  component: SummaryIllustrationProgress,
  parameters: { layout: "fullscreen" },
  args: {
    job: BASE_JOB,
    now: Date.parse("2026-08-31T10:00:08Z"),
  },
  decorators: [
    (StoryComponent) => (
      <div className="min-h-64 bg-background text-foreground">
        <StoryComponent />
      </div>
    ),
  ],
} satisfies Meta<typeof SummaryIllustrationProgress>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Validating: Story = {};

export const Planning: Story = {
  args: {
    job: {
      ...BASE_JOB,
      stage: "planning",
      progress_percent: 4,
      message: "正在判断哪些内容最需要画面",
      slots: [],
    },
  },
};

export const Complete: Story = {
  args: {
    job: {
      ...BASE_JOB,
      stage: "complete",
      progress_percent: 100,
      message: "配图完成：已插入 1 张，跳过 1 张",
      inserted_count: 1,
      skipped_count: 1,
      slots: [
        {
          ...BASE_JOB.slots[0],
          status: "inserted",
          selected_time: 45,
          confidence: "high",
          media_id: "media-0198dbf912347abc8123456789abcdef",
          message: "已插入高置信度画面",
        },
        {
          ...BASE_JOB.slots[1],
          status: "skipped",
          confidence: "medium",
          message: "视觉验证为中置信度：主体不够明确",
        },
      ],
      updated_at: "2026-08-31T10:00:12Z",
    },
    now: Date.parse("2026-08-31T10:00:12Z"),
  },
};

export const NarrowDark: Story = {
  decorators: [
    (StoryComponent) => (
      <div className="dark min-h-96 w-80 bg-background text-foreground">
        <StoryComponent />
      </div>
    ),
  ],
};
