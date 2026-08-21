import {
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  useState,
} from "react";

import { format_time } from "../../shared/format";
import type { MediaMarker, MediaSegment, Transcript } from "../../shared/types";


const RULER_INTERVAL_COUNT = 8;
const MINIMUM_DURATION_SECONDS = 1;
const MINIMUM_EVENT_WIDTH_PERCENT = 0.8;
const MARKER_EDITOR_FLIP_PERCENT = 50;

type AnalysisTimelineProps = {
  duration_seconds: number | null;
  current_time: number;
  transcript: Transcript | null;
  segments: MediaSegment[];
  markers: MediaMarker[];
  marker_error: string | null;
  on_seek: (seconds: number) => void;
  on_add_marker: (seconds: number) => Promise<void>;
  on_remove_marker: (marker_id: string) => Promise<void>;
  on_update_marker_tags: (marker_id: string, tags: string[]) => Promise<void>;
  on_update_transcript: (segment_index: number, text: string) => Promise<void>;
};

export function AnalysisTimeline({
  duration_seconds,
  current_time,
  transcript,
  segments,
  markers,
  marker_error,
  on_seek,
  on_add_marker,
  on_remove_marker,
  on_update_marker_tags,
  on_update_transcript,
}: AnalysisTimelineProps) {
  const [editing_transcript_index, set_editing_transcript_index] = useState<number | null>(null);
  const [transcript_draft, set_transcript_draft] = useState("");
  const [is_saving_transcript, set_is_saving_transcript] = useState(false);
  const [transcript_error, set_transcript_error] = useState<string | null>(null);
  const [editing_marker_id, set_editing_marker_id] = useState<string | null>(null);
  const [marker_tags_draft, set_marker_tags_draft] = useState("");
  const transcript_segments = transcript?.segments ?? [];
  const duration = timeline_duration(
    duration_seconds,
    current_time,
    transcript_segments,
    segments,
    markers,
  );
  const bounded_time = Math.min(Math.max(current_time, 0), duration);
  const playhead_percent = percentage(bounded_time, duration);
  const ruler_ticks = Array.from({ length: RULER_INTERVAL_COUNT + 1 }, (_, index) => (
    duration * index / RULER_INTERVAL_COUNT
  ));

  return (
    <section className="analysis_timeline" aria-label="剪辑时间轴">
      <header className="analysis_timeline_header">
        <div>
          <strong>时间轴</strong>
          <span>{transcript_segments.length} 条转写 · {segments.length} 个事件 · {markers.length} 个标记</span>
        </div>
        <button
          type="button"
          className="timeline_add_marker"
          onClick={() => void on_add_marker(bounded_time)}
          disabled={bounded_time <= 0}
        >
          + 标记 @ {format_time(bounded_time)}
        </button>
        <output aria-label="当前播放时间">
          {format_time(bounded_time)} / {format_time(duration)}
        </output>
      </header>
      <div className="timeline_editor">
        <div className="timeline_track_labels" aria-hidden="true">
          <span>时间</span>
          <span>标记</span>
          <span>转写</span>
          <span>分析事件</span>
        </div>
        <div
          className="timeline_tracks"
          role="slider"
          tabIndex={0}
          aria-label="时间轴拖动区域"
          aria-valuemin={0}
          aria-valuemax={duration}
          aria-valuenow={bounded_time}
          onPointerDown={(event) => start_timeline_scrub(event, duration)}
          onPointerMove={(event) => continue_timeline_scrub(event, duration)}
          onPointerUp={(event) => finish_timeline_scrub(event)}
          onPointerCancel={(event) => finish_timeline_scrub(event)}
          onKeyDown={(event) => scrub_with_keyboard(event, bounded_time, duration)}
        >
          <div className="timeline_ruler" aria-hidden="true">
            {ruler_ticks.map((tick) => (
              <span key={tick} style={{ left: `${percentage(tick, duration)}%` }}>
                {format_time(tick)}
              </span>
            ))}
          </div>
          <div
            className="timeline_marker_track"
            onDoubleClick={(event) => add_marker_from_track(event, duration)}
            title="双击轨道添加标记"
          >
            {markers.map((marker) => (
              <button
                key={marker.marker_id}
                type="button"
                className="timeline_marker"
                style={{ left: `${percentage(marker.time_seconds, duration)}%` }}
                onClick={() => {
                  on_seek(marker.time_seconds);
                  set_editing_marker_id(marker.marker_id);
                  set_marker_tags_draft(marker.tags.join(", "));
                }}
                aria-label={`跳转到标记 ${format_time(marker.time_seconds)}`}
                title={`${format_time(marker.time_seconds)} ${marker.tags.join(" · ") || "未添加标签"}`}
              />
            ))}
            {markers.map((marker) => {
              if (editing_marker_id !== marker.marker_id) return null;
              const marker_percent = percentage(marker.time_seconds, duration);
              const editor_position = marker_percent > MARKER_EDITOR_FLIP_PERCENT
                ? { right: `${100 - marker_percent}%` }
                : { left: `${marker_percent}%` };
              return (
                <form
                  key={`editor-${marker.marker_id}`}
                  className="timeline_marker_editor"
                  style={editor_position}
                  onSubmit={(event) => void save_marker_tags(event, marker.marker_id)}
                >
                  <input
                    autoFocus
                    aria-label={`编辑 ${format_time(marker.time_seconds)} 标记标签`}
                    value={marker_tags_draft}
                    placeholder="重点, 公式"
                    onChange={(event) => set_marker_tags_draft(event.currentTarget.value)}
                  />
                  <button type="submit">保存</button>
                  <button type="button" onClick={() => void delete_marker(marker.marker_id)}>删除</button>
                  <button type="button" onClick={() => set_editing_marker_id(null)}>关闭</button>
                </form>
              );
            })}
            {marker_error ? <span className="timeline_marker_error" role="alert">{marker_error}</span> : null}
          </div>
          <div className="timeline_transcript_track">
            {transcript_segments.length === 0 ? (
              <span className="timeline_track_empty">完成转录后，文字会显示在这条轨道中</span>
            ) : transcript_segments.map((segment, segment_index) => {
              const placement = clip_placement(segment, duration);
              const is_editing = editing_transcript_index === segment_index;
              return (
                <div
                  key={`${segment.start_seconds}-${segment.end_seconds}-${segment_index}`}
                  className={is_editing ? "timeline_transcript_clip editing" : "timeline_transcript_clip"}
                  style={{ left: `${placement.left}%`, width: `${placement.width}%` }}
                >
                  {is_editing ? (
                    <form
                      onSubmit={(event) => void save_transcript(event, segment_index)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") cancel_transcript_edit();
                      }}
                    >
                      <input
                        autoFocus
                        aria-label={`编辑 ${format_time(segment.start_seconds)} 转写`}
                        value={transcript_draft}
                        maxLength={10_000}
                        onChange={(event) => set_transcript_draft(event.currentTarget.value)}
                        disabled={is_saving_transcript}
                      />
                      <button type="submit" disabled={is_saving_transcript || !transcript_draft.trim()}>
                        {is_saving_transcript ? "保存中" : "保存"}
                      </button>
                      <button type="button" onClick={cancel_transcript_edit} disabled={is_saving_transcript}>
                        取消
                      </button>
                    </form>
                  ) : (
                    <button
                      type="button"
                      onClick={() => on_seek(segment.start_seconds)}
                      onDoubleClick={() => start_transcript_edit(segment_index, segment.text)}
                      aria-label={`${format_time(segment.start_seconds)} ${segment.text}`}
                      title="单击定位，双击修改转写"
                    >
                      <time>{format_time(segment.start_seconds)}</time>
                      <span>{segment.text}</span>
                    </button>
                  )}
                </div>
              );
            })}
            {transcript_error ? <span className="timeline_transcript_error" role="alert">{transcript_error}</span> : null}
          </div>
          <div className="timeline_event_track">
            {segments.length === 0 ? (
              <span className="timeline_track_empty">分析后，事件片段会显示在这条轨道上</span>
            ) : segments.map((segment) => {
              const placement = clip_placement(segment, duration);
              return (
                <button
                  key={segment.segment_id}
                  type="button"
                  className="timeline_event_clip"
                  style={{ left: `${placement.left}%`, width: `${placement.width}%` }}
                  onClick={() => on_seek(segment.start_seconds)}
                  aria-label={`${format_time(segment.start_seconds)} ${segment.title}`}
                  title={`${format_time(segment.start_seconds)}–${format_time(segment.end_seconds)} ${segment.title}`}
                >
                  <strong>{segment.title}</strong>
                  <small>{segment.tags.join(" · ")}</small>
                </button>
              );
            })}
          </div>
          <div className="timeline_playhead" style={{ left: `${playhead_percent}%` }} aria-hidden="true">
            <span />
          </div>
        </div>
      </div>
    </section>
  );

  function start_transcript_edit(segment_index: number, text: string) {
    set_editing_transcript_index(segment_index);
    set_transcript_draft(text);
    set_transcript_error(null);
  }

  function cancel_transcript_edit() {
    set_editing_transcript_index(null);
    set_transcript_draft("");
    set_transcript_error(null);
  }

  async function save_transcript(event: FormEvent<HTMLFormElement>, segment_index: number) {
    event.preventDefault();
    const text = transcript_draft.trim();
    if (!text) return;
    set_is_saving_transcript(true);
    set_transcript_error(null);
    try {
      await on_update_transcript(segment_index, text);
      set_editing_transcript_index(null);
      set_transcript_draft("");
    } catch {
      set_transcript_error("转写保存失败，请稍后重试");
    } finally {
      set_is_saving_transcript(false);
    }
  }

  function add_marker_from_track(event: MouseEvent<HTMLDivElement>, track_duration: number) {
    if (event.target !== event.currentTarget) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const position = (event.clientX - bounds.left) / bounds.width;
    void on_add_marker(Math.min(Math.max(position * track_duration, 0), track_duration));
  }

  async function save_marker_tags(event: FormEvent<HTMLFormElement>, marker_id: string) {
    event.preventDefault();
    const tags = marker_tags_draft.split(",").map((tag) => tag.trim()).filter(Boolean);
    await on_update_marker_tags(marker_id, tags);
    set_editing_marker_id(null);
  }

  async function delete_marker(marker_id: string) {
    await on_remove_marker(marker_id);
    set_editing_marker_id(null);
  }

  function start_timeline_scrub(event: PointerEvent<HTMLDivElement>, track_duration: number) {
    if (is_interactive_target(event.target)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    seek_from_pointer(event, track_duration);
  }

  function continue_timeline_scrub(event: PointerEvent<HTMLDivElement>, track_duration: number) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    seek_from_pointer(event, track_duration);
  }

  function finish_timeline_scrub(event: PointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function seek_from_pointer(event: PointerEvent<HTMLDivElement>, track_duration: number) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const position = (event.clientX - bounds.left) / bounds.width;
    on_seek(Math.min(Math.max(position * track_duration, 0), track_duration));
  }

  function scrub_with_keyboard(
    event: KeyboardEvent<HTMLDivElement>,
    time_seconds: number,
    track_duration: number,
  ) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const direction = event.key === "ArrowLeft" ? -1 : 1;
    on_seek(Math.min(Math.max(time_seconds + direction, 0), track_duration));
  }
}

function is_interactive_target(target: EventTarget): boolean {
  return target instanceof Element && target.closest("button, input, form") !== null;
}

function timeline_duration(
  duration_seconds: number | null,
  current_time: number,
  transcript_segments: Transcript["segments"],
  segments: MediaSegment[],
  markers: MediaMarker[],
): number {
  const latest_segment_time = Math.max(0, ...segments.map((segment) => segment.end_seconds));
  const latest_transcript_time = Math.max(0, ...transcript_segments.map((segment) => segment.end_seconds));
  const latest_marker_time = Math.max(0, ...markers.map((marker) => marker.time_seconds));
  return Math.max(
    duration_seconds ?? 0,
    current_time,
    latest_transcript_time,
    latest_segment_time,
    latest_marker_time,
    MINIMUM_DURATION_SECONDS,
  );
}

function percentage(seconds: number, duration: number): number {
  return Math.min(Math.max(seconds / duration * 100, 0), 100);
}

function clip_placement(segment: { start_seconds: number; end_seconds: number }, duration: number) {
  const left = percentage(segment.start_seconds, duration);
  const natural_width = percentage(segment.end_seconds - segment.start_seconds, duration);
  const width = Math.min(Math.max(natural_width, MINIMUM_EVENT_WIDTH_PERCENT), 100 - left);
  return { left, width };
}
