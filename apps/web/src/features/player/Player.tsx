import {
  MediaPlayer,
  MediaProvider,
  useMediaPlayer,
  useMediaRemote,
  useMediaStore,
} from "@vidstack/react";
import "@vidstack/react/player/styles/base.css";
import {
  PlyrLayout,
  plyrLayoutIcons,
  type PlyrLayoutTranslations,
} from "@vidstack/react/player/layouts/plyr";
import "@vidstack/react/player/styles/plyr/theme.css";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

import type { AgentEvidenceRange, TranscriptSegment } from "../../shared/types";
import "./player.css";

const SEEK_CONFIRMATION_TOLERANCE_SECONDS = 0.5;
const SEEK_CONFIRMATION_TIMEOUT_MILLISECONDS = 1_500;
const SCRUB_PREVIEW_SEEK_TOLERANCE_SECONDS = 1 / 120;
const PLAYER_TRANSLATIONS = {
  AirPlay: "隔空播放",
  Captions: "字幕",
  "Current time": "当前时间",
  "Disable captions": "关闭字幕",
  "Enable captions": "开启字幕",
  "Enter Fullscreen": "进入全屏",
  "Enter PiP": "进入画中画",
  "Exit Fullscreen": "退出全屏",
  "Exit PiP": "退出画中画",
  Mute: "静音",
  Normal: "正常",
  Pause: "暂停",
  Play: "播放",
  Seek: "播放进度",
  Settings: "设置",
  Speed: "速度",
  Unmute: "取消静音",
  Volume: "音量",
} satisfies Partial<PlyrLayoutTranslations>;

export type PlayerHandle = {
  seek_to: (seconds: number) => void;
  preview_to: (seconds: number) => void;
  current_time: () => number;
  toggle_playback: () => void;
  set_playback_rate: (rate: number) => void;
};

type TimelineMarker = {
  start_seconds: number;
  label: string;
};

type Storyboard = {
  url: string;
  tile_width: number;
  tile_height: number;
  tiles: { start_time: number; x: number; y: number }[];
};

type PlayerProps = {
  src: string;
  scrub_src?: string | null;
  markers?: TimelineMarker[];
  subtitles?: TranscriptSegment[];
  evidence_range?: AgentEvidenceRange | null;
  thumbnails?: Storyboard | null;
  on_time_change?: (seconds: number) => void;
  on_pause_change?: (paused: boolean) => void;
  on_playback_rate_change?: (rate: number) => void;
};

export const Player = forwardRef<PlayerHandle, PlayerProps>(function Player(
  {
    src,
    scrub_src = null,
    markers = [],
    subtitles = [],
    evidence_range = null,
    thumbnails = null,
    on_time_change,
    on_pause_change,
    on_playback_rate_change,
  },
  ref,
) {
  // 用 ref 保存 player/remote 方法，避免 useImperativeHandle 随 player 变化重建
  const seek_fn_ref = useRef<((seconds: number) => void) | null>(null);
  const toggle_playback_fn_ref = useRef<(() => void) | null>(null);
  const set_playback_rate_fn_ref = useRef<((rate: number) => void) | null>(
    null,
  );
  const current_time_fn_ref = useRef<(() => number) | null>(null);
  const current_time_value_ref = useRef(0);
  const scrub_video_ref = useRef<HTMLVideoElement>(null);
  const scrub_time_ref = useRef<number | null>(null);
  const scrub_frame_ref = useRef<number | null>(null);
  const scrub_available_ref = useRef(Boolean(scrub_src));
  const preview_active_ref = useRef(false);
  const preview_commit_pending_ref = useRef(false);
  const preview_hide_timeout_ref = useRef<number | null>(null);
  const [is_previewing, set_is_previewing] = useState(false);
  const [is_scrub_ready, set_is_scrub_ready] = useState(false);
  const pending_seek_ref = useRef<{
    time_seconds: number;
    requested_at: number;
  } | null>(null);
  const on_time_change_ref = useRef(on_time_change);

  useEffect(() => {
    on_time_change_ref.current = on_time_change;
  }, [on_time_change]);

  const finish_preview = useCallback(() => {
    preview_commit_pending_ref.current = false;
    preview_active_ref.current = false;
    set_is_previewing(false);
    if (preview_hide_timeout_ref.current !== null) {
      window.clearTimeout(preview_hide_timeout_ref.current);
      preview_hide_timeout_ref.current = null;
    }
  }, []);

  const apply_scrub_time = useCallback(() => {
    scrub_frame_ref.current = null;
    const requested_time = scrub_time_ref.current;
    if (requested_time === null) return;
    const scrub_video = scrub_video_ref.current;
    if (!scrub_available_ref.current) {
      seek_fn_ref.current?.(requested_time);
      return;
    }
    if (
      !scrub_video ||
      scrub_video.readyState < HTMLMediaElement.HAVE_METADATA
    ) {
      return;
    }
    const bounded_time = Number.isFinite(scrub_video.duration)
      ? Math.min(requested_time, scrub_video.duration)
      : requested_time;
    if (
      Math.abs(scrub_video.currentTime - bounded_time) >=
      SCRUB_PREVIEW_SEEK_TOLERANCE_SECONDS
    ) {
      scrub_video.currentTime = bounded_time;
      return;
    }
    if (preview_active_ref.current) set_is_scrub_ready(true);
  }, []);

  const schedule_scrub_time = useCallback(
    (seconds: number) => {
      const bounded_time = Math.max(0, seconds);
      current_time_value_ref.current = bounded_time;
      scrub_time_ref.current = bounded_time;
      preview_commit_pending_ref.current = false;
      preview_active_ref.current = true;
      set_is_previewing(true);
      on_time_change_ref.current?.(bounded_time);
      if (preview_hide_timeout_ref.current !== null) {
        window.clearTimeout(preview_hide_timeout_ref.current);
        preview_hide_timeout_ref.current = null;
      }
      if (scrub_frame_ref.current === null) {
        scrub_frame_ref.current =
          window.requestAnimationFrame(apply_scrub_time);
      }
    },
    [apply_scrub_time],
  );

  useImperativeHandle(
    ref,
    () => ({
      seek_to: (seconds: number) => {
        const bounded_time = Math.max(0, seconds);
        current_time_value_ref.current = bounded_time;
        pending_seek_ref.current = {
          time_seconds: bounded_time,
          requested_at: performance.now(),
        };
        on_time_change_ref.current?.(bounded_time);
        seek_fn_ref.current?.(bounded_time);
        if (preview_active_ref.current) {
          preview_commit_pending_ref.current = true;
          preview_hide_timeout_ref.current = window.setTimeout(
            finish_preview,
            SEEK_CONFIRMATION_TIMEOUT_MILLISECONDS,
          );
        }
      },
      preview_to: schedule_scrub_time,
      current_time: () => {
        const pending_seek = pending_seek_ref.current;
        const seek_is_pending =
          pending_seek !== null &&
          performance.now() - pending_seek.requested_at <
            SEEK_CONFIRMATION_TIMEOUT_MILLISECONDS;
        if (preview_active_ref.current || seek_is_pending) {
          return current_time_value_ref.current;
        }
        return (
          current_time_fn_ref.current?.() ?? current_time_value_ref.current
        );
      },
      toggle_playback: () => toggle_playback_fn_ref.current?.(),
      set_playback_rate: (rate: number) =>
        set_playback_rate_fn_ref.current?.(rate),
    }),
    [finish_preview, schedule_scrub_time],
  );

  useEffect(
    () => () => {
      if (scrub_frame_ref.current !== null) {
        window.cancelAnimationFrame(scrub_frame_ref.current);
      }
      if (preview_hide_timeout_ref.current !== null) {
        window.clearTimeout(preview_hide_timeout_ref.current);
      }
    },
    [],
  );

  const on_player_ready = useCallback((instance: PlayerRef | null) => {
    current_time_fn_ref.current = instance ? instance.current_time : null;
    seek_fn_ref.current = instance ? (s) => instance.seek(s) : null;
    toggle_playback_fn_ref.current = instance
      ? () => instance.toggle_playback()
      : null;
    set_playback_rate_fn_ref.current = instance
      ? (rate) => instance.set_playback_rate(rate)
      : null;
  }, []);

  const plyr_markers = markers.map((marker) => ({
    time: marker.start_seconds,
    label: marker.label,
  }));

  const plyr_thumbnails = thumbnails
    ? {
        url: new URL(thumbnails.url, window.location.origin).href,
        tileWidth: thumbnails.tile_width,
        tileHeight: thumbnails.tile_height,
        tiles: thumbnails.tiles.map((tile) => ({
          startTime: tile.start_time,
          x: tile.x,
          y: tile.y,
        })),
      }
    : null;

  return (
    <div className="openvideo_player_shell">
      <MediaPlayer
        className="openvideo_player"
        src={{ src, type: "video/mp4" }}
        ariaLabel="OpenVideo 播放器"
        onSeeked={() => {
          if (preview_commit_pending_ref.current) finish_preview();
        }}
      >
        <MediaProvider />
        <SubtitleOverlay segments={subtitles} evidence_range={evidence_range} />
        <PlyrLayout
          icons={plyrLayoutIcons}
          translations={PLAYER_TRANSLATIONS}
          markers={plyr_markers}
          thumbnails={plyr_thumbnails}
          clickToPlay
        />
        <PlayerStateBridge
          on_player_ready={on_player_ready}
          on_time_change={(seconds) => {
            const pending_seek = pending_seek_ref.current;
            const is_waiting_for_seek =
              pending_seek !== null &&
              performance.now() - pending_seek.requested_at <
                SEEK_CONFIRMATION_TIMEOUT_MILLISECONDS;
            if (
              is_waiting_for_seek &&
              Math.abs(seconds - pending_seek.time_seconds) >
                SEEK_CONFIRMATION_TOLERANCE_SECONDS
            ) {
              return;
            }
            pending_seek_ref.current = null;
            current_time_value_ref.current = seconds;
            on_time_change_ref.current?.(seconds);
          }}
          on_pause_change={on_pause_change}
          on_playback_rate_change={on_playback_rate_change}
        />
      </MediaPlayer>
      {scrub_src ? (
        <video
          ref={scrub_video_ref}
          className="openvideo_scrub_preview"
          src={scrub_src}
          preload="auto"
          muted
          playsInline
          tabIndex={-1}
          data-active={(is_previewing && is_scrub_ready) || undefined}
          aria-hidden="true"
          onLoadedMetadata={() => {
            scrub_available_ref.current = true;
            if (scrub_time_ref.current !== null) apply_scrub_time();
          }}
          onSeeked={() => {
            if (preview_active_ref.current) set_is_scrub_ready(true);
          }}
          onError={() => {
            scrub_available_ref.current = false;
            set_is_scrub_ready(false);
            if (scrub_time_ref.current !== null) apply_scrub_time();
          }}
        />
      ) : null}
    </div>
  );
});

function SubtitleOverlay({
  segments,
  evidence_range,
}: {
  segments: TranscriptSegment[];
  evidence_range: AgentEvidenceRange | null;
}) {
  const { currentTime } = useMediaStore();
  const active_segment = active_subtitle_segment(segments, currentTime);
  if (!active_segment) return null;
  const text = active_segment.text.trim();
  if (!text) return null;
  const evidence_highlight =
    evidence_range !== null &&
    subtitle_is_evidence(active_segment, evidence_range);

  return (
    <div
      className="openvideo_subtitle"
      data-evidence-highlight={evidence_highlight || undefined}
      aria-label={evidence_highlight ? "视频字幕，答案证据" : "视频字幕"}
    >
      {text}
    </div>
  );
}

export function active_subtitle_text(
  segments: TranscriptSegment[],
  current_time: number,
): string | null {
  return active_subtitle_segment(segments, current_time)?.text.trim() || null;
}

export function active_subtitle_segment(
  segments: TranscriptSegment[],
  current_time: number,
): TranscriptSegment | null {
  return (
    segments.find(
      (segment) =>
        segment.start_seconds <= current_time &&
        current_time < segment.end_seconds,
    ) ?? null
  );
}

export function subtitle_is_evidence(
  segment: TranscriptSegment,
  evidence_range: AgentEvidenceRange,
) {
  return ranges_overlap(
    segment.start_seconds,
    segment.end_seconds,
    evidence_range.start_seconds,
    evidence_range.end_seconds,
  );
}

function ranges_overlap(
  left_start: number,
  left_end: number,
  right_start: number,
  right_end: number,
) {
  return left_start <= right_end && right_start <= left_end;
}

type PlayerRef = {
  current_time: () => number;
  seek: (seconds: number) => void;
  toggle_playback: () => void;
  set_playback_rate: (rate: number) => void;
};

function PlayerStateBridge({
  on_player_ready,
  on_time_change,
  on_pause_change,
  on_playback_rate_change,
}: {
  on_player_ready: (instance: PlayerRef | null) => void;
  on_time_change?: (seconds: number) => void;
  on_pause_change?: (paused: boolean) => void;
  on_playback_rate_change?: (rate: number) => void;
}) {
  const player = useMediaPlayer();
  const remote = useMediaRemote();
  const store = useMediaStore();
  const last_reported_ref = useRef(-1);

  useEffect(() => {
    if (!player) return;
    // 直接读取 remote/player 的当前值，不把它们放入依赖数组，
    // 避免 remote 对象引用变化时产生短暂的 null 窗口。
    on_player_ready({
      current_time: () => player.currentTime,
      seek: (seconds: number) => remote.seek(seconds),
      toggle_playback: () => {
        if (player.paused) void remote.play();
        else void remote.pause();
      },
      set_playback_rate: (rate: number) => remote.changePlaybackRate(rate),
    });
    return () => on_player_ready(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player]);

  useEffect(() => {
    if (!on_time_change) return;
    if (Math.abs(store.currentTime - last_reported_ref.current) >= 0.25) {
      last_reported_ref.current = store.currentTime;
      on_time_change(store.currentTime);
    }
  }, [store.currentTime, on_time_change]);

  useEffect(() => {
    on_pause_change?.(store.paused);
  }, [store.paused, on_pause_change]);

  useEffect(() => {
    on_playback_rate_change?.(store.playbackRate);
  }, [store.playbackRate, on_playback_rate_change]);

  return null;
}
