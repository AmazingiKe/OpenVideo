import { useEffect, useState, type RefObject } from "react";

import { Player, type PlayerHandle } from "../player/Player";
import { format_duration, format_time } from "../../shared/format";
import { media_url } from "../../shared/api";
import type { AnalysisMode, MediaAsset, MediaMarker } from "../../shared/types";


type VideoWorkspaceProps = {
  asset: MediaAsset | null;
  markers: MediaMarker[];
  current_time: number;
  player_ref: RefObject<PlayerHandle | null>;
  on_time_change: (seconds: number) => void;
  on_add_marker: () => void;
  is_analyzing: boolean;
  on_start_analysis: (mode: AnalysisMode, marker_ids: string[]) => void;
};

export function VideoWorkspace({
  asset,
  markers,
  current_time,
  player_ref,
  on_time_change,
  on_add_marker,
  is_analyzing,
  on_start_analysis,
}: VideoWorkspaceProps) {
  const [analysis_mode, set_analysis_mode] = useState<AnalysisMode>("full");
  const [selected_marker_ids, set_selected_marker_ids] = useState<Set<string>>(new Set());

  useEffect(() => {
    set_selected_marker_ids(new Set(markers.map((marker) => marker.marker_id)));
  }, [asset?.asset_id, markers]);

  if (!asset?.playback_url) {
    return (
      <section className="video_workspace video_workspace_empty" aria-label="视频工作区">
        <span>OV</span>
        <h1>选择一个已完成的视频</h1>
        <p>视频、转写、重点片段和手工标记将在同一工作区联动。</p>
      </section>
    );
  }

  return (
    <section className="video_workspace" aria-label="视频工作区">
      <div className="workspace_video_header">
        <div>
          <h1>{asset.title}</h1>
          <p>{asset.author_name ?? "未知作者"} · {format_duration(asset.duration_seconds)}</p>
        </div>
        <dl>
          <div><dt>分辨率</dt><dd>{format_resolution(asset)}</dd></div>
          <div><dt>编码</dt><dd>{format_codecs(asset)}</dd></div>
        </dl>
      </div>
      <div className="workspace_player_frame">
        <Player
          key={asset.asset_id}
          ref={player_ref}
          src={media_url(asset.playback_url)}
          markers={markers.map((marker) => ({
            time_seconds: marker.time_seconds,
            label: format_time(marker.time_seconds),
          }))}
          thumbnails={player_storyboard(asset)}
          on_time_change={on_time_change}
        />
      </div>
      <div className="workspace_video_actions">
        <button type="button" onClick={on_add_marker} disabled={current_time <= 0}>
          添加标记 @ {format_time(current_time)}
        </button>
        <span>{markers.length === 0 ? "播放中可添加标记，之后在右侧统一管理。" : `已添加 ${markers.length} 个标记`}</span>
      </div>
      <section className="analysis_controls" aria-label="分析控制">
        <div className="analysis_mode_options">
          <label>
            <input
              type="radio"
              name="analysis_mode"
              checked={analysis_mode === "full"}
              onChange={() => set_analysis_mode("full")}
            />
            全片时间轴
          </label>
          <label>
            <input
              type="radio"
              name="analysis_mode"
              checked={analysis_mode === "markers"}
              onChange={() => set_analysis_mode("markers")}
              disabled={markers.length === 0}
            />
            标记重点分析
          </label>
        </div>
        {analysis_mode === "markers" ? (
          <div className="analysis_marker_options">
            {markers.map((marker) => (
              <label key={marker.marker_id}>
                <input
                  type="checkbox"
                  checked={selected_marker_ids.has(marker.marker_id)}
                  onChange={() => set_selected_marker_ids((current) => toggle_marker(current, marker.marker_id))}
                />
                <time>{format_time(marker.time_seconds)}</time>
                <span>{marker.tags.join(" / ") || "未分类标记"}</span>
              </label>
            ))}
          </div>
        ) : null}
        <button
          className="workspace_primary_action"
          type="button"
          onClick={() => on_start_analysis(analysis_mode, [...selected_marker_ids])}
          disabled={is_analyzing || (analysis_mode === "markers" && selected_marker_ids.size === 0)}
        >
          {is_analyzing ? "分析中…" : analysis_mode === "full" ? "分析全片" : `分析 ${selected_marker_ids.size} 个标记`}
        </button>
      </section>
      {asset.description ? <p className="workspace_description">{asset.description}</p> : null}
    </section>
  );
}

function toggle_marker(current: Set<string>, marker_id: string): Set<string> {
  const next = new Set(current);
  if (next.has(marker_id)) next.delete(marker_id);
  else next.add(marker_id);
  return next;
}

function format_resolution(asset: MediaAsset): string {
  return asset.width && asset.height ? `${asset.width} × ${asset.height}` : "未知";
}

function format_codecs(asset: MediaAsset): string {
  return [asset.video_codec, asset.audio_codec].filter(Boolean).join(" / ") || "待探测";
}

function player_storyboard(asset: MediaAsset) {
  if (!asset.thumbnail_storyboard) return null;
  return {
    url: media_url(asset.thumbnail_storyboard.url),
    tile_width: asset.thumbnail_storyboard.tile_width,
    tile_height: asset.thumbnail_storyboard.tile_height,
    tiles: asset.thumbnail_storyboard.tiles,
  };
}
