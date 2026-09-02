import {
  isVideoProvider,
  useMediaPlayer,
  useMediaProvider,
  useMediaRemote,
  useMediaStore,
} from "@vidstack/react";
import { useEffect, useRef } from "react";

export type PlayerController = {
  current_time: () => number;
  seek: (seconds: number) => void;
  play: () => void;
  pause: () => void;
  hold_controls_visible: () => void;
  release_controls_visibility: () => void;
  toggle_playback: () => void;
  set_playback_rate: (rate: number) => void;
  set_volume: (volume: number) => void;
  wait_for_presented_frame: (
    callback: (media_time: number) => void,
  ) => () => void;
};

type PlayerStateBridgeProps = {
  on_player_ready: (instance: PlayerController | null) => void;
  on_time_change?: (seconds: number) => void;
  on_pause_change?: (paused: boolean) => void;
  on_playback_rate_change?: (rate: number) => void;
  on_volume_change?: (volume: number) => void;
};

export function PlayerStateBridge({
  on_player_ready,
  on_time_change,
  on_pause_change,
  on_playback_rate_change,
  on_volume_change,
}: PlayerStateBridgeProps) {
  const player = useMediaPlayer();
  const provider = useMediaProvider();
  const remote = useMediaRemote();
  const store = useMediaStore();
  const last_reported_ref = useRef(-1);

  useEffect(() => {
    if (!player) return;
    // remote 的引用会变化，播放器实例才是控制句柄生命周期的稳定边界。
    on_player_ready({
      current_time: () => player.currentTime,
      seek: (seconds: number) => remote.seek(seconds),
      play: () => void remote.play(),
      pause: () => void remote.pause(),
      hold_controls_visible: () => player.controls.pause(),
      release_controls_visibility: () => player.controls.resume(),
      toggle_playback: () => {
        if (player.paused) void remote.play();
        else void remote.pause();
      },
      set_playback_rate: (rate: number) => remote.changePlaybackRate(rate),
      set_volume: (volume: number) => remote.changeVolume(volume),
      wait_for_presented_frame: (callback) => {
        if (provider && isVideoProvider(provider)) {
          const callback_id = provider.video.requestVideoFrameCallback(
            (_now, metadata) => callback(metadata.mediaTime),
          );
          return () => provider.video.cancelVideoFrameCallback(callback_id);
        }
        callback(player.currentTime);
        return () => undefined;
      },
    });
    return () => on_player_ready(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player, provider]);

  useEffect(() => {
    if (!on_time_change) return;
    if (provider && isVideoProvider(provider)) {
      const video = provider.video;
      let callback_id = 0;
      const report_presented_frame: VideoFrameRequestCallback = (
        _now,
        metadata,
      ) => {
        last_reported_ref.current = metadata.mediaTime;
        on_time_change(metadata.mediaTime);
        callback_id = video.requestVideoFrameCallback(report_presented_frame);
      };
      callback_id = video.requestVideoFrameCallback(report_presented_frame);
      return () => video.cancelVideoFrameCallback(callback_id);
    }
    if (Math.abs(store.currentTime - last_reported_ref.current) >= 0.25) {
      last_reported_ref.current = store.currentTime;
      on_time_change(store.currentTime);
    }
  }, [provider, store.currentTime, on_time_change]);

  useEffect(() => {
    on_pause_change?.(store.paused);
  }, [store.paused, on_pause_change]);

  useEffect(() => {
    on_playback_rate_change?.(store.playbackRate);
  }, [store.playbackRate, on_playback_rate_change]);

  useEffect(() => {
    on_volume_change?.(store.volume);
  }, [store.volume, on_volume_change]);

  return null;
}
