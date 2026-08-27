import { useQueryClient } from "@tanstack/react-query";
import { Library } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { use_asset_catalog } from "@/app/asset_catalog";
import { RESOURCE_QUERY_KEYS } from "@/app/query_cache";
import { marker_asset_path } from "@/app/workspace_routes";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { LibraryBrowser } from "@/features/library/LibraryBrowser";
import { load_summary_project } from "@/features/summary/load_summary_project";
import type { MediaAsset } from "@/shared/types";

export function LibraryPage() {
  const navigate = useNavigate();
  const query_client = useQueryClient();
  const { assets, select_asset } = use_asset_catalog();

  async function open_video(asset: MediaAsset) {
    const project = await query_client.fetchQuery({
      queryKey: RESOURCE_QUERY_KEYS.summary_project(asset.asset_id),
      queryFn: ({ signal }) => load_summary_project(asset.asset_id, signal),
    });
    select_asset(asset.asset_id);
    navigate(
      project.documents.length > 0
        ? "/summary"
        : marker_asset_path(asset.asset_id),
    );
  }

  return (
    <section
      className="mx-auto flex h-full min-h-[36rem] w-full max-w-screen-2xl flex-col gap-6 px-4 py-8 md:px-8 md:py-10"
      aria-labelledby="library_page_title"
    >
      <PageHeader
        title_id="library_page_title"
        eyebrow="视频库"
        title="整理和查找所有视频"
        description="像文件管理器一样浏览虚拟文件夹；它们不会移动资料库中的真实文件。"
        icon={Library}
        action={<Badge variant="secondary">{assets.length} 个视频</Badge>}
      />
      <LibraryBrowser
        className="flex-1 rounded-xl border bg-background p-3 md:p-4"
        initial_folder_id={null}
        on_open_video={open_video}
      />
    </section>
  );
}
