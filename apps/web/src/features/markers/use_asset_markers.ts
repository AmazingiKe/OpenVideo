import { useCallback, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { RESOURCE_QUERY_KEYS } from "@/app/query_cache";
import { create_marker, delete_marker, get_markers } from "@/shared/api";
import * as media_api from "@/shared/api";
import { error_message } from "@/shared/errors";
import type { MediaMarker, MediaMarkerUpdate } from "@/shared/types";

const MARKER_TIME_PRECISION = 20;

type MarkerMutationState = {
  confirmed: MediaMarker;
  desired: MediaMarker;
  revision: number;
  tail: Promise<void>;
};

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
  const marker_mutations_ref = useRef(new Map<string, MarkerMutationState>());

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
        });
        update_cached_markers((current) => sort_markers([...current, marker]));
        set_mutation_error(null);
        return marker;
      } catch (error) {
        set_mutation_error(error_message(error));
        throw error;
      }
    },
    [asset_id, update_cached_markers],
  );

  const update_marker = useCallback(
    async (marker_id: string, update: MediaMarkerUpdate) => {
      if (!asset_id) return;
      const query_key = RESOURCE_QUERY_KEYS.asset_markers(asset_id);
      const cached_marker = query_client
        .getQueryData<MediaMarker[]>(query_key)
        ?.find((marker) => marker.marker_id === marker_id);
      if (!cached_marker) return;
      let mutation = marker_mutations_ref.current.get(marker_id);
      if (!mutation) {
        mutation = {
          confirmed: cached_marker,
          desired: cached_marker,
          revision: 0,
          tail: Promise.resolve(),
        };
        marker_mutations_ref.current.set(marker_id, mutation);
      }
      mutation.desired = { ...mutation.desired, ...update };
      mutation.revision += 1;
      const revision = mutation.revision;
      const active_mutation = mutation;
      update_cached_markers((current) =>
        replace_marker(current, active_mutation.desired),
      );

      const request = active_mutation.tail.then(() =>
        media_api.update_marker(asset_id, marker_id, update),
      );
      active_mutation.tail = request.then(
        () => undefined,
        () => undefined,
      );
      try {
        const confirmed = await request;
        active_mutation.confirmed = confirmed;
        if (active_mutation.revision === revision) {
          active_mutation.desired = confirmed;
          update_cached_markers((current) =>
            replace_marker(current, confirmed),
          );
          marker_mutations_ref.current.delete(marker_id);
        }
        set_mutation_error(null);
      } catch (error) {
        if (active_mutation.revision === revision) {
          active_mutation.desired = active_mutation.confirmed;
          update_cached_markers((current) =>
            replace_marker(current, active_mutation.confirmed),
          );
          marker_mutations_ref.current.delete(marker_id);
        }
        set_mutation_error(error_message(error));
        throw error;
      }
    },
    [asset_id, query_client, update_cached_markers],
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
        throw error;
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

function replace_marker(
  markers: MediaMarker[],
  replacement: MediaMarker,
): MediaMarker[] {
  return sort_markers(
    markers.map((marker) =>
      marker.marker_id === replacement.marker_id ? replacement : marker,
    ),
  );
}
