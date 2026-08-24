import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { RESOURCE_QUERY_KEYS } from "@/app/query_cache";
import {
  create_marker,
  delete_marker,
  get_markers,
} from "@/shared/api";
import * as media_api from "@/shared/api";
import { error_message } from "@/shared/errors";
import type { MediaMarker, MediaMarkerInput } from "@/shared/types";

const MARKER_TIME_PRECISION = 10;

export function use_asset_markers(asset_id: string) {
  const query_client = useQueryClient();
  const marker_query = useQuery({
    queryKey: RESOURCE_QUERY_KEYS.asset_markers(asset_id || null),
    queryFn: async ({ signal }) =>
      sort_markers(await get_markers(asset_id, signal)),
    enabled: Boolean(asset_id),
  });
  const markers = marker_query.data ?? [];
  const [mutation_error, set_mutation_error] = useState<string | null>(null);

  const update_cached_markers = useCallback(
    (update: (current: MediaMarker[]) => MediaMarker[]) => {
      if (!asset_id) return;
      query_client.setQueryData<MediaMarker[]>(
        RESOURCE_QUERY_KEYS.asset_markers(asset_id),
        (current) => update(current ?? []),
      );
    },
    [asset_id, query_client],
  );

  const add_marker = useCallback(
    async (start_seconds: number, end_seconds: number | null = null) => {
      if (!asset_id || !Number.isFinite(start_seconds) || start_seconds < 0)
        return;
      const rounded_start =
        Math.round(start_seconds * MARKER_TIME_PRECISION) /
        MARKER_TIME_PRECISION;
      const rounded_end =
        end_seconds === null
          ? null
          : Math.round(end_seconds * MARKER_TIME_PRECISION) /
            MARKER_TIME_PRECISION;
      try {
        const marker = await create_marker(asset_id, {
          start_seconds: rounded_start,
          end_seconds: rounded_end,
          title: "",
          tags: [],
          marker_range_before_seconds: null,
          marker_range_after_seconds: null,
        });
        update_cached_markers((current) => sort_markers([...current, marker]));
        set_mutation_error(null);
      } catch (error) {
        set_mutation_error(error_message(error));
      }
    },
    [asset_id, update_cached_markers],
  );

  const update_marker = useCallback(
    async (marker_id: string, update: MediaMarkerInput) => {
      if (!asset_id) return;
      try {
        const marker = await media_api.update_marker(
          asset_id,
          marker_id,
          { ...update, tags: normalize_tags(update.tags) },
        );
        update_cached_markers((current) =>
          current.map((item) =>
            item.marker_id === marker.marker_id ? marker : item,
          ),
        );
        set_mutation_error(null);
      } catch (error) {
        set_mutation_error(error_message(error));
        throw error;
      }
    },
    [asset_id, update_cached_markers],
  );

  const remove_marker = useCallback(
    async (marker_id: string) => {
      if (!asset_id) return;
      try {
        await delete_marker(asset_id, marker_id);
        update_cached_markers((current) =>
          current.filter((marker) => marker.marker_id !== marker_id),
        );
        set_mutation_error(null);
      } catch (error) {
        set_mutation_error(error_message(error));
      }
    },
    [asset_id, update_cached_markers],
  );

  return {
    markers,
    marker_error:
      mutation_error ??
      (marker_query.error ? error_message(marker_query.error) : null),
    add_marker,
    update_marker,
    remove_marker,
    reload_markers: async () => {
      await marker_query.refetch();
    },
  };
}

function sort_markers(markers: MediaMarker[]): MediaMarker[] {
  return [...markers].sort(
    (left, right) => left.start_seconds - right.start_seconds,
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
