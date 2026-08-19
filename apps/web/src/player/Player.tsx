import { MediaPlayer, MediaProvider, useMediaPlayer, useMediaRemote, useMediaStore } from "@vidstack/react";
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
  const player_ref = useRef<PlayerRef>(null);

  useImperativeHandle(ref, () => ({
    seek_to: (seconds: number) => {
      player_ref.current?.seek(seconds);
    },
    current_time: () => player_ref.current?.current_time() ?? 0,
  }));

  const set_player_ref = useCallback((instance: PlayerRef | null) => {
    player_ref.current = instance;
  }, []);

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
        clickToPlay
      />
      <PlayerStateBridge on_ref={set_player_ref} on_time_change={on_time_change} />
    </MediaPlayer>
  );
});


type PlayerRef = {
  seek: (seconds: number) => void;
  current_time: () => number;
};

function PlayerStateBridge({
  on_ref,
  on_time_change,
}: {
  on_ref: (instance: PlayerRef | null) => void;
  on_time_change?: (seconds: number) => void;
}) {
  const player = useMediaPlayer();
  const remote = useMediaRemote();
  const store = useMediaStore();
  const last_reported_ref = useRef(-1);

  useEffect(() => {
    if (!player) return;
    on_ref({
      seek: (seconds: number) => remote.seek(seconds),
      current_time: () => player.currentTime,
    });
    return () => on_ref(null);
  }, [player, remote, on_ref]);

  useEffect(() => {
    if (!on_time_change) return;
    if (Math.abs(store.currentTime - last_reported_ref.current) >= 0.25) {
      last_reported_ref.current = store.currentTime;
      on_time_change(store.currentTime);
    }
  }, [store.currentTime, on_time_change]);

  return null;
}
