import type { AgentIndexStatus } from "@/shared/types";

export type TaskRecord = {
  task_id: string;
  task_type:
    | "probe"
    | "download"
    | "transcription"
    | "agent"
    | "index"
    | "import"
    | "analysis";
  stage: string;
  message: string;
  progress_percent: number;
  progress_known?: boolean;
  error_message: string | null;
  created_at: string;
  name: string;
  asset_id?: string;
  index_state?: AgentIndexStatus["state"];
  retry_available?: boolean;
  pause_available?: boolean;
  cancel_available?: boolean;
  delete_available?: boolean;
  result_available?: boolean;
};

const MAX_TASK_HISTORY_RECORDS = 100;
export const TERMINAL_TASK_STAGES = new Set([
  "complete",
  "failed",
  "cancelled",
  "interrupted",
  "paused",
  "rejected",
]);

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

  let history_count = 0;
  return next_tasks.sort(compare_task_records).filter((task) => {
    if (
      !TERMINAL_TASK_STAGES.has(task.stage) ||
      task.cancel_available ||
      task.pause_available
    )
      return true;
    history_count += 1;
    return history_count <= MAX_TASK_HISTORY_RECORDS;
  });
}

function compare_task_records(left: TaskRecord, right: TaskRecord): number {
  const created_at_difference =
    Date.parse(right.created_at) - Date.parse(left.created_at);
  if (created_at_difference !== 0) return created_at_difference;
  return right.task_id.localeCompare(left.task_id);
}

export const TASK_STAGE_LABELS: Record<string, string> = {
  submitting: "提交中",
  probing: "解析中",
  pausing: "正在暂停",
  paused: "已暂停",
  pending: "等待中",
  preparing_transcription_model: "准备转录模型",
  reading_metadata: "读取信息",
  downloading: "下载中",
  uploading: "上传中",
  processing: "处理中",
  extracting_audio: "提取音频",
  transcribing: "转写中",
  building_timeline: "构建时间轴",
  extracting_frames: "提取关键帧",
  reading_frame_text: "识别画面文字",
  queuing_index: "更新检索索引",
  describing_visuals: "生成画面描述",
  preparing: "准备中",
  invoking_model: "调用模型",
  validating: "校验结果",
  waiting_for_input: "等待处理",
  applying: "保存修正",
  cancelled: "已取消",
  cancelling: "正在停止",
  complete: "已完成",
  failed: "失败",
  rejected: "已拒绝",
  running: "运行中",
  waiting_for_approval: "等待批准",
  interrupted: "已中断",
  queued: "等待中",
  tokenizing: "解析文本",
  building_matrix: "建立特征",
  projecting: "计算投影",
  downloading_embedding_model: "下载嵌入模型",
  loading_embedding_model: "加载嵌入模型",
  embedding_documents: "生成语义向量",
  downloading_reranker_model: "下载重排模型",
  loading_reranker_model: "加载重排模型",
  committing: "切换索引",
};
