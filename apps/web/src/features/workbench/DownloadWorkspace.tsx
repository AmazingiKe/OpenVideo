import { Link2, ListVideo, ScrollText } from "lucide-react";

import type { HealthResponse } from "../../shared/types";
import { TASK_STAGE_LABELS, type TaskRecord } from "./TaskDrawer";


type DownloadWorkspaceProps = {
  health: HealthResponse | null;
  task_records: TaskRecord[];
  on_open_import: () => void;
};

export function DownloadWorkspace({ health, task_records, on_open_import }: DownloadWorkspaceProps) {
  const download_tasks = task_records.filter((task) => task.task_type === "download");
  const dependencies_ready = Boolean(health?.dependencies.yt_dlp && health.dependencies.ffmpeg);

  return (
    <section className="module_workspace" aria-label="视频下载">
      <header className="module_heading">
        <div>
          <p>视频下载</p>
          <h1>管理在线视频下载</h1>
          <span>检测链接后可选择单集或播放列表，再加入后台下载队列。</span>
        </div>
      </header>
      <div className="module_grid download_grid">
        <section className="module_card download_source_card">
          <Link2 aria-hidden="true" />
          <h2>检测视频链接</h2>
          <p>支持 Bilibili、YouTube 与播放列表。检测完成后可选择要下载的集数。</p>
          <button type="button" onClick={on_open_import} disabled={!dependencies_ready}>检测并选择视频</button>
          {!dependencies_ready ? <small>正在检查 yt-dlp 与 ffmpeg 是否可用。</small> : null}
        </section>
        <section className="module_card download_queue_card">
          <header>
            <div><ListVideo aria-hidden="true" /><h2>下载队列</h2></div>
            <span>{download_tasks.length} 项</span>
          </header>
          {download_tasks.length === 0 ? (
            <p className="module_empty_state">尚未添加下载任务。</p>
          ) : (
            <ul className="module_task_list">
              {download_tasks.map((task) => <DownloadTask key={task.task_id} task={task} />)}
            </ul>
          )}
        </section>
        <section className="module_card download_log_card">
          <header><div><ScrollText aria-hidden="true" /><h2>基础日志</h2></div></header>
          {download_tasks.length === 0 ? (
            <p className="module_empty_state">下载开始后，这里将显示任务的执行阶段与错误信息。</p>
          ) : (
            <ul className="module_log_list">
              {download_tasks.map((task) => (
                <li key={task.task_id}>
                  <strong>{TASK_STAGE_LABELS[task.stage] ?? task.stage}</strong>
                  <span>{task.error_message ?? task.message}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </section>
  );
}

function DownloadTask({ task }: { task: TaskRecord }) {
  const progress = Math.min(Math.max(task.progress_percent, 0), 100);
  const stage_label = TASK_STAGE_LABELS[task.stage] ?? task.stage;
  return (
    <li>
      <div>
        <strong>{stage_label}</strong>
        <span>{task.message}</span>
        <b>{progress.toFixed(0)}%</b>
      </div>
      <div className="module_progress" aria-label={`${stage_label} ${progress.toFixed(0)}%`}>
        <span style={{ width: `${progress}%` }} />
      </div>
      {task.error_message ? <p role="alert">{task.error_message}</p> : null}
    </li>
  );
}
