import { useEffect, useRef, useState, type RefObject } from "react";
import { Pause, Play, RotateCcw, RotateCw } from "lucide-react";

import { Player, type PlayerHandle } from "../player/Player";
import { format_duration, format_time } from "../../shared/format";
import { media_url } from "../../shared/api";
import type { AnalysisMode, MediaAsset, MediaMarker } from "../../shared/types";


type VideoWorkspaceProps = {
  asset: MediaAsset | null;
  markers: MediaMarker[];
  player_ref: RefObject<PlayerHandle | null>;
  on_time_change: (seconds: number) => void;
  has_transcript: boolean;
  is_transcribing: boolean;
  on_start_transcription: () => void;
  is_analyzing: boolean;
  on_start_analysis: (mode: AnalysisMode, marker_ids: string[]) => void;
};

export function VideoWorkspace({
  asset,
  markers,
  player_ref,
  on_time_change,
  has_transcript,
  is_transcribing,
  on_start_transcription,
  is_analyzing,
  on_start_analysis,
}: VideoWorkspaceProps) {
  const [analysis_mode, set_analysis_mode] = useState<AnalysisMode>("full");
  const [selected_marker_ids, set_selected_marker_ids] = useState<Set<string>>(new Set());
  const [is_paused, set_is_paused] = useState(true);
  const transport_time_ref = useRef<number | null>(null);

  useEffect(() => {
    set_selected_marker_ids(new Set(markers.map((marker) => marker.marker_id)));
  }, [asset?.asset_id, markers]);

  useEffect(() => {
    transport_time_ref.current = null;
    set_is_paused(true);
  }, [asset?.asset_id]);

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
          on_time_change={(seconds) => {
            transport_time_ref.current = seconds;
            on_time_change(seconds);
          }}
          on_pause_change={set_is_paused}
        />
      </div>
      <div className="video_transport" aria-label="播放控制">
        <button
          type="button"
          onClick={() => seek_relative(player_ref, transport_time_ref, -10)}
          aria-label="后退 10 秒"
        >
          <RotateCcw aria-hidden="true" />
        </button>
        <button type="button" onClick={() => player_ref.current?.toggle_playback()} aria-label={is_paused ? "播放" : "暂停"}>
          {is_paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
        </button>
        <button
          type="button"
          onClick={() => seek_relative(player_ref, transport_time_ref, 10)}
          aria-label="快进 10 秒"
        >
          <RotateCw aria-hidden="true" />
        </button>
      </div>
      <section className="analysis_controls" aria-label="分析控制">
        <div className="processing_actions">
          <button
            type="button"
            onClick={on_start_transcription}
            disabled={is_transcribing || is_analyzing || has_transcript}
          >
            {is_transcribing ? "转录中…" : has_transcript ? "转录已完成" : "生成转录"}
          </button>
          <span>转录生成可编辑文字；内容分析在转录完成后单独执行。</span>
        </div>
        <div className="analysis_mode_options">
          <label>
            <input
              type="radio"
              name="analysis_mode"
              checked={analysis_mode === "full"}
              onChange={() => set_analysis_mode("full")}
              disabled={!has_transcript}
            />
            全片时间轴
          </label>
          <label>
            <input
              type="radio"
              name="analysis_mode"
              checked={analysis_mode === "markers"}
              onChange={() => set_analysis_mode("markers")}
              disabled={!has_transcript || markers.length === 0}
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
          disabled={
            !has_transcript
            || is_transcribing
            || is_analyzing
            || (analysis_mode === "markers" && selected_marker_ids.size === 0)
          }
        >
          {is_analyzing ? "分析中…" : analysis_mode === "full" ? "分析全片" : `分析 ${selected_marker_ids.size} 个标记`}
        </button>
      </section>
      {asset.description ? <p className="workspace_description">{asset.description}</p> : null}
    </section>
  );
}

function seek_relative(
  player_ref: RefObject<PlayerHandle | null>,
  transport_time_ref: RefObject<number | null>,
  offset_seconds: number,
) {
  const player = player_ref.current;
  if (!player) return;
  const current_time = transport_time_ref.current ?? player.current_time();
  const next_time = Math.max(0, current_time + offset_seconds);
  transport_time_ref.current = next_time;
  player.seek_to(next_time);
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
