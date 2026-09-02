import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { use_asset_catalog } from "@/app/asset_catalog";
import type { AgentEvidenceRange } from "@/shared/types";
import type { PlayerHandle } from "./Player";

type PlaybackSession = {
  asset_id: string | null;
  current_time: number;
  current_scrub_time: number | null;
  paused: boolean;
  playback_rate: number;
  volume: number;
  captions_enabled: boolean;
  player_ready: boolean;
  evidence_range: AgentEvidenceRange | null;
  attach_player: (player: PlayerHandle | null) => void;
  report_time: (seconds: number) => void;
  report_pause: (paused: boolean) => void;
  report_playback_rate: (rate: number) => void;
  report_volume: (volume: number) => void;
  report_captions: (enabled: boolean) => void;
  read_current_time: () => number;
  play: () => void;
  pause: () => void;
  toggle_playback: () => void;
  seek_to: (seconds: number) => void;
  preview_to: (seconds: number) => void;
  set_playback_rate: (rate: number) => void;
  set_volume: (volume: number) => void;
  toggle_captions: () => void;
  step_frame: (direction: "previous" | "next") => void;
  set_evidence_range: (range: AgentEvidenceRange | null) => void;
};

const PlaybackSessionContext = createContext<PlaybackSession | null>(null);

export function PlaybackSessionProvider({ children }: { children: ReactNode }) {
  const { selected_asset_id } = use_asset_catalog();
  const player_ref = useRef<PlayerHandle | null>(null);
  const current_time_ref = useRef(0);
  const [current_time, set_current_time] = useState(0);
  const [current_scrub_time, set_current_scrub_time] = useState<number | null>(
    null,
  );
  const [paused, set_paused] = useState(true);
  const [playback_rate, set_playback_rate_state] = useState(1);
  const [volume, set_volume_state] = useState(1);
  const [captions_enabled, set_captions_enabled] = useState(true);
  const [player_ready, set_player_ready] = useState(false);
  const [evidence_range, set_evidence_range] =
    useState<AgentEvidenceRange | null>(null);

  useEffect(() => {
    current_time_ref.current = 0;
    set_current_time(0);
    set_current_scrub_time(null);
    set_paused(true);
    set_playback_rate_state(1);
    set_evidence_range(null);
  }, [selected_asset_id]);

  const attach_player = useCallback((player: PlayerHandle | null) => {
    player_ref.current = player;
    set_player_ready(player !== null);
  }, []);

  const report_time = useCallback((seconds: number) => {
    current_time_ref.current = seconds;
    set_current_time(seconds);
    set_current_scrub_time(null);
  }, []);

  const report_pause = useCallback((next_paused: boolean) => {
    set_paused(next_paused);
  }, []);

  const report_playback_rate = useCallback((rate: number) => {
    set_playback_rate_state(rate);
  }, []);

  const report_volume = useCallback((next_volume: number) => {
    set_volume_state(next_volume);
  }, []);

  const report_captions = useCallback((enabled: boolean) => {
    set_captions_enabled(enabled);
  }, []);

  const read_current_time = useCallback(
    () => player_ref.current?.current_time() ?? current_time_ref.current,
    [],
  );
  const play = useCallback(() => player_ref.current?.play(), []);
  const pause = useCallback(() => player_ref.current?.pause(), []);
  const toggle_playback = useCallback(
    () => player_ref.current?.toggle_playback(),
    [],
  );
  const seek_to = useCallback((seconds: number) => {
    const bounded_time = Math.max(0, seconds);
    set_current_scrub_time(bounded_time);
    player_ref.current?.seek_to(bounded_time);
  }, []);
  const preview_to = useCallback((seconds: number) => {
    const bounded_time = Math.max(0, seconds);
    set_current_scrub_time(bounded_time);
    player_ref.current?.preview_to(bounded_time);
  }, []);
  const set_playback_rate = useCallback((rate: number) => {
    player_ref.current?.set_playback_rate(rate);
  }, []);
  const set_volume = useCallback((next_volume: number) => {
    player_ref.current?.set_volume(Math.min(1, Math.max(0, next_volume)));
  }, []);
  const toggle_captions = useCallback(
    () => player_ref.current?.toggle_captions(),
    [],
  );
  const step_frame = useCallback(
    (direction: "previous" | "next") =>
      player_ref.current?.step_frame(direction),
    [],
  );

  useEffect(() => {
    const on_key_down = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      )
        return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest("input, textarea, select, [contenteditable='true']")
      ) {
        return;
      }
      if (event.key !== "," && event.key !== ".") return;
      event.preventDefault();
      step_frame(event.key === "," ? "previous" : "next");
    };
    window.addEventListener("keydown", on_key_down);
    return () => window.removeEventListener("keydown", on_key_down);
  }, [step_frame]);

  const value = useMemo<PlaybackSession>(
    () => ({
      asset_id: selected_asset_id,
      current_time,
      current_scrub_time,
      paused,
      playback_rate,
      volume,
      captions_enabled,
      player_ready,
      evidence_range,
      attach_player,
      report_time,
      report_pause,
      report_playback_rate,
      report_volume,
      report_captions,
      read_current_time,
      play,
      pause,
      toggle_playback,
      seek_to,
      preview_to,
      set_playback_rate,
      set_volume,
      toggle_captions,
      step_frame,
      set_evidence_range,
    }),
    [
      attach_player,
      current_scrub_time,
      current_time,
      captions_enabled,
      evidence_range,
      pause,
      paused,
      playback_rate,
      play,
      player_ready,
      preview_to,
      read_current_time,
      report_pause,
      report_playback_rate,
      report_time,
      report_volume,
      report_captions,
      seek_to,
      selected_asset_id,
      set_playback_rate,
      set_volume,
      toggle_captions,
      toggle_playback,
      step_frame,
      volume,
    ],
  );

  return (
    <PlaybackSessionContext.Provider value={value}>
      {children}
    </PlaybackSessionContext.Provider>
  );
}

export function use_playback_session(): PlaybackSession {
  const session = useContext(PlaybackSessionContext);
  if (!session) {
    throw new Error(
      "use_playback_session 必须在 PlaybackSessionProvider 内使用",
    );
  }
  return session;
}
