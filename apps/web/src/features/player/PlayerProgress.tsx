import {
  TimeSlider,
  Track,
  useMediaRemote,
  useMediaState,
  useSliderState,
} from "@vidstack/react";
import { usePlyrLayoutContext } from "@vidstack/react/player/layouts/plyr";
import { useMemo } from "react";

import type { MediaSegment } from "@/shared/types";

// 解码器已合并预览任务，交互时不再叠加播放器默认的节流。
const PROGRESS_SEEK_THROTTLE_MILLISECONDS = 0;
const PERCENT_SCALE = 100;

export function PlayerProgress({ chapters }: { chapters: MediaSegment[] }) {
  const {
    markers,
    seekTime: seek_time,
    previewTime: preview_time,
  } = usePlyrLayoutContext();
  const duration = useMediaState("duration");
  const current_time = useMediaState("currentTime");
  const remote = useMediaRemote();
  const visible_chapters = useMemo(() => {
    if (!Number.isFinite(duration) || duration <= 0) return [];
    return chapters
      .filter(
        (chapter) =>
          Number.isFinite(chapter.start_seconds) &&
          chapter.start_seconds >= 0 &&
          chapter.start_seconds < duration,
      )
      .sort((left, right) => left.start_seconds - right.start_seconds)
      .filter(
        (chapter, index, sorted) =>
          index === 0 ||
          chapter.start_seconds > sorted[index - 1].start_seconds,
      )
      .map((chapter, index, sorted) => ({
        ...chapter,
        start_seconds: index === 0 ? 0 : chapter.start_seconds,
        end_seconds: sorted[index + 1]?.start_seconds ?? duration,
      }));
  }, [chapters, duration]);
  const track_content = useMemo(
    () => ({
      cues: visible_chapters.map((chapter) => ({
        startTime: chapter.start_seconds,
        endTime: chapter.end_seconds,
        text: chapter.title,
      })),
    }),
    [visible_chapters],
  );
  const current_chapter = visible_chapters.find(
    (chapter) =>
      current_time >= chapter.start_seconds &&
      current_time < chapter.end_seconds,
  );

  return (
    <div className="plyr__controls__item plyr__progress__container">
      {visible_chapters.length > 0 ? (
        <Track
          key={JSON.stringify(track_content)}
          kind="chapters"
          type="json"
          content={track_content}
          label="章节"
          default
        />
      ) : null}
      <div className="plyr__progress">
        <TimeSlider.Root
          className="plyr__slider"
          keyStep={seek_time}
          seekingRequestThrottle={PROGRESS_SEEK_THROTTLE_MILLISECONDS}
          pauseWhileDragging={false}
          aria-label="播放进度"
          aria-description={
            current_chapter
              ? `当前章节：${current_chapter.title}。PageUp 上一章，PageDown 下一章`
              : undefined
          }
          data-plyr="seek"
          onMediaSeekingRequest={(time) => preview_time.set(time)}
          onKeyDownCapture={(event) => {
            if (event.key !== "PageUp" && event.key !== "PageDown") return;
            if (!visible_chapters.length) return;
            const chapter =
              event.key === "PageDown"
                ? visible_chapters.find(
                    (item) => item.start_seconds > current_time,
                  )
                : [...visible_chapters]
                    .reverse()
                    .find((item) => item.start_seconds < current_time);
            event.preventDefault();
            event.stopPropagation();
            if (!chapter) return;
            remote.seek(chapter.start_seconds, event.nativeEvent);
          }}
        >
          {visible_chapters.length ? (
            <TimeSlider.Chapters className="openvideo_progress_chapters">
              {(cues, forward_ref) =>
                cues.map((cue) => (
                  <div
                    key={cue.startTime}
                    ref={forward_ref}
                    className="openvideo_progress_chapter"
                    data-chapter-title={cue.text}
                  >
                    <TimeSlider.Track className="openvideo_chapter_track">
                      <TimeSlider.Progress className="openvideo_chapter_buffer" />
                      <TimeSlider.TrackFill className="openvideo_chapter_fill" />
                    </TimeSlider.Track>
                  </div>
                ))
              }
            </TimeSlider.Chapters>
          ) : (
            <>
              <div className="plyr__slider__track" />
              <div className="plyr__slider__buffer" />
            </>
          )}
          <div className="plyr__slider__thumb" />
          <TimeSlider.Preview className="openvideo_chapter_preview">
            <ChapterPreview chapters={visible_chapters} duration={duration} />
            <TimeSlider.Value />
          </TimeSlider.Preview>
          {Number.isFinite(duration) && duration > 0
            ? markers?.map((marker) => (
                <span
                  key={`${marker.time}:${marker.label}`}
                  className="plyr__progress__marker"
                  title={marker.label}
                  style={{
                    left: `${(marker.time / duration) * PERCENT_SCALE}%`,
                  }}
                />
              ))
            : null}
        </TimeSlider.Root>
      </div>
    </div>
  );
}

function ChapterPreview({
  chapters,
  duration,
}: {
  chapters: MediaSegment[];
  duration: number;
}) {
  const pointer_value = useSliderState("pointerValue");
  const value = useSliderState("value");
  const pointing = useSliderState("pointing");
  const seconds =
    ((pointing ? pointer_value : value) / PERCENT_SCALE) * duration;
  const chapter = [...chapters]
    .reverse()
    .find((item) => item.start_seconds <= seconds);
  if (!chapter) return null;
  // 旧产物曾把字幕全文保存为摘要，预览不能继续把它当作生成结果。
  const summary =
    chapter.detailed_summary !== chapter.transcript_text
      ? chapter.detailed_summary
      : null;
  return (
    <>
      <strong className="openvideo_chapter_title">{chapter.title}</strong>
      {summary ? (
        <span className="openvideo_chapter_summary">{summary}</span>
      ) : null}
    </>
  );
}
