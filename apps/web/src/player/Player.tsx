import { MediaPlayer, MediaProvider, useMediaPlayer, useMediaRemote, useMediaStore } from "@vidstack/react";
import "@vidstack/react/player/styles/base.css";
import { PlyrLayout, plyrLayoutIcons } from "@vidstack/react/player/layouts/plyr";
import "@vidstack/react/player/styles/plyr/theme.css";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

import "./player.css";


export type PlayerHandle = {
  seek_to: (seconds: number) => void;
};

type TimelineMarker = {
  time_seconds: number;
  label: string;
};

type PlayerProps = {
  src: string;
  markers?: TimelineMarker[];
  on_time_change?: (seconds: number) => void;
};

export const Player = forwardRef<PlayerHandle, PlayerProps>(function Player(
  { src, markers = [], on_time_change },
  ref,
) {
  const player_ref = useRef<PlayerRef>(null);

  useImperativeHandle(ref, () => ({
    seek_to: (seconds: number) => {
      player_ref.current?.seek(seconds);
    },
  }));

  const plyr_markers = markers.map((marker) => ({
    time: marker.time_seconds,
    label: marker.label,
  }));

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
        clickToPlay
      />
      <PlayerStateBridge
        on_ref={(instance) => {
          player_ref.current = instance;
        }}
        on_time_change={on_time_change}
      />
    </MediaPlayer>
  );
});


type PlayerRef = {
  seek: (seconds: number) => void;
};

function PlayerStateBridge({
  on_ref,
  on_time_change,
}: {
  on_ref: (instance: PlayerRef) => void;
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
    });
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
