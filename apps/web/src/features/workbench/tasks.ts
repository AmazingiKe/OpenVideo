export type TaskRecord = {
  task_id: string;
  task_type: "download" | "analysis" | "agent";
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
  building_timeline: "构建时间轴",
  extracting_frames: "提取关键帧",
  describing_visuals: "生成画面描述",
  preparing: "准备中",
  invoking_model: "调用模型",
  validating: "校验结果",
  waiting_for_input: "等待处理",
  applying: "保存修正",
  cancelled: "已取消",
  complete: "已完成",
  failed: "失败",
};
