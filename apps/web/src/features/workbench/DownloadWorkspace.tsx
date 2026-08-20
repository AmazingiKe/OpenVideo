import { type FormEvent } from "react";
import { Link2, ListVideo, ScrollText } from "lucide-react";

import { format_duration } from "../../shared/format";
import type { HealthResponse, ProbeResponse } from "../../shared/types";
import { TASK_STAGE_LABELS, type TaskRecord } from "./TaskDrawer";


type DownloadWorkspaceProps = {
  health: HealthResponse | null;
  task_records: TaskRecord[];
  source_url: string;
  probe_result: ProbeResponse | null;
  selected_urls: Set<string>;
  is_submitting: boolean;
  error: string | null;
  on_source_url_change: (value: string) => void;
  on_submit_probe: (event: FormEvent<HTMLFormElement>) => void;
  on_toggle_url: (url: string) => void;
  on_start_download: () => void;
};

export function DownloadWorkspace({
  health,
  task_records,
  source_url,
  probe_result,
  selected_urls,
  is_submitting,
  error,
  on_source_url_change,
  on_submit_probe,
  on_toggle_url,
  on_start_download,
}: DownloadWorkspaceProps) {
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
          <p>支持 Bilibili、抖音、YouTube 与播放列表。检测完成后可选择要下载的集数。</p>
          <form className="download_source_form" onSubmit={on_submit_probe}>
            <label htmlFor="source_url">视频或播放列表地址</label>
            <div>
              <input
                id="source_url"
                type="url"
                value={source_url}
                onChange={(event) => on_source_url_change(event.target.value)}
                placeholder="粘贴视频地址"
                disabled={is_submitting}
              />
              <button type="submit" disabled={is_submitting || !dependencies_ready}>
                {is_submitting ? "检测中…" : "检测"}
              </button>
            </div>
          </form>
          {error ? <p className="module_error" role="alert">{error}</p> : null}
          {!dependencies_ready ? <small>正在检查 yt-dlp 与 ffmpeg 是否可用。</small> : null}
        </section>
        {probe_result ? (
          <section className="module_card download_selection_card">
            <header>
              <div><ListVideo aria-hidden="true" /><h2>{probe_result.title ?? "检测结果"}</h2></div>
              <span>已选 {selected_urls.size} / {probe_result.entries.length}</span>
            </header>
            <ul className="download_selection_list">
              {probe_result.entries.map((entry) => (
                <li key={entry.source_video_id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={selected_urls.has(entry.url)}
                      onChange={() => on_toggle_url(entry.url)}
                      disabled={is_submitting}
                    />
                    <span>{entry.title ?? entry.source_video_id}</span>
                    <small>{format_duration(entry.duration_seconds)}</small>
                  </label>
                </li>
              ))}
            </ul>
            <button type="button" onClick={on_start_download} disabled={is_submitting || selected_urls.size === 0}>
              下载选中的 {selected_urls.size} 个视频
            </button>
          </section>
        ) : null}
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
