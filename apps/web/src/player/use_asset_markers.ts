import { useCallback, useEffect, useState } from "react";

import { format_time } from "../format";
import { uuid7 } from "../identifiers";


export type PlayerMarker = {
  id: string;
  time_seconds: number;
  label: string;
};

const STORAGE_PREFIX = "openvideo.player.markers";

export function use_asset_markers(asset_id: string) {
  const [markers, set_markers] = useState<PlayerMarker[]>(() => load_markers(asset_id));

  useEffect(() => {
    set_markers(load_markers(asset_id));
  }, [asset_id]);

  const add_marker = useCallback(
    (time_seconds: number) => {
      set_markers((current) => {
        const rounded = Math.floor(time_seconds);
        const too_close = current.some(
          (marker) => Math.abs(marker.time_seconds - rounded) < 1,
        );
        if (too_close) return current;
        const next = [
          ...current,
          { id: uuid7(), time_seconds: rounded, label: format_time(rounded) },
        ].sort((left, right) => left.time_seconds - right.time_seconds);
        save_markers(asset_id, next);
        return next;
      });
    },
    [asset_id],
  );

  const remove_marker = useCallback(
    (marker_id: string) => {
      set_markers((current) => {
        const next = current.filter((marker) => marker.id !== marker_id);
        save_markers(asset_id, next);
        return next;
      });
    },
    [asset_id],
  );

  return { markers, add_marker, remove_marker };
}

function load_markers(asset_id: string): PlayerMarker[] {
  try {
    const raw = localStorage.getItem(storage_key(asset_id));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(is_valid_marker)
      .sort((left, right) => left.time_seconds - right.time_seconds);
  } catch {
    return [];
  }
}

function save_markers(asset_id: string, markers: PlayerMarker[]): void {
  try {
    localStorage.setItem(storage_key(asset_id), JSON.stringify(markers));
  } catch {
    // 本地存储不可用或已满时静默放弃，不影响播放。
  }
}

function storage_key(asset_id: string): string {
  return `${STORAGE_PREFIX}.${asset_id}`;
}

function is_valid_marker(value: unknown): value is PlayerMarker {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.time_seconds === "number" &&
    Number.isFinite(candidate.time_seconds) &&
    candidate.time_seconds >= 0
  );
}
