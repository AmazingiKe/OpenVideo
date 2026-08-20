export type TaskRecord = {
  task_id: string;
  task_type: "download" | "analysis";
  stage: string;
  message: string;
  progress_percent: number;
  error_message: string | null;
};

type TaskDrawerProps = {
  open: boolean;
  task_records: TaskRecord[];
  on_toggle: () => void;
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

export function TaskDrawer({ open, task_records, on_toggle }: TaskDrawerProps) {
  return (
    <section className={open ? "task_drawer open" : "task_drawer"} aria-label="任务中心">
      <button className="task_drawer_toggle" type="button" onClick={on_toggle} aria-expanded={open}>
        <span>任务中心</span>
        <span>{task_records.length} 项</span>
      </button>
      {open ? (
        <div className="task_list">
          {task_records.map((task) => <TaskProgress key={task.task_id} task={task} />)}
          {task_records.length === 0 ? <p>暂无任务记录。</p> : null}
        </div>
      ) : null}
    </section>
  );
}

function TaskProgress({ task }: { task: TaskRecord }) {
  const bounded_progress = Math.min(Math.max(task.progress_percent, 0), 100);
  const task_name = task.task_type === "download" ? "下载" : "分析";
  const stage_label = TASK_STAGE_LABELS[task.stage] ?? task.stage;
  return (
    <article className="task_progress">
      <div>
        <strong>{task_name}</strong>
        <span>{stage_label} · {task.message}</span>
        <b>{bounded_progress.toFixed(0)}%</b>
      </div>
      <div className="task_progress_track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={bounded_progress}>
        <span style={{ width: `${bounded_progress}%` }} />
      </div>
      {task.error_message ? <p role="alert">{task.error_message}</p> : null}
    </article>
  );
}
