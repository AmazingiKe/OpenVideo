import { FormEvent, useEffect, useRef, useState } from "react";

import { ApiError, create_download, get_health, list_assets, media_url } from "./api";
import { format_duration, format_time } from "./format";
import { Player, PlayerHandle } from "./player/Player";
import { use_asset_markers } from "./player/use_asset_markers";
import { poll_download } from "./poll_download";
import type { DownloadJob, HealthResponse, MediaAsset } from "./types";

const terminal_stages = new Set(["complete", "failed"]);

type ToolKey = "download" | "library" | "player";

const tools: { key: ToolKey; label: string; icon: string }[] = [
  { key: "download", label: "下载", icon: "⤓" },
  { key: "library", label: "媒体库", icon: "▤" },
  { key: "player", label: "播放器", icon: "▶" },
];

export function App() {
  const [active_tool, set_active_tool] = useState<ToolKey>("download");
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

  const { markers, storage_error, add_marker, add_tag, remove_tag, remove_marker } = use_asset_markers(
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

  useEffect(() => {
    set_current_time(0);
  }, [selected_asset_id]);

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

  async function pick_tool(tool: ToolKey) {
    set_active_tool(tool);
    if (tool === "player" && selected_asset_id === null) {
      // 自动回填一个可用视频，避免空播放器
      const fallback = assets.find((asset) => asset.status === "ready");
      if (fallback) set_selected_asset_id(fallback.asset_id);
    }
  }

  function seek_to(seconds: number) {
    player_ref.current?.seek_to(seconds);
  }

  function add_marker_at_current_time() {
    const actual_time = player_ref.current?.current_time() ?? current_time;
    const duration = selected_asset?.duration_seconds;
    const bounded_time = duration === null || duration === undefined
      ? Math.max(0, actual_time)
      : Math.min(Math.max(0, actual_time), duration);
    add_marker(bounded_time);
  }

  const dependencies_ready = Boolean(health?.dependencies.yt_dlp && health.dependencies.ffmpeg);

  return (
    <div className="app_shell">
      <StatusBar
        health={health}
        active_job={active_job}
        selected_asset={selected_asset}
      />

      <div className="app_body">
        <Toolbar active_tool={active_tool} on_tool={pick_tool} />

        <main className="content_pane" aria-label="主工作区">
          {active_tool === "download" ? (
            <DownloadPanel
              source_url={source_url}
              set_source_url={set_source_url}
              is_submitting={is_submitting}
              dependencies_ready={dependencies_ready}
              health={health}
              active_job={active_job}
              page_error={page_error}
              on_submit={submit_download}
            />
          ) : null}

          {active_tool === "library" ? (
            <LibraryPanel
              assets={assets}
              selected_asset_id={selected_asset_id}
              on_select={(id) => set_selected_asset_id(id)}
            />
          ) : null}

          {active_tool === "player" ? (
            <PlayerPanel
              selected_asset={selected_asset}
              markers={markers}
              storage_error={storage_error}
              current_time={current_time}
              player_ref={player_ref}
              on_time_change={set_current_time}
              on_add_marker={add_marker_at_current_time}
              on_remove_marker={remove_marker}
              on_add_tag={add_tag}
              on_remove_tag={remove_tag}
              on_seek={seek_to}
            />
          ) : null}
        </main>
      </div>
    </div>
  );
}

function StatusBar({
  health,
  active_job,
  selected_asset,
}: {
  health: HealthResponse | null;
  active_job: DownloadJob | null;
  selected_asset: MediaAsset | null;
}) {
  return (
    <header className="status_bar">
      <div className="brand">
        <span className="brand_mark">OV</span>
        <span className="brand_name">OpenVideo</span>
      </div>

      <div className="status_cluster">
        <DependencyBadge health={health} />

        {active_job && active_job.stage !== "complete" && active_job.stage !== "failed" ? (
          <span className="status_job" title={active_job.message}>
            <span className="status_spinner" aria-hidden="true" />
            {active_job.message}
          </span>
        ) : null}
      </div>

      <div className="status_asset">
        {selected_asset ? (
          <>
            <span className="status_asset_dot ready" aria-hidden="true" />
            <span className="status_asset_name">{selected_asset.title}</span>
            <span className="status_asset_meta">{format_duration(selected_asset.duration_seconds)}</span>
          </>
        ) : (
          <span className="status_asset_empty">未选择视频</span>
        )}
      </div>
    </header>
  );
}

function Toolbar({
  active_tool,
  on_tool,
}: {
  active_tool: ToolKey;
  on_tool: (tool: ToolKey) => void;
}) {
  return (
    <nav className="toolbar" aria-label="工具">
      {tools.map((tool) => {
        const active = tool.key === active_tool;
        return (
          <button
            key={tool.key}
            className={active ? "tool_button active" : "tool_button"}
            onClick={() => on_tool(tool.key)}
            aria-pressed={active}
            aria-label={tool.label}
            title={tool.label}
          >
            <span className="tool_icon">{tool.icon}</span>
            <span className="tool_label">{tool.label}</span>
          </button>
        );
      })}

      <div className="toolbar_spacer" />

      <button className="tool_button" type="button" aria-label="设置" title="设置（即将推出）">
        <span className="tool_icon">⚙</span>
        <span className="tool_label">设置</span>
      </button>
    </nav>
  );
}

function DownloadPanel({
  source_url,
  set_source_url,
  is_submitting,
  dependencies_ready,
  health,
  active_job,
  page_error,
  on_submit,
}: {
  source_url: string;
  set_source_url: (value: string) => void;
  is_submitting: boolean;
  dependencies_ready: boolean;
  health: HealthResponse | null;
  active_job: DownloadJob | null;
  page_error: string | null;
  on_submit: (event: FormEvent) => void;
}) {
  return (
    <section className="panel" aria-labelledby="download_title">
      <div className="panel_heading">
        <h2 id="download_title">获取 Bilibili 视频</h2>
        <span className="panel_note">公开单视频 · HTTPS</span>
      </div>

      <form className="download_form" onSubmit={on_submit}>
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
  );
}

function LibraryPanel({
  assets,
  selected_asset_id,
  on_select,
}: {
  assets: MediaAsset[];
  selected_asset_id: string | null;
  on_select: (id: string) => void;
}) {
  return (
    <section className="panel" aria-label="媒体库">
      <div className="panel_heading">
        <h2>媒体库</h2>
        <span className="panel_note">{assets.length} 个视频</span>
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
                onClick={() => on_select(asset.asset_id)}
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
    </section>
  );
}

function PlayerPanel({
  selected_asset,
  markers,
  storage_error,
  current_time,
  player_ref,
  on_time_change,
  on_add_marker,
  on_remove_marker,
  on_add_tag,
  on_remove_tag,
  on_seek,
}: {
  selected_asset: MediaAsset | null;
  markers: { id: string; time_seconds: number; label: string; tags: string[] }[];
  storage_error: boolean;
  current_time: number;
  player_ref: React.RefObject<PlayerHandle | null>;
  on_time_change: (seconds: number) => void;
  on_add_marker: () => void;
  on_remove_marker: (id: string) => void;
  on_add_tag: (marker_id: string, tag: string) => void;
  on_remove_tag: (marker_id: string, tag: string) => void;
  on_seek: (seconds: number) => void;
}) {
  return (
    <section className="panel player_panel" aria-labelledby="player_title">
      <div className="panel_heading">
        <h2 id="player_title">播放器</h2>
        {selected_asset?.source_video_id ? (
          <span className="panel_note">{selected_asset.source_video_id}</span>
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
              thumbnails={player_storyboard(selected_asset)}
              on_time_change={on_time_change}
            />
          </div>

          <div className="player_toolbar">
            <button
              className="add_marker_button"
              type="button"
              disabled={current_time <= 0}
              onClick={on_add_marker}
            >
              添加标记 @ {format_time(current_time)}
            </button>
            {storage_error ? (
              <span className="marker_storage_error" role="status">
                无法保存到浏览器，当前修改仅在本次页面中有效。
              </span>
            ) : null}
            {markers.length === 0 ? (
              <span className="marker_empty_hint">
                在播放中点击按钮添加时间点标记，点击标记可跳转到对应位置。
              </span>
            ) : (
              <div className="marker_chips">
                {markers.map((marker) => (
                  <div key={marker.id} className="marker_chip">
                    <div className="marker_chip_header">
                      <button
                        className="marker_time_button"
                        type="button"
                        onClick={() => on_seek(marker.time_seconds)}
                        title="跳转到该时间点"
                      >
                        {marker.label}
                      </button>
                      <button
                        className="marker_remove_button"
                        type="button"
                        onClick={() => on_remove_marker(marker.id)}
                        title="删除标记"
                        aria-label={`删除 ${marker.label} 标记`}
                      >
                        ✕
                      </button>
                    </div>
                    <div className="marker_tags">
                      {marker.tags.map((tag) => (
                        <span key={tag} className="marker_tag">
                          {tag}
                          <button
                            type="button"
                            onClick={() => on_remove_tag(marker.id, tag)}
                            aria-label={`删除标签 ${tag}`}
                            title="删除标签"
                          >
                            ×
                          </button>
                        </span>
                      ))}
                      <form
                        className="marker_tag_form"
                        onSubmit={(event) => {
                          event.preventDefault();
                          const form = event.currentTarget;
                          const tag_input = new FormData(form).get("tag");
                          if (typeof tag_input === "string") on_add_tag(marker.id, tag_input);
                          form.reset();
                        }}
                      >
                        <input
                          name="tag"
                          type="text"
                          placeholder="添加标签"
                          aria-label={`${marker.label} 的标签`}
                          maxLength={40}
                        />
                        <button type="submit" aria-label={`为 ${marker.label} 添加标签`}>
                          添加
                        </button>
                      </form>
                    </div>
                  </div>
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
            <button className="seek_demo" type="button" onClick={() => on_seek(0)}>
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
  );
}

function DependencyBadge({ health }: { health: HealthResponse | null }) {
  if (!health) return <span className="dependency_badge checking">检查环境</span>;
  const missing = Object.entries(health.dependencies)
    .filter(([, available]) => !available)
    .map(([name]) => name.replace("_", "-"));
  return missing.length === 0 ? (
    <span className="dependency_badge ready">
      <span className="status_spinner static" aria-hidden="true" />
      环境就绪
    </span>
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

function player_storyboard(asset: MediaAsset) {
  const storyboard = asset.thumbnail_storyboard;
  if (!storyboard) return null;
  return {
    url: media_url(storyboard.url),
    tile_width: storyboard.tile_width,
    tile_height: storyboard.tile_height,
    tiles: storyboard.tiles,
  };
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
