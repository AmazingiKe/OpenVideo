import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

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

export function AssetCatalogProvider({ children }: { children: ReactNode }) {
  const [assets, set_assets] = useState<MediaAsset[]>([]);
  const [selected_asset_id, set_selected_asset_id] = useState<string | null>(
    null,
  );

  const refresh_assets = useCallback(async (signal?: AbortSignal) => {
    const next_assets = await list_assets(signal);
    set_assets(next_assets);
    set_selected_asset_id((current_id) => {
      if (
        current_id &&
        next_assets.some((asset) => asset.asset_id === current_id)
      ) {
        return current_id;
      }
      return (
        next_assets.find((asset) => asset.status === "ready")?.asset_id ?? null
      );
    });
    return next_assets;
  }, []);

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
