import { memo, type RefObject, useEffect, useRef, useState } from "react";
import { ListVideo, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useQueryClient } from "@tanstack/react-query";

import { RESOURCE_QUERY_KEYS } from "@/app/query_cache";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Player, type PlayerHandle } from "@/features/player/Player";
import { record_scrub_preview_metrics } from "@/features/player/scrub_preview_diagnostics";
import { DEFAULT_SUBTITLE_DISPLAY_SETTINGS } from "@/features/player/subtitle_settings";
import { use_storyboard_preview } from "@/features/player/use_storyboard_preview";
import {
  create_subtitle_export,
  download_subtitle_file,
  media_url,
  update_subtitle_settings,
} from "@/shared/api";
import { error_message } from "@/shared/errors";
import { format_marker_label } from "@/shared/marker_labels";
import type {
  AgentEvidenceRange,
  MediaAsset,
  MediaSegment,
  MediaMarker,
  SubtitleDisplaySettings,
  SubtitleFileFormat,
  Transcript,
} from "@/shared/types";
import { SubtitleSettingsControl } from "./SubtitleSettingsControl";

type VideoWorkspaceProps = {
  asset: MediaAsset | null;
  markers: MediaMarker[];
  transcript: Transcript | null;
  chapters?: MediaSegment[];
  on_generate_chapters?: () => void;
  chapter_generation_message?: string | null;
  evidence_range?: AgentEvidenceRange | null;
  player_ref: RefObject<PlayerHandle | null>;
  on_time_change: (seconds: number) => void;
  on_pause_change: (paused: boolean) => void;
  on_playback_rate_change: (rate: number) => void;
};

export const VideoWorkspace = memo(function VideoWorkspace({
  asset,
  markers,
  transcript,
  chapters = [],
  on_generate_chapters,
  chapter_generation_message = null,
  evidence_range = null,
  player_ref,
  on_time_change,
  on_pause_change,
  on_playback_rate_change,
}: VideoWorkspaceProps) {
  const query_client = useQueryClient();
  const asset_id = asset?.asset_id;
  const { font_size, position, background, offset_milliseconds } =
    asset?.subtitle_display ?? DEFAULT_SUBTITLE_DISPLAY_SETTINGS;
  const [subtitle_settings, set_subtitle_settings] =
    useState<SubtitleDisplaySettings>(
      asset?.subtitle_display ?? DEFAULT_SUBTITLE_DISPLAY_SETTINGS,
    );
  const [settings_pending, set_settings_pending] = useState(false);
  const [export_pending, set_export_pending] = useState(false);
  const [file_export_pending, set_file_export_pending] = useState(false);
  const [file_exported_format, set_file_exported_format] =
    useState<SubtitleFileFormat | null>(null);
  const [export_relative_path, set_export_relative_path] = useState<
    string | null
  >(null);
  const [subtitle_error, set_subtitle_error] = useState<string | null>(null);
  const settings_request_version_ref = useRef(0);
  const export_request_ref = useRef<AbortController | null>(null);
  const saved_subtitle_settings_ref = useRef(subtitle_settings);
  const { storyboard, request_storyboard } = use_storyboard_preview(asset);

  useEffect(() => {
    settings_request_version_ref.current += 1;
    const saved_settings = {
      font_size,
      position,
      background,
      offset_milliseconds,
    };
    saved_subtitle_settings_ref.current = saved_settings;
    set_subtitle_settings((current_settings) => {
      if (
        current_settings.font_size === font_size &&
        current_settings.position === position &&
        current_settings.background === background &&
        current_settings.offset_milliseconds === offset_milliseconds
      ) {
        return current_settings;
      }
      return saved_settings;
    });
    set_settings_pending(false);
    set_subtitle_error(null);
  }, [asset_id, font_size, position, background, offset_milliseconds]);

  useEffect(() => {
    set_export_pending(false);
    set_file_export_pending(false);
    set_file_exported_format(null);
    set_export_relative_path(null);
    set_subtitle_error(null);
    return () => {
      export_request_ref.current?.abort();
      export_request_ref.current = null;
    };
  }, [asset_id]);

  function save_subtitle_settings(settings: SubtitleDisplaySettings) {
    if (!asset) return;
    const request_version = settings_request_version_ref.current + 1;
    settings_request_version_ref.current = request_version;
    set_subtitle_settings(settings);
    set_settings_pending(true);
    set_export_relative_path(null);
    set_file_exported_format(null);
    set_subtitle_error(null);
    void update_subtitle_settings(asset.asset_id, settings)
      .then((saved_settings) => {
        if (settings_request_version_ref.current !== request_version) return;
        saved_subtitle_settings_ref.current = saved_settings;
        set_subtitle_settings(saved_settings);
        set_settings_pending(false);
        query_client.setQueryData<MediaAsset[]>(
          RESOURCE_QUERY_KEYS.assets,
          (current_assets) =>
            current_assets?.map((current_asset) =>
              current_asset.asset_id === asset.asset_id
                ? { ...current_asset, subtitle_display: saved_settings }
                : current_asset,
            ),
        );
      })
      .catch((error) => {
        if (settings_request_version_ref.current !== request_version) return;
        set_subtitle_settings(saved_subtitle_settings_ref.current);
        set_settings_pending(false);
        set_subtitle_error(error_message(error));
      });
  }

  async function export_subtitled_video() {
    if (!asset || export_request_ref.current || settings_pending) return;
    const request = new AbortController();
    export_request_ref.current = request;
    set_export_pending(true);
    set_export_relative_path(null);
    set_subtitle_error(null);
    try {
      const result = await create_subtitle_export(
        asset.asset_id,
        request.signal,
      );
      if (request.signal.aborted) return;
      set_export_relative_path(result.relative_path);
    } catch (error) {
      if (request.signal.aborted) return;
      set_subtitle_error(error_message(error));
    } finally {
      if (!request.signal.aborted) {
        export_request_ref.current = null;
        set_export_pending(false);
      }
    }
  }

  async function export_subtitle_file(format: SubtitleFileFormat) {
    if (!asset || export_request_ref.current || settings_pending) return;
    const request = new AbortController();
    export_request_ref.current = request;
    set_file_export_pending(true);
    set_file_exported_format(null);
    set_subtitle_error(null);
    try {
      await download_subtitle_file(asset.asset_id, format, request.signal);
      if (request.signal.aborted) return;
      set_file_exported_format(format);
    } catch (error) {
      if (request.signal.aborted) return;
      set_subtitle_error(error_message(error));
    } finally {
      if (!request.signal.aborted) {
        export_request_ref.current = null;
        set_file_export_pending(false);
      }
    }
  }

  if (!asset?.playback_url) {
    return (
      <section
        className="grid h-full min-h-0 place-items-center bg-background"
        data-slot="video-workspace"
        aria-label="视频工作区"
      >
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Play aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>选择一个已完成的视频</EmptyTitle>
            <EmptyDescription>
              视频、转写、重点片段和手工标记将在同一工作区联动。
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </section>
    );
  }

  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-card"
      data-slot="video-workspace"
      aria-label="视频工作区"
    >
      <header className="flex min-h-12 items-center justify-between gap-4 border-b px-4">
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium">
          {asset.title}
        </h1>
        <div className="flex shrink-0 items-center gap-2">
          {on_generate_chapters ? (
            <Button
              variant="outline"
              size="sm"
              onClick={on_generate_chapters}
              disabled={
                Boolean(chapter_generation_message) ||
                !transcript?.segments.length
              }
              title={chapter_generation_message ?? undefined}
            >
              {chapter_generation_message ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <ListVideo data-icon="inline-start" />
              )}
              {chapter_generation_message
                ? "生成中…"
                : chapters.length
                  ? "重新生成章节"
                  : "生成章节"}
            </Button>
          ) : null}
          <SubtitleSettingsControl
            settings={subtitle_settings}
            has_subtitles={Boolean(
              transcript?.segments.some((segment) => segment.text.trim()),
            )}
            settings_pending={settings_pending}
            export_pending={export_pending}
            export_relative_path={export_relative_path}
            file_export_pending={file_export_pending}
            file_exported_format={file_exported_format}
            error_message={subtitle_error}
            on_change={save_subtitle_settings}
            on_export={() => void export_subtitled_video()}
            on_export_file={(format) => void export_subtitle_file(format)}
          />
          <p className="max-w-48 shrink truncate text-xs text-muted-foreground max-[720px]:hidden">
            {asset.author_name ?? "未知作者"}
          </p>
        </div>
      </header>
      <div className="workspace_stage flex min-h-0 flex-1">
        <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-player-canvas">
          <div className="min-h-0 flex-1 bg-player-canvas p-4 max-[600px]:p-2">
            <Player
              key={asset.asset_id}
              ref={player_ref}
              src={media_url(asset.playback_url)!}
              subtitles={transcript?.segments ?? []}
              chapters={chapters}
              subtitle_display={subtitle_settings}
              evidence_range={evidence_range}
              markers={markers.map((marker) => ({
                start_seconds: marker.start_seconds,
                label: format_marker_label(marker),
              }))}
              storyboard={storyboard}
              on_time_change={on_time_change}
              on_pause_change={on_pause_change}
              on_playback_rate_change={on_playback_rate_change}
              on_scrub_preview_metrics={record_scrub_preview_metrics}
              on_scrub_preview_unavailable={request_storyboard}
            />
          </div>
        </div>
      </div>
    </section>
  );
});
