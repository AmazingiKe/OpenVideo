import { format_duration } from "../../shared/format";
import { media_url } from "../../shared/api";
import type { MediaAsset } from "../../shared/types";


type AssetLibraryProps = {
  assets: MediaAsset[];
  selected_asset_id: string | null;
  on_select: (asset_id: string) => void;
};

export function AssetLibrary({
  assets,
  selected_asset_id,
  on_select,
}: AssetLibraryProps) {
  const ready_assets = assets.filter((asset) => asset.status === "ready");

  return (
    <aside className="asset_library" aria-label="媒体库">
      <div className="pane_title">
        <h2>已下载视频</h2>
        <span>{ready_assets.length}</span>
      </div>
      {ready_assets.length === 0 ? (
        <p className="asset_library_empty">下载完成的视频会显示在这里。</p>
      ) : (
        <ol className="workbench_asset_list">
          {ready_assets.map((asset) => (
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
