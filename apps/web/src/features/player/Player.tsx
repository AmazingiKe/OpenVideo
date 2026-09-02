import { MediaPlayer, MediaProvider } from "@vidstack/react";
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
  useState,
  type PointerEvent as ReactPointerEvent,
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
import { use_scrub_frame_preview } from "./use_scrub_frame_preview";
import type { ScrubPreviewMetrics } from "./use_scrub_frame_preview";
import type { ScrubPreviewStoryboard } from "./scrub_preview_protocol";

const SEEK_CONFIRMATION_TIMEOUT_MILLISECONDS = 1_500;
const MEDIA_TIME_SLIDER_SELECTOR = "[data-media-time-slider]";
const PLAYER_CONTROLS: PlyrControl[] = [
  "play",
  "progress",
  "current-time",
  "mute+volume",
  "settings",
  "pip",
  "airplay",
  "fullscreen",
];
const PLAYER_TRANSLATIONS = {
  AirPlay: "隔空播放",
  "Current time": "当前时间",
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
  begin_scrub: (seconds: number) => void;
  update_scrub: (seconds: number) => void;
  commit_scrub: (seconds: number) => void;
  cancel_scrub: () => void;
  current_time: () => number;
  play: () => void;
  pause: () => void;
  toggle_playback: () => void;
  set_playback_rate: (rate: number) => void;
  set_volume: (volume: number) => void;
  toggle_captions: () => void;
  step_frame: (direction: "previous" | "next") => void;
};

type TimelineMarker = {
  start_seconds: number;
  label: string;
};

type PlayerProps = {
  src: string;
  markers?: TimelineMarker[];
  subtitles?: TranscriptSegment[];
  subtitle_display?: SubtitleDisplaySettings;
  evidence_range?: AgentEvidenceRange | null;
  thumbnails?: ScrubPreviewStoryboard | null;
  playback_rate?: number;
  volume?: number;
  on_time_change?: (seconds: number) => void;
  on_pause_change?: (paused: boolean) => void;
  on_playback_rate_change?: (rate: number) => void;
  on_volume_change?: (volume: number) => void;
  on_captions_change?: (enabled: boolean) => void;
  captions_enabled?: boolean;
  on_scrub_preview_metrics?: (metrics: ScrubPreviewMetrics) => void;
  on_scrub_preview_unavailable?: (reason: string) => void;
};

export const Player = forwardRef<PlayerHandle, PlayerProps>(function Player(
  {
    src,
    markers = [],
    subtitles = [],
    subtitle_display = DEFAULT_SUBTITLE_DISPLAY_SETTINGS,
    evidence_range = null,
    thumbnails = null,
    playback_rate,
    volume,
    on_time_change,
    on_pause_change,
    on_playback_rate_change,
    on_volume_change,
    on_captions_change,
    captions_enabled: controlled_captions_enabled,
    on_scrub_preview_metrics,
    on_scrub_preview_unavailable,
  },
  ref,
) {
  // 用 ref 保存 player/remote 方法，避免 useImperativeHandle 随 player 变化重建
  const seek_fn_ref = useRef<((seconds: number) => void) | null>(null);
  const toggle_playback_fn_ref = useRef<(() => void) | null>(null);
  const play_fn_ref = useRef<(() => void) | null>(null);
  const pause_fn_ref = useRef<(() => void) | null>(null);
  const hold_controls_visible_fn_ref = useRef<(() => void) | null>(null);
  const release_controls_visibility_fn_ref = useRef<(() => void) | null>(null);
  const controls_visibility_held_ref = useRef(false);
  const set_playback_rate_fn_ref = useRef<((rate: number) => void) | null>(
    null,
  );
  const set_volume_fn_ref = useRef<((volume: number) => void) | null>(null);
  const [internal_captions_enabled, set_internal_captions_enabled] =
    useState(true);
  const [presented_time_seconds, set_presented_time_seconds] = useState<
    number | null
  >(null);
  const captions_enabled =
    controlled_captions_enabled ?? internal_captions_enabled;
  const wait_for_presented_frame_fn_ref = useRef<
    ((callback: (media_time: number) => void) => () => void) | null
  >(null);
  const presented_frame_cancel_ref = useRef<(() => void) | null>(null);
  const current_paused_ref = useRef(true);
  const resume_after_seek_ref = useRef(false);
  const active_source_ref = useRef(src);
  const player_shell_ref = useRef<HTMLDivElement>(null);
  const current_time_value_ref = useRef(0);
  const pending_seek_ref = useRef(false);
  const on_time_change_ref = useRef(on_time_change);
  const {
    canvas_ref: scrub_preview_canvas_ref,
    request_frame: request_scrub_frame,
    end_preview: end_scrub_preview,
    clear: clear_scrub_preview,
    has_preview_frame,
    unavailable_reason: scrub_preview_unavailable_reason,
  } = use_scrub_frame_preview(src, thumbnails, on_scrub_preview_metrics);

  useEffect(() => {
    on_time_change_ref.current = on_time_change;
  }, [on_time_change]);

  const toggle_captions = useCallback(() => {
    const enabled = !captions_enabled;
    if (controlled_captions_enabled === undefined) {
      set_internal_captions_enabled(enabled);
    }
    on_captions_change?.(enabled);
  }, [captions_enabled, controlled_captions_enabled, on_captions_change]);

  const {
    begin: begin_seek_preview,
    commit: commit_seek_preview,
    confirm: confirm_seek_preview,
    cancel: cancel_seek_preview,
    is_active: is_scrubbing,
    has_active_preview,
  } = use_seek_preview({
    commit_timeout_milliseconds: SEEK_CONFIRMATION_TIMEOUT_MILLISECONDS,
  });

  const hold_controls_visible = useCallback(() => {
    if (controls_visibility_held_ref.current) return;
    const hold = hold_controls_visible_fn_ref.current;
    if (!hold) return;
    controls_visibility_held_ref.current = true;
    hold();
  }, []);

  const release_controls_visibility = useCallback(() => {
    if (!controls_visibility_held_ref.current) return;
    controls_visibility_held_ref.current = false;
    release_controls_visibility_fn_ref.current?.();
  }, []);

  useEffect(() => {
    if (is_scrubbing) hold_controls_visible();
    else release_controls_visibility();
  }, [hold_controls_visible, is_scrubbing, release_controls_visibility]);

  const hold_player_timeline_controls = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!event_targets_media_time_slider(event)) return;
      hold_controls_visible();
    },
    [hold_controls_visible],
  );

  const release_player_timeline_controls = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!event_targets_media_time_slider(event)) return;
      if (!has_active_preview()) release_controls_visibility();
    },
    [has_active_preview, release_controls_visibility],
  );

  const request_scrub_preview = useCallback(
    (seconds: number) => {
      const bounds = player_shell_ref.current?.getBoundingClientRect();
      if (bounds) {
        request_scrub_frame(seconds, bounds.width, bounds.height);
      }
    },
    [request_scrub_frame],
  );

  const begin_scrub = useCallback(
    (seconds: number) => {
      const preview_was_active = has_active_preview();
      const bounded_time = begin_seek_preview(seconds);
      if (!preview_was_active) {
        resume_after_seek_ref.current = !current_paused_ref.current;
        pause_fn_ref.current?.();
      }
      request_scrub_preview(bounded_time);
    },
    [begin_seek_preview, has_active_preview, request_scrub_preview],
  );

  const update_scrub = useCallback(
    (seconds: number) => {
      if (!has_active_preview()) {
        begin_scrub(seconds);
        return;
      }
      request_scrub_preview(begin_seek_preview(seconds));
    },
    [
      begin_scrub,
      begin_seek_preview,
      has_active_preview,
      request_scrub_preview,
    ],
  );

  useEffect(() => {
    if (scrub_preview_unavailable_reason) {
      on_scrub_preview_unavailable?.(scrub_preview_unavailable_reason);
    }
  }, [on_scrub_preview_unavailable, scrub_preview_unavailable_reason]);

  const prepare_seek_commit = useCallback(
    (seconds: number) => {
      const bounded_time = Math.max(0, seconds);
      end_scrub_preview();
      current_time_value_ref.current = bounded_time;
      pending_seek_ref.current = true;
      commit_seek_preview();
      return bounded_time;
    },
    [commit_seek_preview, end_scrub_preview],
  );

  const commit_scrub = useCallback(
    (seconds: number) => {
      if (!has_active_preview()) begin_scrub(seconds);
      const bounded_time = prepare_seek_commit(seconds);
      seek_fn_ref.current?.(bounded_time);
    },
    [begin_scrub, has_active_preview, prepare_seek_commit],
  );

  const cancel_scrub = useCallback(() => {
    if (!has_active_preview()) return;
    cancel_seek_preview();
    pending_seek_ref.current = false;
    clear_scrub_preview();
    if (resume_after_seek_ref.current) play_fn_ref.current?.();
    resume_after_seek_ref.current = false;
  }, [cancel_seek_preview, clear_scrub_preview, has_active_preview]);

  const step_frame = useCallback(
    (direction: "previous" | "next") => {
      const bounds = player_shell_ref.current?.getBoundingClientRect();
      if (!bounds) return;
      pause_fn_ref.current?.();
      const source_time = current_time_value_ref.current;
      request_scrub_frame(
        source_time,
        bounds.width,
        bounds.height,
        direction,
        (frame_time_seconds) => {
          end_scrub_preview();
          const bounded_time = prepare_seek_commit(frame_time_seconds);
          seek_fn_ref.current?.(bounded_time);
        },
      );
    },
    [end_scrub_preview, prepare_seek_commit, request_scrub_frame],
  );

  useImperativeHandle(
    ref,
    () => ({
      seek_to: (seconds: number) => {
        const bounded_time = prepare_seek_commit(seconds);
        seek_fn_ref.current?.(bounded_time);
      },
      begin_scrub,
      update_scrub,
      commit_scrub,
      cancel_scrub,
      play: () => play_fn_ref.current?.(),
      pause: () => pause_fn_ref.current?.(),
      current_time: () => current_time_value_ref.current,
      toggle_playback: () => toggle_playback_fn_ref.current?.(),
      set_playback_rate: (rate: number) =>
        set_playback_rate_fn_ref.current?.(rate),
      set_volume: (volume: number) => set_volume_fn_ref.current?.(volume),
      toggle_captions,
      step_frame,
    }),
    [
      begin_scrub,
      cancel_scrub,
      commit_scrub,
      prepare_seek_commit,
      step_frame,
      toggle_captions,
      update_scrub,
    ],
  );

  const on_player_ready = useCallback((instance: PlayerController | null) => {
    if (instance) {
      const current_time = instance.current_time();
      current_time_value_ref.current = current_time;
      set_presented_time_seconds(current_time);
    }
    seek_fn_ref.current = instance ? (s) => instance.seek(s) : null;
    play_fn_ref.current = instance ? () => instance.play() : null;
    pause_fn_ref.current = instance ? () => instance.pause() : null;
    hold_controls_visible_fn_ref.current = instance
      ? () => instance.hold_controls_visible()
      : null;
    release_controls_visibility_fn_ref.current = instance
      ? () => instance.release_controls_visibility()
      : null;
    toggle_playback_fn_ref.current = instance
      ? () => instance.toggle_playback()
      : null;
    set_playback_rate_fn_ref.current = instance
      ? (rate) => instance.set_playback_rate(rate)
      : null;
    set_volume_fn_ref.current = instance
      ? (volume) => instance.set_volume(volume)
      : null;
    wait_for_presented_frame_fn_ref.current = instance
      ? (callback) => instance.wait_for_presented_frame(callback)
      : null;
  }, []);

  const on_player_time_change = useCallback(
    (seconds: number) => {
      if (!pending_seek_ref.current && has_active_preview()) return;
      if (pending_seek_ref.current) return;
      current_time_value_ref.current = seconds;
      set_presented_time_seconds(seconds);
      on_time_change_ref.current?.(seconds);
    },
    [has_active_preview],
  );

  const confirm_presented_seek = useCallback(() => {
    presented_frame_cancel_ref.current?.();
    const finish = (media_time: number) => {
      presented_frame_cancel_ref.current = null;
      pending_seek_ref.current = false;
      current_time_value_ref.current = media_time;
      set_presented_time_seconds(media_time);
      on_time_change_ref.current?.(media_time);
      confirm_seek_preview();
      clear_scrub_preview();
      if (resume_after_seek_ref.current) play_fn_ref.current?.();
      resume_after_seek_ref.current = false;
    };
    presented_frame_cancel_ref.current =
      wait_for_presented_frame_fn_ref.current?.(finish) ?? null;
    if (!presented_frame_cancel_ref.current)
      finish(current_time_value_ref.current);
  }, [clear_scrub_preview, confirm_seek_preview]);

  useEffect(
    () => () => {
      presented_frame_cancel_ref.current?.();
    },
    [],
  );

  useEffect(() => {
    if (active_source_ref.current === src) return;
    active_source_ref.current = src;
    resume_after_seek_ref.current = false;
    pending_seek_ref.current = false;
    cancel_seek_preview();
    set_presented_time_seconds(null);
    clear_scrub_preview();
  }, [cancel_seek_preview, clear_scrub_preview, src]);

  const on_player_pause_change = useCallback(
    (paused: boolean) => {
      current_paused_ref.current = paused;
      on_pause_change?.(paused);
    },
    [on_pause_change],
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
    <div
      className="openvideo_player_shell"
      ref={player_shell_ref}
      onPointerDownCapture={hold_player_timeline_controls}
      onPointerUpCapture={release_player_timeline_controls}
      onPointerCancelCapture={release_player_timeline_controls}
      onLostPointerCapture={release_player_timeline_controls}
    >
      <MediaPlayer
        className="openvideo_player"
        src={{ src, type: "video/mp4" }}
        playbackRate={playback_rate}
        volume={volume}
        ariaLabel="OpenVideo 播放器"
        data-scrubbing={is_scrubbing || undefined}
        onMediaSeekingRequest={begin_scrub}
        onMediaSeekRequest={prepare_seek_commit}
        onSeeked={confirm_presented_seek}
      >
        <MediaProvider />
        <canvas
          ref={scrub_preview_canvas_ref}
          className="openvideo_scrub_preview"
          data-active={has_preview_frame || undefined}
          aria-hidden="true"
        />
        {captions_enabled ? (
          <SubtitleOverlay
            segments={subtitles}
            settings={subtitle_display}
            evidence_range={evidence_range}
            media_time_seconds={presented_time_seconds}
          />
        ) : null}
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
          on_pause_change={on_player_pause_change}
          on_playback_rate_change={on_playback_rate_change}
          on_volume_change={on_volume_change}
        />
      </MediaPlayer>
    </div>
  );
});

function event_targets_media_time_slider(
  event: ReactPointerEvent<HTMLDivElement>,
) {
  return (
    event.target instanceof Element &&
    event.target.closest(MEDIA_TIME_SLIDER_SELECTOR) !== null
  );
}

function SubtitleOverlay({
  segments,
  settings,
  evidence_range,
  media_time_seconds,
}: {
  segments: TranscriptSegment[];
  settings: SubtitleDisplaySettings;
  evidence_range: AgentEvidenceRange | null;
  media_time_seconds: number | null;
}) {
  if (media_time_seconds === null) return null;
  const subtitle_time =
    media_time_seconds + (settings.offset_milliseconds ?? 0) / 1_000;
  const active_segment = active_subtitle_segment(segments, subtitle_time);
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
