import { MediaPlayer, MediaProvider, useMediaStore } from "@vidstack/react";
import "@vidstack/react/player/styles/base.css";
import {
  PlyrLayout,
  plyrLayoutIcons,
  type PlyrControl,
  type PlyrLayoutTranslations,
} from "@vidstack/react/player/layouts/plyr";
import "@vidstack/react/player/styles/plyr/theme.css";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";

import type { AgentEvidenceRange, TranscriptSegment } from "@/shared/types";
import {
  PlayerStateBridge,
  type PlayerController,
} from "./player_state_bridge";
import "./player.css";
import {
  active_subtitle_segment,
  subtitle_is_evidence,
} from "./subtitle_rules";
import { use_scrub_preview } from "./use_scrub_preview";

const SEEK_CONFIRMATION_TOLERANCE_SECONDS = 0.5;
const SEEK_CONFIRMATION_TIMEOUT_MILLISECONDS = 1_500;
const PLAYER_CONTROLS: PlyrControl[] = [
  "play",
  "progress",
  "current-time",
  "mute+volume",
  "captions",
  "settings",
  "pip",
  "airplay",
  "fullscreen",
];
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
  const pending_seek_ref = useRef<{
    time_seconds: number;
    requested_at: number;
  } | null>(null);
  const on_time_change_ref = useRef(on_time_change);

  useEffect(() => {
    on_time_change_ref.current = on_time_change;
  }, [on_time_change]);

  const {
    video_ref: scrub_video_ref,
    is_visible: is_scrub_preview_visible,
    preview_time,
    fallback_seek_request,
    preview_to: request_scrub_preview,
    begin_seek_commit,
    confirm_seek,
    is_active: is_preview_active,
    on_loaded_metadata: on_scrub_loaded_metadata,
    on_seeked: on_scrub_seeked,
    on_error: on_scrub_error,
  } = use_scrub_preview({
    src: scrub_src,
    commit_timeout_milliseconds: SEEK_CONFIRMATION_TIMEOUT_MILLISECONDS,
  });

  useEffect(() => {
    if (fallback_seek_request) {
      seek_fn_ref.current?.(fallback_seek_request.seconds);
    }
  }, [fallback_seek_request]);

  const preview_to = useCallback(
    (seconds: number) => {
      const bounded_time = request_scrub_preview(seconds);
      current_time_value_ref.current = bounded_time;
      on_time_change_ref.current?.(bounded_time);
    },
    [request_scrub_preview],
  );

  const prepare_seek_commit = useCallback(
    (seconds: number) => {
      const bounded_time = Math.max(0, seconds);
      current_time_value_ref.current = bounded_time;
      pending_seek_ref.current = {
        time_seconds: bounded_time,
        requested_at: performance.now(),
      };
      on_time_change_ref.current?.(bounded_time);
      begin_seek_commit();
      return bounded_time;
    },
    [begin_seek_commit],
  );

  useImperativeHandle(
    ref,
    () => ({
      seek_to: (seconds: number) => {
        const bounded_time = prepare_seek_commit(seconds);
        seek_fn_ref.current?.(bounded_time);
      },
      preview_to,
      current_time: () => {
        const pending_seek = pending_seek_ref.current;
        const seek_is_pending =
          pending_seek !== null &&
          performance.now() - pending_seek.requested_at <
            SEEK_CONFIRMATION_TIMEOUT_MILLISECONDS;
        if (is_preview_active() || seek_is_pending) {
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
    [is_preview_active, prepare_seek_commit, preview_to],
  );

  const on_player_ready = useCallback((instance: PlayerController | null) => {
    current_time_fn_ref.current = instance ? instance.current_time : null;
    seek_fn_ref.current = instance ? (s) => instance.seek(s) : null;
    toggle_playback_fn_ref.current = instance
      ? () => instance.toggle_playback()
      : null;
    set_playback_rate_fn_ref.current = instance
      ? (rate) => instance.set_playback_rate(rate)
      : null;
  }, []);

  const on_player_time_change = useCallback((seconds: number) => {
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
        onMediaSeekingRequest={preview_to}
        onMediaSeekRequest={prepare_seek_commit}
        onSeeked={confirm_seek}
      >
        <MediaProvider />
        <SubtitleOverlay
          segments={subtitles}
          evidence_range={evidence_range}
          preview_time={preview_time}
        />
        <PlyrLayout
          icons={plyrLayoutIcons}
          translations={PLAYER_TRANSLATIONS}
          markers={plyr_markers}
          thumbnails={plyr_thumbnails}
          controls={PLAYER_CONTROLS}
          invertTime={false}
        />
        <PlayerStateBridge
          on_player_ready={on_player_ready}
          on_time_change={on_player_time_change}
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
          data-active={is_scrub_preview_visible || undefined}
          aria-hidden="true"
          onLoadedMetadata={on_scrub_loaded_metadata}
          onSeeked={on_scrub_seeked}
          onError={on_scrub_error}
        />
      ) : null}
    </div>
  );
});

function SubtitleOverlay({
  segments,
  evidence_range,
  preview_time,
}: {
  segments: TranscriptSegment[];
  evidence_range: AgentEvidenceRange | null;
  preview_time: number | null;
}) {
  const { currentTime } = useMediaStore();
  const active_segment = active_subtitle_segment(
    segments,
    preview_time ?? currentTime,
  );
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
