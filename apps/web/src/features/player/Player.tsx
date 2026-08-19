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

import "./player.css";


export type PlayerHandle = {
  seek_to: (seconds: number) => void;
  current_time: () => number;
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
  thumbnails?: Storyboard | null;
  on_time_change?: (seconds: number) => void;
};

export const Player = forwardRef<PlayerHandle, PlayerProps>(function Player(
  { src, markers = [], thumbnails = null, on_time_change },
  ref,
) {
  // 用 ref 保存 player/remote 方法，避免 useImperativeHandle 随 player 变化重建
  const seek_fn_ref = useRef<((seconds: number) => void) | null>(null);
  const current_time_fn_ref = useRef<(() => number) | null>(null);

  useImperativeHandle(ref, () => ({
    seek_to: (seconds: number) => seek_fn_ref.current?.(seconds),
    current_time: () => current_time_fn_ref.current?.() ?? 0,
  }), []);

  const on_player_ready = useCallback(
    (instance: PlayerRef | null) => {
      seek_fn_ref.current = instance ? (s) => instance.seek(s) : null;
      current_time_fn_ref.current = instance ? () => instance.current_time() : null;
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
      <PlyrLayout
        icons={plyrLayoutIcons}
        markers={plyr_markers}
        thumbnails={plyr_thumbnails}
        slots={{ volumeSlider: <PlayerVolumeSlider /> }}
        clickToPlay
      />
      <PlayerStateBridge on_player_ready={on_player_ready} on_time_change={on_time_change} />
    </MediaPlayer>
  );
});


type PlayerRef = {
  seek: (seconds: number) => void;
  current_time: () => number;
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
}: {
  on_player_ready: (instance: PlayerRef | null) => void;
  on_time_change?: (seconds: number) => void;
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
      current_time: () => player.currentTime,
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

  return null;
}
