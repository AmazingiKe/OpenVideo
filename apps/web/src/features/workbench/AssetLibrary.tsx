import { format_duration } from "../../shared/format";
import { media_url } from "../../shared/api";
import type { MediaAsset } from "../../shared/types";


export type AssetFilter = "all" | "ready" | "active" | "failed";

type AssetLibraryProps = {
  assets: MediaAsset[];
  active_filter: AssetFilter;
  selected_asset_id: string | null;
  on_filter: (filter: AssetFilter) => void;
  on_select: (asset_id: string) => void;
};

const filters: { key: AssetFilter; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "ready", label: "可播放" },
  { key: "active", label: "处理中" },
  { key: "failed", label: "失败" },
];

export function AssetLibrary({
  assets,
  active_filter,
  selected_asset_id,
  on_filter,
  on_select,
}: AssetLibraryProps) {
  const visible_assets = assets.filter((asset) => matches_filter(asset, active_filter));

  return (
    <aside className="asset_library" aria-label="媒体库">
      <div className="pane_title">
        <h2>媒体库</h2>
        <span>{assets.length}</span>
      </div>
      <div className="asset_filters" aria-label="媒体状态筛选">
        {filters.map((filter) => (
          <button
            key={filter.key}
            className={active_filter === filter.key ? "active" : ""}
            type="button"
            onClick={() => on_filter(filter.key)}
          >
            {filter.label}
          </button>
        ))}
      </div>
      {visible_assets.length === 0 ? (
        <p className="asset_library_empty">没有符合条件的视频。</p>
      ) : (
        <ol className="workbench_asset_list">
          {visible_assets.map((asset) => (
            <li key={asset.asset_id}>
              <button
                className={asset.asset_id === selected_asset_id ? "selected" : ""}
                type="button"
                onClick={() => on_select(asset.asset_id)}
                aria-pressed={asset.asset_id === selected_asset_id}
              >
                <span className="workbench_asset_thumbnail">
                  {asset.thumbnail_url ? <img src={media_url(asset.thumbnail_url)} alt="" /> : "▶"}
                </span>
                <span className="workbench_asset_copy">
                  <strong>{asset.title}</strong>
                  <small>{asset.author_name ?? "未知作者"} · {format_duration(asset.duration_seconds)}</small>
                </span>
                <span className={`asset_status ${asset.status}`} title={asset.status} />
              </button>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}

function matches_filter(asset: MediaAsset, filter: AssetFilter): boolean {
  if (filter === "all") return true;
  if (filter === "ready") return asset.status === "ready";
  if (filter === "active") return ["pending", "downloading", "processing"].includes(asset.status);
  return asset.status === "failed";
}
