import { useCallback, useEffect, useState } from "react";

import {
  create_marker,
  delete_marker,
  get_markers,
  update_marker,
} from "../../shared/api";
import type { MediaMarker } from "../../shared/types";

const MARKER_TIME_PRECISION = 10;

export function use_asset_markers(asset_id: string) {
  const [markers, set_markers] = useState<MediaMarker[]>([]);
  const [marker_error, set_marker_error] = useState<string | null>(null);

  useEffect(() => {
    if (!asset_id) {
      set_markers([]);
      return;
    }
    const controller = new AbortController();
    set_marker_error(null);
    get_markers(asset_id, controller.signal)
      .then((loaded_markers) => set_markers(sort_markers(loaded_markers)))
      .catch((error: unknown) => {
        if (!is_abort_error(error)) set_marker_error(error_message(error));
      });
    return () => controller.abort();
  }, [asset_id]);

  const add_marker = useCallback(
    async (time_seconds: number) => {
      if (!asset_id || !Number.isFinite(time_seconds) || time_seconds < 0)
        return;
      const rounded_time =
        Math.round(time_seconds * MARKER_TIME_PRECISION) /
        MARKER_TIME_PRECISION;
      try {
        const marker = await create_marker(asset_id, rounded_time, []);
        set_markers((current) => sort_markers([...current, marker]));
        set_marker_error(null);
      } catch (error) {
        set_marker_error(error_message(error));
      }
    },
    [asset_id],
  );

  const update_marker_tags = useCallback(
    async (marker_id: string, tags: string[]) => {
      if (!asset_id) return;
      try {
        const marker = await update_marker(
          asset_id,
          marker_id,
          normalize_tags(tags),
        );
        set_markers((current) =>
          current.map((item) =>
            item.marker_id === marker.marker_id ? marker : item,
          ),
        );
        set_marker_error(null);
      } catch (error) {
        set_marker_error(error_message(error));
      }
    },
    [asset_id],
  );

  const remove_marker = useCallback(
    async (marker_id: string) => {
      if (!asset_id) return;
      try {
        await delete_marker(asset_id, marker_id);
        set_markers((current) =>
          current.filter((marker) => marker.marker_id !== marker_id),
        );
        set_marker_error(null);
      } catch (error) {
        set_marker_error(error_message(error));
      }
    },
    [asset_id],
  );

  return {
    markers,
    marker_error,
    add_marker,
    update_marker_tags,
    remove_marker,
  };
}

function sort_markers(markers: MediaMarker[]): MediaMarker[] {
  return [...markers].sort(
    (left, right) => left.time_seconds - right.time_seconds,
  );
}

function normalize_tags(tags: string[]): string[] {
  return tags.reduce<string[]>((normalized_tags, tag) => {
    const normalized_tag = tag.trim();
    const is_duplicate = normalized_tags.some(
      (existing_tag) =>
        existing_tag.localeCompare(normalized_tag, undefined, {
          sensitivity: "accent",
        }) === 0,
    );
    return normalized_tag && !is_duplicate
      ? [...normalized_tags, normalized_tag]
      : normalized_tags;
  }, []);
}

function error_message(error: unknown): string {
  return error instanceof Error ? error.message : "标记操作失败";
}

function is_abort_error(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
