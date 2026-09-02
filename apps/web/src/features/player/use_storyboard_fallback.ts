import { useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { RESOURCE_QUERY_KEYS } from "@/app/query_cache";
import { ensure_thumbnail_storyboard, media_url } from "@/shared/api";
import type { MediaAsset } from "@/shared/types";

import type { ScrubPreviewStoryboard } from "./scrub_preview_protocol";

export function use_storyboard_fallback(asset: MediaAsset | null) {
  const query_client = useQueryClient();
  const generating_asset_id_ref = useRef<string | null>(null);
  const ensure_fallback_storyboard = useCallback(
    (reason: string) => {
      if (
        !reason ||
        !asset ||
        storyboard_for_asset(asset) ||
        generating_asset_id_ref.current === asset.asset_id
      ) {
        return;
      }
      generating_asset_id_ref.current = asset.asset_id;
      void ensure_thumbnail_storyboard(asset.asset_id)
        .then((thumbnail_storyboard) => {
          query_client.setQueryData<MediaAsset[]>(
            RESOURCE_QUERY_KEYS.assets,
            (current_assets) =>
              current_assets?.map((current_asset) =>
                current_asset.asset_id === asset.asset_id
                  ? { ...current_asset, thumbnail_storyboard }
                  : current_asset,
              ),
          );
        })
        .catch(() => undefined)
        .finally(() => {
          if (generating_asset_id_ref.current === asset.asset_id) {
            generating_asset_id_ref.current = null;
          }
        });
    },
    [asset, query_client],
  );

  return {
    storyboard: storyboard_for_asset(asset),
    ensure_fallback_storyboard,
  };
}

export function storyboard_for_asset(
  asset: MediaAsset | null,
): ScrubPreviewStoryboard | null {
  if (
    !asset?.thumbnail_storyboard ||
    asset.thumbnail_storyboard.version !== 2
  ) {
    return null;
  }
  return {
    url: media_url(asset.thumbnail_storyboard.url),
    tile_width: asset.thumbnail_storyboard.tile_width,
    tile_height: asset.thumbnail_storyboard.tile_height,
    tiles: asset.thumbnail_storyboard.tiles,
  };
}
