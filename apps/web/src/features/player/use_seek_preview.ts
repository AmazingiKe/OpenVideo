import { useCallback, useEffect, useRef, useState } from "react";

type SeekPreviewOptions = {
  commit_timeout_milliseconds: number;
};

export function use_seek_preview({
  commit_timeout_milliseconds,
}: SeekPreviewOptions) {
  const active_ref = useRef(false);
  const commit_pending_ref = useRef(false);
  const finish_timeout_ref = useRef<number | null>(null);
  const [is_active, set_is_active] = useState(false);
  const [commit_timeout_sequence, set_commit_timeout_sequence] = useState(0);

  const finish_preview = useCallback(() => {
    commit_pending_ref.current = false;
    active_ref.current = false;
    set_is_active(false);
    if (finish_timeout_ref.current !== null) {
      window.clearTimeout(finish_timeout_ref.current);
      finish_timeout_ref.current = null;
    }
  }, []);

  const begin = useCallback((seconds: number) => {
    const bounded_time = Math.max(0, seconds);
    active_ref.current = true;
    set_is_active(true);
    commit_pending_ref.current = false;
    if (finish_timeout_ref.current !== null) {
      window.clearTimeout(finish_timeout_ref.current);
      finish_timeout_ref.current = null;
    }
    return bounded_time;
  }, []);

  const commit = useCallback(() => {
    commit_pending_ref.current = true;
    if (finish_timeout_ref.current !== null) {
      window.clearTimeout(finish_timeout_ref.current);
    }
    finish_timeout_ref.current = window.setTimeout(
      () => {
        finish_preview();
        set_commit_timeout_sequence((current) => current + 1);
      },
      commit_timeout_milliseconds,
    );
  }, [commit_timeout_milliseconds, finish_preview]);

  const confirm = useCallback(() => {
    if (commit_pending_ref.current) finish_preview();
  }, [finish_preview]);

  const cancel = useCallback(() => {
    if (!active_ref.current) return;
    finish_preview();
  }, [finish_preview]);

  const has_active_preview = useCallback(() => active_ref.current, []);

  useEffect(
    () => () => {
      if (finish_timeout_ref.current !== null) {
        window.clearTimeout(finish_timeout_ref.current);
      }
    },
    [],
  );

  return {
    begin,
    commit,
    confirm,
    cancel,
    is_active,
    has_active_preview,
    commit_timeout_sequence,
  };
}
