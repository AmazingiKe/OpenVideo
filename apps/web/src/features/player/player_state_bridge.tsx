import { useMediaPlayer, useMediaRemote, useMediaStore } from "@vidstack/react";
import { useEffect, useRef } from "react";

export type PlayerController = {
  current_time: () => number;
  preview_seek: (seconds: number) => void;
  seek: (seconds: number) => void;
  toggle_playback: () => void;
  set_playback_rate: (rate: number) => void;
};

type PlayerStateBridgeProps = {
  on_player_ready: (instance: PlayerController | null) => void;
  on_time_change?: (seconds: number) => void;
  on_pause_change?: (paused: boolean) => void;
  on_playback_rate_change?: (rate: number) => void;
};

export function PlayerStateBridge({
  on_player_ready,
  on_time_change,
  on_pause_change,
  on_playback_rate_change,
}: PlayerStateBridgeProps) {
  const player = useMediaPlayer();
  const remote = useMediaRemote();
  const store = useMediaStore();
  const last_reported_ref = useRef(-1);

  useEffect(() => {
    if (!player) return;
    // remote 的引用会变化，播放器实例才是控制句柄生命周期的稳定边界。
    on_player_ready({
      current_time: () => player.currentTime,
      preview_seek: (seconds: number) => {
        player.currentTime = seconds;
      },
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
