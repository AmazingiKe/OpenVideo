import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";

import { RESOURCE_QUERY_KEYS } from "@/app/query_cache";
import {
  MARKERS_ROUTE_PATH,
  marker_asset_id,
  marker_asset_path,
  workspace_route,
} from "@/app/workspace_routes";
import { list_assets } from "@/shared/api";
import type { MediaAsset } from "@/shared/types";

type AssetCatalog = {
  assets: MediaAsset[];
  selected_asset: MediaAsset | null;
  selected_asset_id: string | null;
  refresh_assets: (signal?: AbortSignal) => Promise<MediaAsset[]>;
  select_asset: (asset_id: string | null) => void;
};

const AssetCatalogContext = createContext<AssetCatalog | null>(null);
const EMPTY_ASSETS: MediaAsset[] = [];

export function AssetCatalogProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const query_client = useQueryClient();
  const [selected_asset_id, set_selected_asset_id] = useState<string | null>(
    null,
  );
  const assets_query = useQuery({
    queryKey: RESOURCE_QUERY_KEYS.assets,
    queryFn: ({ signal }) => list_assets(signal),
    enabled: workspace_route(location.pathname) !== null,
  });
  const assets = assets_query.data ?? EMPTY_ASSETS;

  const refresh_assets = useCallback(
    async (signal?: AbortSignal) => {
      const next_assets = await list_assets(signal);
      query_client.setQueryData(RESOURCE_QUERY_KEYS.assets, next_assets);
      return next_assets;
    },
    [query_client],
  );

  useEffect(() => {
    if (!assets_query.isFetched) return;
    const ready_assets = assets.filter((asset) => asset.status === "ready");
    const requested_asset_id = marker_asset_id(location.pathname);
    const is_markers_page =
      workspace_route(location.pathname)?.path === MARKERS_ROUTE_PATH;

    if (is_markers_page) {
      const requested_asset = ready_assets.find(
        (asset) => asset.asset_id === requested_asset_id,
      );
      if (requested_asset) {
        set_selected_asset_id(requested_asset.asset_id);
        return;
      }
      const fallback_asset =
        ready_assets.find((asset) => asset.asset_id === selected_asset_id) ??
        ready_assets[0] ??
        null;
      set_selected_asset_id(fallback_asset?.asset_id ?? null);
      const next_path = fallback_asset
        ? marker_asset_path(fallback_asset.asset_id)
        : MARKERS_ROUTE_PATH;
      if (location.pathname !== next_path)
        navigate(next_path, { replace: true });
      return;
    }

    set_selected_asset_id((current_id) => {
      if (
        current_id &&
        ready_assets.some((asset) => asset.asset_id === current_id)
      ) {
        return current_id;
      }
      return ready_assets[0]?.asset_id ?? null;
    });
  }, [
    assets,
    assets_query.isFetched,
    location.pathname,
    navigate,
    selected_asset_id,
  ]);

  const value = useMemo<AssetCatalog>(() => {
    const selected_asset =
      assets.find((asset) => asset.asset_id === selected_asset_id) ?? null;
    return {
      assets,
      selected_asset,
      selected_asset_id,
      refresh_assets,
      select_asset: set_selected_asset_id,
    };
  }, [assets, refresh_assets, selected_asset_id]);

  return (
    <AssetCatalogContext.Provider value={value}>
      {children}
    </AssetCatalogContext.Provider>
  );
}

export function use_asset_catalog(): AssetCatalog {
  const catalog = useContext(AssetCatalogContext);
  if (!catalog) {
    throw new Error("use_asset_catalog 必须在 AssetCatalogProvider 内使用");
  }
  return catalog;
}
