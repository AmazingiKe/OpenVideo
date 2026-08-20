import type { FormEvent } from "react";

import { format_duration } from "../../shared/format";
import type { HealthResponse, ProbeResponse } from "../../shared/types";


type ImportDialogProps = {
  open: boolean;
  source_url: string;
  health: HealthResponse | null;
  is_submitting: boolean;
  probe_result: ProbeResponse | null;
  selected_urls: Set<string>;
  error: string | null;
  on_close: () => void;
  on_source_url_change: (value: string) => void;
  on_submit: (event: FormEvent<HTMLFormElement>) => void;
  on_toggle_url: (url: string) => void;
  on_submit_playlist: () => void;
};

export function ImportDialog({
  open,
  source_url,
  health,
  is_submitting,
  probe_result,
  selected_urls,
  error,
  on_close,
  on_source_url_change,
  on_submit,
  on_toggle_url,
  on_submit_playlist,
}: ImportDialogProps) {
  if (!open) return null;
  const dependencies_ready = Boolean(health?.dependencies.yt_dlp && health.dependencies.ffmpeg);
  return (
    <div className="dialog_backdrop" role="presentation">
      <section className="import_dialog" role="dialog" aria-modal="true" aria-labelledby="import_title">
        <div className="dialog_heading">
          <div><h2 id="import_title">导入在线视频</h2><p>支持 Bilibili、YouTube 与播放列表。</p></div>
          <button type="button" onClick={on_close} aria-label="关闭导入窗口">×</button>
        </div>
        <form onSubmit={on_submit}>
          <label htmlFor="source_url">视频或播放列表地址</label>
          <div className="dialog_input_row">
            <input
              id="source_url"
              type="url"
              value={source_url}
              onChange={(event) => on_source_url_change(event.target.value)}
              placeholder="粘贴视频地址"
              disabled={is_submitting}
              autoFocus
            />
            <button type="submit" disabled={is_submitting || !dependencies_ready}>
              {is_submitting ? "处理中…" : "检测"}
            </button>
          </div>
        </form>
        {probe_result ? (
          <div className="playlist_picker">
            <header><strong>{probe_result.title ?? "播放列表"}</strong><span>已选 {selected_urls.size} / {probe_result.entries.length}</span></header>
            <ol>
              {probe_result.entries.map((entry) => (
                <li key={entry.source_video_id}>
                  <label>
                    <input type="checkbox" checked={selected_urls.has(entry.url)} onChange={() => on_toggle_url(entry.url)} />
                    <span>{entry.title ?? entry.source_video_id}</span>
                    <small>{format_duration(entry.duration_seconds)}</small>
                  </label>
                </li>
              ))}
            </ol>
            <button type="button" onClick={on_submit_playlist} disabled={is_submitting || selected_urls.size === 0}>
              下载选中的 {selected_urls.size} 个视频
            </button>
          </div>
        ) : null}
        {error ? <p className="dialog_error" role="alert">{error}</p> : null}
      </section>
    </div>
  );
}
