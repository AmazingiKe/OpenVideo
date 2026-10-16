import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { RESOURCE_QUERY_KEYS } from "@/app/query_cache";
import { use_library_identity } from "@/app/library";
import { get_asset_playback, update_asset_playback } from "@/shared/api";
import { error_message } from "@/shared/errors";
import type {
  MediaAsset,
  PlaybackProgress,
  PlaybackState,
} from "@/shared/types";

const PLAYBACK_SAVE_INTERVAL_MILLISECONDS = 5_000;
const OBSERVED_AT_MINIMUM_STEP_MILLISECONDS = 1;
let last_observed_milliseconds = 0;
const playback_save_queues = new Map<
  string,
  { tail: Promise<void> | null; revision: number }
>();

type PlaybackSession = {
  active: boolean;
  library_id: string | null;
  latest: PlaybackProgress | null;
  dirty: boolean;
  has_played: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  flush: (keepalive?: boolean) => void;
};

export function use_playback_progress(
  asset_id: string | null,
  active: boolean,
) {
  const query_client = useQueryClient();
  const library_id = use_library_identity();
  const session_ref = useRef<PlaybackSession | null>(null);
  const restore_key_ref = useRef(0);
  const [restore, set_restore] = useState<{
    progress: PlaybackProgress | null;
    key: number;
  }>({ progress: null, key: 0 });
  const [save_error, set_save_error] = useState<string | null>(null);

  useEffect(() => {
    const restore_key = ++restore_key_ref.current;
    set_restore({ progress: null, key: restore_key });
    set_save_error(null);
    if (!asset_id || !active) return;
    const request = new AbortController();
    const query_key = RESOURCE_QUERY_KEYS.asset_playback(asset_id);
    const session: PlaybackSession = {
      active: true,
      library_id,
      latest: null,
      dirty: false,
      has_played: false,
      timer: null,
      flush: (keepalive = false) => {
        if (session.timer) clearTimeout(session.timer);
        session.timer = null;
        const progress = session.latest;
        const library_id = session.library_id;
        if (!session.dirty || !session.has_played || !progress || !library_id)
          return;
        session.dirty = false;
        const queue_key = `${library_id}/${asset_id}`;
        const queue = playback_save_queues.get(queue_key) ?? {
          tail: null,
          revision: 0,
        };
        playback_save_queues.set(queue_key, queue);
        const revision = ++queue.revision;
        const save = async () => {
          if (queue.revision !== revision) return;
          try {
            const saved = await update_asset_playback(
              asset_id,
              {
                library_id,
                position_seconds: progress.position_seconds,
                playback_rate: progress.playback_rate,
                observed_at: progress.observed_at,
              },
              keepalive,
            );
            const current = query_client.getQueryData<PlaybackState>(query_key);
            if (
              queue.revision !== revision ||
              (current !== undefined && current.library_id !== library_id)
            )
              return;
            query_client.setQueryData(query_key, saved);
            query_client.setQueryData<MediaAsset[]>(
              RESOURCE_QUERY_KEYS.assets,
              (assets) =>
                assets?.map((asset) =>
                  asset.asset_id === asset_id
                    ? { ...asset, playback: saved }
                    : asset,
                ),
            );
            void query_client.invalidateQueries({
              queryKey: RESOURCE_QUERY_KEYS.recent_assets,
            });
            if (session.active) set_save_error(null);
          } catch (error) {
            if (session.active) {
              session.dirty = true;
              set_save_error(error_message(error));
            }
          }
        };
        // 两个工作区可能保留同一视频实例，所有保存共用队列以防旧请求后到覆盖新进度。
        const pending =
          queue.tail && !keepalive ? queue.tail.then(save) : save();
        queue.tail = pending;
        void pending.finally(() => {
          if (queue.tail === pending) playback_save_queues.delete(queue_key);
        });
      },
    };
    session_ref.current = session;
    const read_playback = async () => {
      const previous_saves = [...playback_save_queues.entries()]
        .filter(([key]) => key.endsWith(`/${asset_id}`))
        .map(([, queue]) => queue.tail);
      await Promise.all(previous_saves);
      if (request.signal.aborted) return;
      const state = await get_asset_playback(asset_id, request.signal);
      if (request.signal.aborted) return;
      if (library_id && state.library_id !== library_id) {
        session.library_id = null;
        throw new Error("资料库已切换，请重新打开视频。");
      }
      if (state.observed_at) {
        last_observed_milliseconds = Math.max(
          last_observed_milliseconds,
          Date.parse(state.observed_at),
        );
      }
      session.library_id = state.library_id;
      const cached = query_client.getQueryData<PlaybackState>(query_key);
      const has_newer_cached_progress =
        cached?.library_id === state.library_id &&
        cached.observed_at &&
        (!state.observed_at ||
          Date.parse(cached.observed_at) > Date.parse(state.observed_at));
      const current_state = has_newer_cached_progress ? cached : state;
      query_client.setQueryData(query_key, current_state);
      if (!session.active) session.flush(true);
      else if (!session.has_played)
        set_restore({ progress: current_state, key: restore_key });
      else if (session.dirty && !session.timer) session.flush();
    };
    void read_playback().catch((error) => {
      if (!request.signal.aborted && session.active)
        set_save_error(error_message(error));
    });
    const flush_on_exit = () => session.flush(true);
    window.addEventListener("pagehide", flush_on_exit);
    return () => {
      session.flush(true);
      session.active = false;
      request.abort();
      window.removeEventListener("pagehide", flush_on_exit);
      if (session_ref.current === session) session_ref.current = null;
    };
  }, [asset_id, active, query_client, library_id]);

  const on_progress_change = useCallback(
    (progress: PlaybackProgress, flush: boolean) => {
      const session = session_ref.current;
      if (!session?.active) return;
      session.has_played = true;
      last_observed_milliseconds = Math.max(
        Date.now(),
        last_observed_milliseconds + OBSERVED_AT_MINIMUM_STEP_MILLISECONDS,
      );
      session.latest = {
        ...progress,
        observed_at: new Date(last_observed_milliseconds).toISOString(),
      };
      session.dirty = true;
      if (flush) session.flush();
      else if (!session.timer)
        session.timer = setTimeout(
          session.flush,
          PLAYBACK_SAVE_INTERVAL_MILLISECONDS,
        );
    },
    [],
  );

  return {
    initial_playback: restore.progress,
    playback_restore_key: restore.key,
    on_progress_change,
    save_error,
  };
}
