import { useCallback, useEffect, useState } from "react";

import { format_time } from "../../shared/format";
import { uuid7 } from "../../shared/identifiers";


export type PlayerMarker = {
  id: string;
  time_seconds: number;
  label: string;
  tags: string[];
};

const STORAGE_PREFIX = "openvideo.player.markers";
const MARKER_TIME_PRECISION = 10;
const MINIMUM_MARKER_GAP_SECONDS = 0.1;

export function use_asset_markers(asset_id: string) {
  const [markers, set_markers] = useState<PlayerMarker[]>(() => load_markers(asset_id));
  const [storage_error, set_storage_error] = useState(false);

  useEffect(() => {
    set_markers(load_markers(asset_id));
    set_storage_error(false);
  }, [asset_id]);

  const add_marker = useCallback(
    (time_seconds: number) => {
      if (!Number.isFinite(time_seconds) || time_seconds < 0) return;
      set_markers((current) => {
        const rounded = Math.round(time_seconds * MARKER_TIME_PRECISION) / MARKER_TIME_PRECISION;
        const too_close = current.some(
          (marker) => Math.abs(marker.time_seconds - rounded) < MINIMUM_MARKER_GAP_SECONDS,
        );
        if (too_close) return current;
        const next = [
          ...current,
          { id: `marker-${uuid7().replaceAll("-", "")}`, time_seconds: rounded, label: format_time(rounded), tags: [] },
        ].sort((left, right) => left.time_seconds - right.time_seconds);
        set_storage_error(!save_markers(asset_id, next));
        return next;
      });
    },
    [asset_id],
  );

  const add_tag = useCallback(
    (marker_id: string, tag: string) => {
      const normalized_tag = tag.trim();
      if (!normalized_tag) return;
      set_markers((current) => {
        const marker = current.find((candidate) => candidate.id === marker_id);
        const duplicate_tag = marker?.tags.some(
          (current_tag) => current_tag.localeCompare(normalized_tag, undefined, { sensitivity: "accent" }) === 0,
        );
        if (!marker || duplicate_tag) return current;
        const next = current.map((candidate) => (
          candidate.id === marker_id
            ? { ...candidate, tags: [...candidate.tags, normalized_tag] }
            : candidate
        ));
        set_storage_error(!save_markers(asset_id, next));
        return next;
      });
    },
    [asset_id],
  );

  const remove_tag = useCallback(
    (marker_id: string, tag: string) => {
      set_markers((current) => {
        if (!current.some((marker) => marker.id === marker_id && marker.tags.includes(tag))) {
          return current;
        }
        const next = current.map((marker) => (
          marker.id === marker_id
            ? { ...marker, tags: marker.tags.filter((current_tag) => current_tag !== tag) }
            : marker
        ));
        set_storage_error(!save_markers(asset_id, next));
        return next;
      });
    },
    [asset_id],
  );

  const remove_marker = useCallback(
    (marker_id: string) => {
      set_markers((current) => {
        if (!current.some((marker) => marker.id === marker_id)) return current;
        const next = current.filter((marker) => marker.id !== marker_id);
        set_storage_error(!save_markers(asset_id, next));
        return next;
      });
    },
    [asset_id],
  );

  return { markers, storage_error, add_marker, add_tag, remove_tag, remove_marker };
}

function load_markers(asset_id: string): PlayerMarker[] {
  try {
    const raw = localStorage.getItem(storage_key(asset_id));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(is_valid_marker)
      .map((marker) => ({ ...marker, tags: Array.isArray(marker.tags) ? marker.tags : [] }))
      .sort((left, right) => left.time_seconds - right.time_seconds);
  } catch {
    return [];
  }
}

function save_markers(asset_id: string, markers: PlayerMarker[]): boolean {
  try {
    localStorage.setItem(storage_key(asset_id), JSON.stringify(markers));
    return true;
  } catch {
    return false;
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
    candidate.time_seconds >= 0 &&
    (candidate.tags === undefined || (
      Array.isArray(candidate.tags) && candidate.tags.every((tag) => typeof tag === "string")
    ))
  );
}
