import { ChevronLeft, LibraryBig } from "lucide-react";

import { Button } from "@/components/ui/button";
import { format_duration } from "../../shared/format";
import { media_url } from "../../shared/api";
import type { MediaAsset } from "../../shared/types";
import { CollapsiblePanelRail } from "./CollapsiblePanelRail";

type AssetLibraryProps = {
  assets: MediaAsset[];
  selected_asset_id: string | null;
  on_select: (asset_id: string) => void;
  collapsed?: boolean;
  on_collapsed_change?: (collapsed: boolean) => void;
};

export function AssetLibrary({
  assets,
  selected_asset_id,
  on_select,
  collapsed = false,
  on_collapsed_change,
}: AssetLibraryProps) {
  const ready_assets = assets.filter((asset) => asset.status === "ready");

  if (collapsed) {
    return (
      <aside
        className="asset_library asset_library_collapsed"
        aria-label="视频库"
      >
        <CollapsiblePanelRail
          icon={LibraryBig}
          label="视频库"
          expand_direction="right"
          on_expand={() => on_collapsed_change?.(false)}
        />
      </aside>
    );
  }

  return (
    <aside className="asset_library" aria-label="视频库">
      <div className="pane_title">
        <h2>已下载视频</h2>
        <div>
          <span>{ready_assets.length}</span>
          {on_collapsed_change ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => on_collapsed_change(true)}
              aria-label="收起视频库"
            >
              <ChevronLeft data-icon="inline-start" aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      </div>
      {ready_assets.length === 0 ? (
        <p className="asset_library_empty">下载完成的视频会显示在这里。</p>
      ) : (
        <ol className="workbench_asset_list">
          {ready_assets.map((asset) => (
            <li key={asset.asset_id}>
              <button
                className={
                  asset.asset_id === selected_asset_id ? "selected" : ""
                }
                type="button"
                onClick={() => on_select(asset.asset_id)}
                aria-pressed={asset.asset_id === selected_asset_id}
              >
                <span className="workbench_asset_thumbnail">
                  {asset.thumbnail_url ? (
                    <img src={media_url(asset.thumbnail_url)} alt="" />
                  ) : (
                    "▶"
                  )}
                </span>
                <span className="workbench_asset_copy">
                  <strong>{asset.title}</strong>
                  <small>
                    {asset.author_name ?? "未知作者"} ·{" "}
                    {format_duration(asset.duration_seconds)}
                  </small>
                </span>
                <span
                  className={`asset_status ${asset.status}`}
                  title={asset.status}
                />
              </button>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}
