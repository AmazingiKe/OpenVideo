export type TaskRecord = {
  task_id: string;
  task_type: "download" | "analysis";
  stage: string;
  message: string;
  progress_percent: number;
  error_message: string | null;
};

export const TASK_STAGE_LABELS: Record<string, string> = {
  pending: "等待中",
  reading_metadata: "读取信息",
  downloading: "下载中",
  processing: "处理中",
  extracting_audio: "提取音频",
  transcribing: "转写中",
  selecting_moments: "挑选片段",
  extracting_frames: "提取关键帧",
  describing_visuals: "生成画面描述",
  complete: "已完成",
  failed: "失败",
};
