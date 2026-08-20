import { FormEvent, useState } from "react";

import { format_time } from "../../shared/format";
import { media_url } from "../../shared/api";
import type { MediaMarker, MediaSegment, Transcript } from "../../shared/types";


type InspectorTab = "transcript" | "segments" | "markers";

type InspectorProps = {
  asset_id: string;
  transcript: Transcript | null;
  segments: MediaSegment[];
  markers: MediaMarker[];
  marker_error: string | null;
  on_seek: (seconds: number) => void;
  on_remove_marker: (marker_id: string) => void;
  on_update_marker_tags: (marker_id: string, tags: string[]) => void;
};

const inspector_tabs: { key: InspectorTab; label: string }[] = [
  { key: "transcript", label: "转写" },
  { key: "segments", label: "分析片段" },
  { key: "markers", label: "标记" },
];

export function Inspector({
  asset_id,
  transcript,
  segments,
  markers,
  marker_error,
  on_seek,
  on_remove_marker,
  on_update_marker_tags,
}: InspectorProps) {
  const [active_tab, set_active_tab] = useState<InspectorTab>("segments");

  return (
    <aside className="inspector" aria-label="视频检查器">
      <div className="inspector_tabs" role="tablist" aria-label="分析信息">
        {inspector_tabs.map((tab) => (
          <button
            key={tab.key}
            className={active_tab === tab.key ? "inspector_tab active" : "inspector_tab"}
            type="button"
            role="tab"
            aria-selected={active_tab === tab.key}
            onClick={() => set_active_tab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="inspector_content">
        {active_tab === "transcript" ? (
          <TranscriptList transcript={transcript} on_seek={on_seek} />
        ) : null}
        {active_tab === "segments" ? (
          <SegmentList asset_id={asset_id} segments={segments} on_seek={on_seek} />
        ) : null}
        {active_tab === "markers" ? (
          <MarkerList
            markers={markers}
            marker_error={marker_error}
            on_seek={on_seek}
            on_remove_marker={on_remove_marker}
            on_update_marker_tags={on_update_marker_tags}
          />
        ) : null}
      </div>
    </aside>
  );
}

function TranscriptList({
  transcript,
  on_seek,
}: {
  transcript: Transcript | null;
  on_seek: (seconds: number) => void;
}) {
  if (!transcript || transcript.segments.length === 0) {
    return <EmptyInspectorState>完成分析后将在此显示可回跳的完整转写。</EmptyInspectorState>;
  }
  return (
    <ol className="transcript_list">
      {transcript.segments.map((segment) => (
        <li key={`${segment.start_seconds}-${segment.end_seconds}`}>
          <button type="button" onClick={() => on_seek(segment.start_seconds)}>
            <time>{format_time(segment.start_seconds)}</time>
            <span>{segment.text}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}

function SegmentList({
  asset_id,
  segments,
  on_seek,
}: {
  asset_id: string;
  segments: MediaSegment[];
  on_seek: (seconds: number) => void;
}) {
  if (segments.length === 0) {
    return <EmptyInspectorState>尚未生成重点片段。开始分析后将在这里展示关键帧与画面描述。</EmptyInspectorState>;
  }
  return (
    <ol className="inspector_segment_list">
      {segments.map((segment) => (
        <li key={segment.segment_id}>
          <button
            type="button"
            onClick={() => on_seek(segment.start_seconds)}
            aria-label={`${format_time(segment.start_seconds)} ${segment.visual_description ?? "分析片段"}`}
          >
            {segment.key_frame_paths[0] ? (
              <img
                src={media_url(`/api/media/assets/${encodeURIComponent(asset_id)}/frames/${segment.key_frame_paths[0]}`)}
                alt=""
                loading="lazy"
              />
            ) : null}
            <span>
              <time>{format_time(segment.start_seconds)} – {format_time(segment.end_seconds)}</time>
              {segment.visual_description ? <strong>{segment.visual_description}</strong> : null}
              {segment.transcript_text ? <small>{segment.transcript_text}</small> : null}
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}

function MarkerList({
  markers,
  marker_error,
  on_seek,
  on_remove_marker,
  on_update_marker_tags,
}: {
  markers: MediaMarker[];
  marker_error: string | null;
  on_seek: (seconds: number) => void;
  on_remove_marker: (marker_id: string) => void;
  on_update_marker_tags: (marker_id: string, tags: string[]) => void;
}) {
  if (markers.length === 0) {
    return <EmptyInspectorState>播放中可从视频区添加时间点标记，标记与标签会保存到媒体库。</EmptyInspectorState>;
  }
  return (
    <>
      {marker_error ? <p className="inspector_error" role="alert">{marker_error}</p> : null}
      <ol className="marker_list">
        {markers.map((marker) => (
          <li key={marker.marker_id}>
            <div className="marker_heading">
              <button type="button" onClick={() => on_seek(marker.time_seconds)}>
                {format_time(marker.time_seconds)}
              </button>
              <button
                type="button"
                onClick={() => on_remove_marker(marker.marker_id)}
                aria-label={`删除 ${format_time(marker.time_seconds)} 标记`}
              >
                删除
              </button>
            </div>
            <div className="marker_tags">
              {marker.tags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => on_update_marker_tags(
                    marker.marker_id,
                    marker.tags.filter((current_tag) => current_tag !== tag),
                  )}
                  title="删除标签"
                >
                  {tag} ×
                </button>
              ))}
              <MarkerTagForm
                marker={marker}
                on_update_marker_tags={on_update_marker_tags}
              />
            </div>
          </li>
        ))}
      </ol>
    </>
  );
}

function MarkerTagForm({
  marker,
  on_update_marker_tags,
}: {
  marker: MediaMarker;
  on_update_marker_tags: (marker_id: string, tags: string[]) => void;
}) {
  function submit_tag(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const value = new FormData(form).get("tag");
    if (typeof value !== "string" || !value.trim()) return;
    on_update_marker_tags(marker.marker_id, [...marker.tags, value]);
    form.reset();
  }

  return (
    <form className="marker_tag_form" onSubmit={submit_tag}>
      <input name="tag" aria-label="添加标签" maxLength={40} placeholder="标签" />
      <button type="submit">添加</button>
    </form>
  );
}

function EmptyInspectorState({ children }: { children: string }) {
  return <p className="inspector_empty">{children}</p>;
}
