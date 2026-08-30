import { useCallback, useEffect, useRef, useState } from "react";

const SCRUB_PREVIEW_SEEK_TOLERANCE_SECONDS = 1 / 120;

type ScrubPreviewOptions = {
  src: string | null;
  commit_timeout_milliseconds: number;
};

export function use_scrub_preview({
  src,
  commit_timeout_milliseconds,
}: ScrubPreviewOptions) {
  const video_ref = useRef<HTMLVideoElement>(null);
  const requested_time_ref = useRef<number | null>(null);
  const frame_ref = useRef<number | null>(null);
  const available_ref = useRef(Boolean(src));
  const active_ref = useRef(false);
  const commit_pending_ref = useRef(false);
  const hide_timeout_ref = useRef<number | null>(null);
  const [is_previewing, set_is_previewing] = useState(false);
  const [is_ready, set_is_ready] = useState(false);
  const [preview_time, set_preview_time] = useState<number | null>(null);
  const [fallback_seek_request, set_fallback_seek_request] = useState<{
    seconds: number;
  } | null>(null);

  const finish_preview = useCallback(() => {
    commit_pending_ref.current = false;
    active_ref.current = false;
    set_is_previewing(false);
    set_is_ready(false);
    set_preview_time(null);
    if (hide_timeout_ref.current !== null) {
      window.clearTimeout(hide_timeout_ref.current);
      hide_timeout_ref.current = null;
    }
  }, []);

  const apply_requested_time = useCallback(() => {
    frame_ref.current = null;
    const requested_time = requested_time_ref.current;
    if (requested_time === null) return;
    const video = video_ref.current;
    if (!available_ref.current) {
      set_fallback_seek_request({ seconds: requested_time });
      return;
    }
    if (!video || video.readyState < HTMLMediaElement.HAVE_METADATA) return;
    const bounded_time = Number.isFinite(video.duration)
      ? Math.min(requested_time, video.duration)
      : requested_time;
    if (
      Math.abs(video.currentTime - bounded_time) >=
      SCRUB_PREVIEW_SEEK_TOLERANCE_SECONDS
    ) {
      video.currentTime = bounded_time;
      return;
    }
    if (active_ref.current) set_is_ready(true);
  }, []);

  const queue_requested_time = useCallback(() => {
    if (frame_ref.current === null) {
      frame_ref.current = window.requestAnimationFrame(apply_requested_time);
    }
  }, [apply_requested_time]);

  const preview_to = useCallback(
    (seconds: number) => {
      const bounded_time = Math.max(0, seconds);
      requested_time_ref.current = bounded_time;
      commit_pending_ref.current = false;
      active_ref.current = true;
      set_is_previewing(true);
      set_preview_time(bounded_time);
      if (hide_timeout_ref.current !== null) {
        window.clearTimeout(hide_timeout_ref.current);
        hide_timeout_ref.current = null;
      }
      queue_requested_time();
      return bounded_time;
    },
    [queue_requested_time],
  );

  const begin_seek_commit = useCallback(() => {
    if (!active_ref.current) return;
    commit_pending_ref.current = true;
    if (hide_timeout_ref.current !== null) {
      window.clearTimeout(hide_timeout_ref.current);
    }
    hide_timeout_ref.current = window.setTimeout(
      finish_preview,
      commit_timeout_milliseconds,
    );
  }, [commit_timeout_milliseconds, finish_preview]);

  const confirm_seek = useCallback(() => {
    if (commit_pending_ref.current) finish_preview();
  }, [finish_preview]);

  const on_loaded_metadata = useCallback(() => {
    available_ref.current = true;
    if (requested_time_ref.current !== null) queue_requested_time();
  }, [queue_requested_time]);

  const on_seeked = useCallback(() => {
    if (active_ref.current) set_is_ready(true);
  }, []);

  const on_error = useCallback(() => {
    available_ref.current = false;
    set_is_ready(false);
    if (requested_time_ref.current !== null) queue_requested_time();
  }, [queue_requested_time]);

  const is_active = useCallback(() => active_ref.current, []);

  useEffect(() => {
    available_ref.current = Boolean(src);
    requested_time_ref.current = null;
    if (frame_ref.current !== null) {
      window.cancelAnimationFrame(frame_ref.current);
      frame_ref.current = null;
    }
    finish_preview();
    return () => {
      if (frame_ref.current !== null) {
        window.cancelAnimationFrame(frame_ref.current);
        frame_ref.current = null;
      }
      if (hide_timeout_ref.current !== null) {
        window.clearTimeout(hide_timeout_ref.current);
        hide_timeout_ref.current = null;
      }
    };
  }, [finish_preview, src]);

  return {
    video_ref,
    is_visible: is_previewing && is_ready,
    preview_time,
    fallback_seek_request,
    preview_to,
    begin_seek_commit,
    confirm_seek,
    is_active,
    on_loaded_metadata,
    on_seeked,
    on_error,
  };
}
