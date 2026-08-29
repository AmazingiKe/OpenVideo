import type { DownloadEvent } from "@/shared/types";

export type TaskRecord = {
  task_id: string;
  task_type: "download" | "transcription" | "agent" | "index";
  stage: string;
  message: string;
  progress_percent: number;
  error_message: string | null;
  created_at: string;
  name: string;
  events: DownloadEvent[];
  resume_available?: boolean;
};

const MAX_TASK_RECORDS = 100;

export function merge_task_record(
  current_tasks: TaskRecord[],
  updated_task: TaskRecord,
): TaskRecord[] {
  const existing_task_index = current_tasks.findIndex(
    (task) => task.task_id === updated_task.task_id,
  );
  const next_tasks = [...current_tasks];

  if (existing_task_index === -1) {
    next_tasks.push(updated_task);
  } else {
    next_tasks[existing_task_index] = updated_task;
  }

  return next_tasks.sort(compare_task_records).slice(0, MAX_TASK_RECORDS);
}

function compare_task_records(left: TaskRecord, right: TaskRecord): number {
  const created_at_difference =
    Date.parse(right.created_at) - Date.parse(left.created_at);
  if (created_at_difference !== 0) return created_at_difference;
  return right.task_id.localeCompare(left.task_id);
}

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
  running: "运行中",
  waiting_for_approval: "等待批准",
  interrupted: "已中断",
};
