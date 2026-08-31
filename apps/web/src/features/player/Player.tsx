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

import type {
  AgentEvidenceRange,
  SubtitleDisplaySettings,
  TranscriptSegment,
} from "@/shared/types";
import {
  PlayerStateBridge,
  type PlayerController,
} from "./player_state_bridge";
import "./player.css";
import {
  active_subtitle_segment,
  subtitle_is_evidence,
} from "./subtitle_rules";
import { DEFAULT_SUBTITLE_DISPLAY_SETTINGS } from "./subtitle_settings";
import { use_seek_preview } from "./use_seek_preview";

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
  markers?: TimelineMarker[];
  subtitles?: TranscriptSegment[];
  subtitle_display?: SubtitleDisplaySettings;
  evidence_range?: AgentEvidenceRange | null;
  thumbnails?: Storyboard | null;
  on_time_change?: (seconds: number) => void;
  on_pause_change?: (paused: boolean) => void;
  on_playback_rate_change?: (rate: number) => void;
};

export const Player = forwardRef<PlayerHandle, PlayerProps>(function Player(
  {
    src,
    markers = [],
    subtitles = [],
    subtitle_display = DEFAULT_SUBTITLE_DISPLAY_SETTINGS,
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
    preview_to: request_seek_preview,
    begin_seek_commit,
    confirm_seek,
    is_active: is_preview_active,
  } = use_seek_preview({
    commit_timeout_milliseconds: SEEK_CONFIRMATION_TIMEOUT_MILLISECONDS,
  });

  const preview_to = useCallback(
    (seconds: number) => {
      const bounded_time = request_seek_preview(seconds);
      current_time_value_ref.current = bounded_time;
    },
    [request_seek_preview],
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

  const on_player_time_change = useCallback(
    (seconds: number) => {
      const pending_seek = pending_seek_ref.current;
      if (pending_seek === null && is_preview_active()) return;
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
    },
    [is_preview_active],
  );

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
        onMediaSeekingRequest={request_seek_preview}
        onMediaSeekRequest={prepare_seek_commit}
        onSeeked={confirm_seek}
      >
        <MediaProvider />
        <SubtitleOverlay
          segments={subtitles}
          settings={subtitle_display}
          evidence_range={evidence_range}
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
    </div>
  );
});

function SubtitleOverlay({
  segments,
  settings,
  evidence_range,
}: {
  segments: TranscriptSegment[];
  settings: SubtitleDisplaySettings;
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
      data-font-size={settings.font_size}
      data-position={settings.position}
      data-background={settings.background}
      data-evidence-highlight={evidence_highlight || undefined}
      aria-label={evidence_highlight ? "视频字幕，答案证据" : "视频字幕"}
    >
      {text}
    </div>
  );
}
