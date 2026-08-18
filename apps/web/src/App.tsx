import { FormEvent, useEffect, useRef, useState } from "react";

import { ApiError, create_download, get_health, list_assets, media_url } from "./api";
import { format_duration, format_time } from "./format";
import { Player, PlayerHandle } from "./player/Player";
import { use_asset_markers } from "./player/use_asset_markers";
import { poll_download } from "./poll_download";
import type { DownloadJob, HealthResponse, MediaAsset } from "./types";

const terminal_stages = new Set(["complete", "failed"]);

export function App() {
  const [source_url, set_source_url] = useState("");
  const [health, set_health] = useState<HealthResponse | null>(null);
  const [assets, set_assets] = useState<MediaAsset[]>([]);
  const [selected_asset_id, set_selected_asset_id] = useState<string | null>(null);
  const [active_job, set_active_job] = useState<DownloadJob | null>(null);
  const [is_submitting, set_is_submitting] = useState(false);
  const [page_error, set_page_error] = useState<string | null>(null);
  const [current_time, set_current_time] = useState(0);
  const player_ref = useRef<PlayerHandle>(null);
  const poll_controller_ref = useRef<AbortController | null>(null);

  const selected_asset =
    assets.find((asset) => asset.asset_id === selected_asset_id) ?? null;

  const { markers, add_marker, remove_marker } = use_asset_markers(
    selected_asset?.asset_id ?? "",
  );

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      get_health(controller.signal).then(set_health),
      refresh_assets(controller.signal),
    ]).catch((error: unknown) => {
      if (!is_abort_error(error)) set_page_error(error_message(error));
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    return () => poll_controller_ref.current?.abort();
  }, []);

  async function refresh_assets(signal?: AbortSignal) {
    const next_assets = await list_assets(signal);
    set_assets(next_assets);
    set_selected_asset_id((current_id) => {
      if (current_id && next_assets.some((asset) => asset.asset_id === current_id)) {
        return current_id;
      }
      return next_assets.find((asset) => asset.status === "ready")?.asset_id ?? null;
    });
  }

  async function submit_download(event: FormEvent) {
    event.preventDefault();
    const normalized_url = source_url.trim();
    if (!normalized_url) {
      set_page_error("请先粘贴 Bilibili 视频地址");
      return;
    }
    poll_controller_ref.current?.abort();
    const controller = new AbortController();
    poll_controller_ref.current = controller;
    set_is_submitting(true);
    set_page_error(null);
    try {
      const job = await create_download(normalized_url);
      set_active_job(job);
      const final_job = terminal_stages.has(job.stage)
        ? job
        : await poll_download(job, set_active_job, controller.signal);
      set_active_job(final_job);
      if (final_job.stage === "complete") {
        await refresh_assets(controller.signal);
        set_selected_asset_id(final_job.asset_id);
        set_source_url("");
      } else {
        set_page_error(final_job.error_message ?? "视频下载失败");
      }
    } catch (error: unknown) {
      if (!is_abort_error(error)) set_page_error(error_message(error));
    } finally {
      if (poll_controller_ref.current === controller) {
        set_is_submitting(false);
        poll_controller_ref.current = null;
      }
    }
  }

  function seek_to(seconds: number) {
    player_ref.current?.seek_to(seconds);
  }

  const dependencies_ready = Boolean(health?.dependencies.yt_dlp && health.dependencies.ffmpeg);

  return (
    <div className="app_shell">
      <header className="hero">
        <div>
          <p className="eyebrow">OPENVIDEO · PROTOTYPE</p>
          <h1>获取视频，建立可回溯的时间轴。</h1>
          <p className="hero_copy">
            当前雏形支持 Bilibili 公开视频下载与本地播放。下一步将在同一播放器上加入 MediaSegment、字幕和画面分析。
          </p>
        </div>
        <DependencyBadge health={health} />
      </header>

      <main>
        <section className="download_panel" aria-labelledby="download_title">
          <div className="section_heading">
            <div>
              <span className="step_number">01</span>
              <h2 id="download_title">获取 Bilibili 视频</h2>
            </div>
            <span className="section_note">公开单视频 · HTTPS</span>
          </div>
          <form className="download_form" onSubmit={submit_download}>
            <label htmlFor="source_url">视频地址</label>
            <div className="input_row">
              <input
                id="source_url"
                name="source_url"
                type="url"
                value={source_url}
                onChange={(event) => set_source_url(event.target.value)}
                placeholder="https://www.bilibili.com/video/BV..."
                disabled={is_submitting}
                autoComplete="off"
              />
              <button type="submit" disabled={is_submitting || health === null || !dependencies_ready}>
                {is_submitting ? "处理中…" : "开始下载"}
              </button>
            </div>
          </form>

          {active_job ? <DownloadProgress job={active_job} /> : null}
          {page_error ? (
            <div className="error_message" role="alert">
              {page_error}
            </div>
          ) : null}
        </section>

        <section className="workspace" aria-label="媒体工作区">
          <aside className="asset_library">
            <div className="section_heading compact">
              <div>
                <span className="step_number">02</span>
                <h2>媒体库</h2>
              </div>
              <span className="asset_count">{assets.length}</span>
            </div>
            {assets.length === 0 ? (
              <div className="empty_state">
                <span>暂无视频</span>
                <p>下载完成后，视频会保存在本地媒体库中。</p>
              </div>
            ) : (
              <ul className="asset_list">
                {assets.map((asset) => (
                  <li key={asset.asset_id}>
                    <button
                      className={asset.asset_id === selected_asset_id ? "asset_item selected" : "asset_item"}
                      onClick={() => set_selected_asset_id(asset.asset_id)}
                      aria-pressed={asset.asset_id === selected_asset_id}
                    >
                      <span className="asset_thumbnail">
                        {asset.thumbnail_url ? (
                          <img src={media_url(asset.thumbnail_url)} alt="" />
                        ) : (
                          <span>{asset.status === "ready" ? "▶" : "…"}</span>
                        )}
                      </span>
                      <span className="asset_text">
                        <strong>{asset.title}</strong>
                        <small>
                          {asset.author_name ?? "未知作者"} · {format_duration(asset.duration_seconds)}
                        </small>
                      </span>
                      <span className={`status_dot ${asset.status}`} title={asset.status} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>

          <section className="player_panel" aria-labelledby="player_title">
            <div className="section_heading compact">
              <div>
                <span className="step_number">03</span>
                <h2 id="player_title">播放器</h2>
              </div>
              {selected_asset?.source_video_id ? (
                <span className="section_note">{selected_asset.source_video_id}</span>
              ) : null}
            </div>
            {selected_asset?.playback_url ? (
              <>
                <div className="video_frame">
                  <Player
                    key={selected_asset.asset_id}
                    ref={player_ref}
                    src={media_url(selected_asset.playback_url)}
                    markers={markers}
                    on_time_change={set_current_time}
                  />
                </div>
                <div className="player_toolbar">
                  <button
                    className="add_marker_button"
                    type="button"
                    disabled={current_time <= 0}
                    onClick={() => add_marker(current_time)}
                  >
                    添加标记 @ {format_time(current_time)}
                  </button>
                  {markers.length === 0 ? (
                    <span className="marker_empty_hint">
                      在播放中点击按钮添加时间点标记，点击标记可跳转到对应位置。
                    </span>
                  ) : (
                    <div className="marker_chips">
                      {markers.map((marker) => (
                        <span key={marker.id} className="marker_chip">
                          <button
                            type="button"
                            onClick={() => seek_to(marker.time_seconds)}
                            title="跳转到该时间点"
                          >
                            {marker.label}
                          </button>
                          <button
                            type="button"
                            onClick={() => remove_marker(marker.id)}
                            title="删除标记"
                            aria-label={`删除 ${marker.label} 标记`}
                          >
                            ✕
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="media_details">
                  <div>
                    <h3>{selected_asset.title}</h3>
                    <p>{selected_asset.description || "该视频暂无简介。"}</p>
                  </div>
                  <dl>
                    <div><dt>时长</dt><dd>{format_duration(selected_asset.duration_seconds)}</dd></div>
                    <div><dt>分辨率</dt><dd>{format_resolution(selected_asset)}</dd></div>
                    <div><dt>编码</dt><dd>{format_codecs(selected_asset)}</dd></div>
                  </dl>
                  <button className="seek_demo" type="button" onClick={() => seek_to(0)}>
                    回到 00:00
                  </button>
                </div>
              </>
            ) : (
              <div className="player_empty">
                <span className="player_mark">OV</span>
                <h3>选择一个已完成的视频</h3>
                <p>这里将成为视频、时间轴片段与分析文档之间的连接点。</p>
              </div>
            )}
          </section>
        </section>
      </main>
    </div>
  );
}

function DependencyBadge({ health }: { health: HealthResponse | null }) {
  if (!health) return <span className="dependency_badge checking">正在检查环境</span>;
  const missing = Object.entries(health.dependencies)
    .filter(([, available]) => !available)
    .map(([name]) => name.replace("_", "-"));
  return missing.length === 0 ? (
    <span className="dependency_badge ready">环境已就绪</span>
  ) : (
    <span className="dependency_badge degraded" title={`缺少：${missing.join("、")}`}>
      缺少 {missing.join(" / ")}
    </span>
  );
}

function DownloadProgress({ job }: { job: DownloadJob }) {
  const progress = Math.min(Math.max(job.progress_percent, 0), 100);
  return (
    <div className="progress_card" aria-live="polite">
      <div className="progress_copy">
        <span>{job.message}</span>
        <strong>{progress.toFixed(0)}%</strong>
      </div>
      <div
        className="progress_track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress}
      >
        <span style={{ width: `${progress}%` }} />
      </div>
    </div>
  );
}

function format_resolution(asset: MediaAsset): string {
  return asset.width && asset.height ? `${asset.width} × ${asset.height}` : "未知";
}

function format_codecs(asset: MediaAsset): string {
  return [asset.video_codec, asset.audio_codec].filter(Boolean).join(" / ") || "待探测";
}

function error_message(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return "发生了未知错误";
}

function is_abort_error(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
