import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Library } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { use_asset_catalog } from "@/app/asset_catalog";
import { RESOURCE_QUERY_KEYS } from "@/app/query_cache";
import { use_task_manager } from "@/app/task_manager";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { LibraryBrowser } from "@/features/library/LibraryBrowser";
import { LibraryToolsShelf } from "@/features/library/LibraryToolsShelf";
import { TranscriptionDialog } from "@/features/workbench/TranscriptionDialog";
import { use_transcription_resources } from "@/features/workbench/use_processing_resources";
import { load_summary_project } from "@/features/summary/load_summary_project";
import { error_message } from "@/shared/errors";
import type { MediaAsset, TranscriptionOptions } from "@/shared/types";

export function LibraryPage() {
  const navigate = useNavigate();
  const query_client = useQueryClient();
  const { assets, select_asset } = use_asset_catalog();
  const { start_transcription, is_transcription_running } = use_task_manager();
  const {
    transcription_models,
    default_transcription,
    error: resource_error,
  } = use_transcription_resources();
  const [transcription_assets, set_transcription_assets] = useState<
    MediaAsset[]
  >([]);
  const [transcription_error, set_transcription_error] = useState<
    string | null
  >(null);
  const [transcription_notice, set_transcription_notice] = useState("");

  async function transcribe_selected_videos(options: TranscriptionOptions) {
    const selected_assets = transcription_assets;
    set_transcription_assets([]);
    set_transcription_error(null);
    set_transcription_notice(
      `正在提交 ${selected_assets.length} 个转写任务，进度可在任务中心查看。`,
    );
    const results = await Promise.all(
      selected_assets.map(async (asset) => {
        try {
          await start_transcription(asset.asset_id, options);
          return true;
        } catch (error) {
          const failure = `${asset.title ?? "未命名视频"}：${error_message(error)}`;
          set_transcription_error((current) =>
            current ? `${current}；${failure}` : failure,
          );
          return false;
        }
      }),
    );
    set_transcription_notice(
      `已完成 ${results.filter(Boolean).length} 个视频的转写。`,
    );
  }

  async function open_video(asset: MediaAsset) {
    await query_client.fetchQuery({
      queryKey: RESOURCE_QUERY_KEYS.summary_project(asset.asset_id),
      queryFn: ({ signal }) => load_summary_project(asset.asset_id, signal),
    });
    select_asset(asset.asset_id);
    navigate("/summary");
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
      <LibraryToolsShelf />
      {transcription_error ? (
        <Alert variant="destructive">
          <AlertTitle>无法转写</AlertTitle>
          <AlertDescription>{transcription_error}</AlertDescription>
        </Alert>
      ) : null}
      <p role="status" className="sr-only">
        {transcription_notice}
      </p>
      <LibraryBrowser
        className="flex-1 rounded-xl border bg-background p-3 md:p-4"
        initial_folder_id={null}
        on_open_video={open_video}
        on_transcribe_videos={set_transcription_assets}
        is_transcription_running={is_transcription_running}
      />
      <TranscriptionDialog
        open={transcription_assets.length > 0}
        on_open_change={(open) => {
          if (!open) set_transcription_assets([]);
        }}
        asset={transcription_assets[0] ?? null}
        asset_count={transcription_assets.length}
        error={resource_error}
        has_transcript={false}
        is_transcribing={false}
        on_start_transcription={(options) =>
          void transcribe_selected_videos(options)
        }
        transcription_models={transcription_models}
        default_transcription={default_transcription}
        on_transcription_model_change={() =>
          void query_client.invalidateQueries({
            queryKey: RESOURCE_QUERY_KEYS.transcription_resources,
          })
        }
      />
    </section>
  );
}
