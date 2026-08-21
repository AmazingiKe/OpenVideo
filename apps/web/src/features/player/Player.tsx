import {
  MediaPlayer,
  MediaProvider,
  VolumeSlider,
  useMediaPlayer,
  useMediaRemote,
  useMediaStore,
} from "@vidstack/react";
import "@vidstack/react/player/styles/base.css";
import { PlyrLayout, plyrLayoutIcons } from "@vidstack/react/player/layouts/plyr";
import "@vidstack/react/player/styles/plyr/theme.css";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";

import type { TranscriptSegment } from "../../shared/types";
import "./player.css";


const SEEK_CONFIRMATION_TOLERANCE_SECONDS = 0.5;
const SEEK_CONFIRMATION_TIMEOUT_MILLISECONDS = 1_500;

export type PlayerHandle = {
  seek_to: (seconds: number) => void;
  current_time: () => number;
  toggle_playback: () => void;
};

type TimelineMarker = {
  time_seconds: number;
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
  thumbnails?: Storyboard | null;
  on_time_change?: (seconds: number) => void;
  on_pause_change?: (paused: boolean) => void;
};

export const Player = forwardRef<PlayerHandle, PlayerProps>(function Player(
  { src, markers = [], subtitles = [], thumbnails = null, on_time_change, on_pause_change },
  ref,
) {
  // 用 ref 保存 player/remote 方法，避免 useImperativeHandle 随 player 变化重建
  const seek_fn_ref = useRef<((seconds: number) => void) | null>(null);
  const toggle_playback_fn_ref = useRef<(() => void) | null>(null);
  const current_time_value_ref = useRef(0);
  const pending_seek_ref = useRef<{ time_seconds: number; requested_at: number } | null>(null);
  const on_time_change_ref = useRef(on_time_change);

  useEffect(() => {
    on_time_change_ref.current = on_time_change;
  }, [on_time_change]);

  useImperativeHandle(ref, () => ({
    seek_to: (seconds: number) => {
      const bounded_time = Math.max(0, seconds);
      current_time_value_ref.current = bounded_time;
      pending_seek_ref.current = { time_seconds: bounded_time, requested_at: performance.now() };
      on_time_change_ref.current?.(bounded_time);
      seek_fn_ref.current?.(bounded_time);
    },
    current_time: () => current_time_value_ref.current,
    toggle_playback: () => toggle_playback_fn_ref.current?.(),
  }), []);

  const on_player_ready = useCallback(
    (instance: PlayerRef | null) => {
      seek_fn_ref.current = instance ? (s) => instance.seek(s) : null;
      toggle_playback_fn_ref.current = instance ? () => instance.toggle_playback() : null;
    },
    [],
  );

  const plyr_markers = markers.map((marker) => ({
    time: marker.time_seconds,
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
    <MediaPlayer
      className="openvideo_player"
      src={{ src, type: "video/mp4" }}
      ariaLabel="OpenVideo 播放器"
    >
      <MediaProvider />
      <SubtitleOverlay segments={subtitles} />
      <PlyrLayout
        icons={plyrLayoutIcons}
        markers={plyr_markers}
        thumbnails={plyr_thumbnails}
        slots={{ volumeSlider: <PlayerVolumeSlider /> }}
        clickToPlay
      />
      <PlayerStateBridge
        on_player_ready={on_player_ready}
        on_time_change={(seconds) => {
          const pending_seek = pending_seek_ref.current;
          const is_waiting_for_seek = pending_seek !== null
            && performance.now() - pending_seek.requested_at < SEEK_CONFIRMATION_TIMEOUT_MILLISECONDS;
          if (
            is_waiting_for_seek
            && Math.abs(seconds - pending_seek.time_seconds) > SEEK_CONFIRMATION_TOLERANCE_SECONDS
          ) {
            return;
          }
          pending_seek_ref.current = null;
          current_time_value_ref.current = seconds;
          on_time_change_ref.current?.(seconds);
        }}
        on_pause_change={on_pause_change}
      />
    </MediaPlayer>
  );
});

function SubtitleOverlay({ segments }: { segments: TranscriptSegment[] }) {
  const { currentTime } = useMediaStore();
  const text = active_subtitle_text(segments, currentTime);
  if (!text) return null;

  return <div className="openvideo_subtitle" aria-label="视频字幕">{text}</div>;
}

export function active_subtitle_text(segments: TranscriptSegment[], current_time: number): string | null {
  const active_segment = segments.find((segment) => (
    segment.start_seconds <= current_time && current_time < segment.end_seconds
  ));
  return active_segment?.text.trim() || null;
}


type PlayerRef = {
  seek: (seconds: number) => void;
  toggle_playback: () => void;
};

function PlayerVolumeSlider() {
  return (
    <VolumeSlider.Root
      className="plyr__slider openvideo_volume_slider"
      data-plyr="volume"
      aria-label="音量"
      step={0.1}
    >
      <div className="plyr__slider__track" />
      <div className="plyr__slider__thumb" />
    </VolumeSlider.Root>
  );
}

function PlayerStateBridge({
  on_player_ready,
  on_time_change,
  on_pause_change,
}: {
  on_player_ready: (instance: PlayerRef | null) => void;
  on_time_change?: (seconds: number) => void;
  on_pause_change?: (paused: boolean) => void;
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
      seek: (seconds: number) => remote.seek(seconds),
      toggle_playback: () => {
        if (player.paused) void remote.play();
        else void remote.pause();
      },
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

  return null;
}
