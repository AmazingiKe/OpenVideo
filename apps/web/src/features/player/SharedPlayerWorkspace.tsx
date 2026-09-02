import {
  Captions,
  ChevronLeft,
  ChevronRight,
  Copy,
  Maximize2,
  Minimize2,
  Pause,
  Play,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { use_asset_catalog } from "@/app/asset_catalog";
import { RESOURCE_QUERY_KEYS } from "@/app/query_cache";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { use_asset_analysis } from "@/features/analysis/use_asset_analysis";
import { use_asset_markers } from "@/features/markers/use_asset_markers";
import { SubtitleSettingsControl } from "@/features/workbench/SubtitleSettingsControl";
import {
  create_subtitle_export,
  media_url,
  update_subtitle_settings,
} from "@/shared/api";
import { error_message } from "@/shared/errors";
import { format_marker_label } from "@/shared/marker_labels";
import type { MediaAsset, SubtitleDisplaySettings } from "@/shared/types";
import { Player } from "./Player";
import { use_playback_session } from "./playback_session";
import { record_scrub_preview_metrics } from "./scrub_preview_diagnostics";
import { DEFAULT_SUBTITLE_DISPLAY_SETTINGS } from "./subtitle_settings";

export function SharedPlayerWorkspace({
  compact = false,
  on_expand,
  on_minimize,
}: {
  compact?: boolean;
  on_expand?: () => void;
  on_minimize?: () => void;
}) {
  const query_client = useQueryClient();
  const { selected_asset: asset, selected_asset_id } = use_asset_catalog();
  const { transcript } = use_asset_analysis(selected_asset_id);
  const { markers } = use_asset_markers(selected_asset_id ?? "");
  const {
    attach_player,
    captions_enabled,
    current_scrub_time,
    current_time,
    evidence_range,
    paused,
    playback_rate,
    player_ready,
    report_pause,
    report_captions,
    report_playback_rate,
    report_time,
    report_volume,
    step_frame,
    toggle_captions,
    toggle_playback,
    volume,
  } = use_playback_session();
  const [subtitle_settings, set_subtitle_settings] =
    useState<SubtitleDisplaySettings>(
      asset?.subtitle_display ?? DEFAULT_SUBTITLE_DISPLAY_SETTINGS,
    );
  const [settings_pending, set_settings_pending] = useState(false);
  const [export_pending, set_export_pending] = useState(false);
  const [export_relative_path, set_export_relative_path] = useState<
    string | null
  >(null);
  const [subtitle_error, set_subtitle_error] = useState<string | null>(null);
  const settings_request_version_ref = useRef(0);
  const saved_subtitle_settings_ref = useRef(subtitle_settings);

  useEffect(() => {
    settings_request_version_ref.current += 1;
    const saved_settings =
      asset?.subtitle_display ?? DEFAULT_SUBTITLE_DISPLAY_SETTINGS;
    saved_subtitle_settings_ref.current = saved_settings;
    set_subtitle_settings(saved_settings);
    set_settings_pending(false);
    set_export_pending(false);
    set_export_relative_path(null);
    set_subtitle_error(null);
  }, [asset]);

  function save_subtitle_settings(settings: SubtitleDisplaySettings) {
    if (!asset) return;
    const request_version = settings_request_version_ref.current + 1;
    settings_request_version_ref.current = request_version;
    set_subtitle_settings(settings);
    set_settings_pending(true);
    set_export_relative_path(null);
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
    if (!asset || export_pending || settings_pending) return;
    set_export_pending(true);
    set_export_relative_path(null);
    set_subtitle_error(null);
    try {
      const result = await create_subtitle_export(asset.asset_id);
      set_export_relative_path(result.relative_path);
    } catch (error) {
      set_subtitle_error(error_message(error));
    } finally {
      set_export_pending(false);
    }
  }

  if (!asset?.playback_url) {
    return (
      <section
        className="grid h-full min-h-0 place-items-center bg-background"
        data-slot="shared-player-workspace"
        aria-label="共享播放器"
      >
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Play aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>选择一个已完成的视频</EmptyTitle>
            <EmptyDescription>
              标记和笔记将共享同一个播放会话。
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </section>
    );
  }

  return (
    <section
      className={cn(
        "flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-card",
        compact && "border-b",
      )}
      data-slot="shared-player-workspace"
      data-compact={compact || undefined}
      aria-label="共享播放器"
    >
      <header
        className={cn(
          "flex items-center justify-between gap-4 border-b px-4",
          compact ? "h-full min-h-0 border-b-0" : "min-h-12",
        )}
      >
        {compact ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={paused ? "播放" : "暂停"}
            onClick={toggle_playback}
          >
            {paused ? (
              <Play aria-hidden="true" />
            ) : (
              <Pause aria-hidden="true" />
            )}
          </Button>
        ) : null}
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium">
          {asset.title}
        </h1>
        <div className="flex shrink-0 items-center gap-2">
          <div className="flex items-center gap-1" aria-label="逐帧控制">
            {!compact ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="上一帧"
                title="上一帧（,）"
                disabled={!player_ready}
                onClick={() => step_frame("previous")}
              >
                <ChevronLeft aria-hidden="true" />
              </Button>
            ) : null}
            <output
              className="min-w-24 text-center text-xs text-muted-foreground tabular-nums"
              aria-label="当前精确时间"
            >
              {format_precise_time(current_scrub_time ?? current_time)}
            </output>
            {!compact ? (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="下一帧"
                  title="下一帧（.）"
                  disabled={!player_ready}
                  onClick={() => step_frame("next")}
                >
                  <ChevronRight aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="复制当前精确时间"
                  title="复制当前精确时间"
                  onClick={() =>
                    void navigator.clipboard?.writeText(
                      format_precise_time(current_scrub_time ?? current_time),
                    )
                  }
                >
                  <Copy aria-hidden="true" />
                </Button>
              </>
            ) : null}
          </div>
          {compact ? (
            <>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="切换字幕"
                aria-pressed={captions_enabled}
                onClick={toggle_captions}
              >
                <Captions aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="展开播放器"
                onClick={on_expand}
              >
                <Maximize2 aria-hidden="true" />
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="切换字幕"
                aria-pressed={captions_enabled}
                onClick={toggle_captions}
              >
                <Captions aria-hidden="true" />
              </Button>
              <SubtitleSettingsControl
                settings={subtitle_settings}
                has_subtitles={Boolean(
                  transcript?.segments.some((segment) => segment.text.trim()),
                )}
                settings_pending={settings_pending}
                export_pending={export_pending}
                export_relative_path={export_relative_path}
                error_message={subtitle_error}
                on_change={save_subtitle_settings}
                on_export={() => void export_subtitled_video()}
              />
              <p className="max-w-48 shrink truncate text-xs text-muted-foreground max-[720px]:hidden">
                {asset.author_name ?? "未知作者"}
              </p>
              {on_minimize ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="收起为迷你播放器"
                  onClick={on_minimize}
                >
                  <Minimize2 aria-hidden="true" />
                </Button>
              ) : null}
            </>
          )}
        </div>
      </header>
      <div
        className={cn(
          compact
            ? "absolute size-px overflow-hidden"
            : "min-h-0 flex-1 bg-player-canvas p-4 max-[640px]:p-2",
        )}
      >
        <Player
          ref={attach_player}
          src={media_url(asset.playback_url)!}
          subtitles={transcript?.segments ?? []}
          subtitle_display={subtitle_settings}
          captions_enabled={captions_enabled}
          playback_rate={playback_rate}
          volume={volume}
          evidence_range={evidence_range}
          markers={markers.map((marker) => ({
            start_seconds: marker.start_seconds,
            label: format_marker_label(marker),
          }))}
          thumbnails={player_storyboard(asset)}
          on_time_change={report_time}
          on_pause_change={report_pause}
          on_playback_rate_change={report_playback_rate}
          on_volume_change={report_volume}
          on_captions_change={report_captions}
          on_scrub_preview_metrics={record_scrub_preview_metrics}
        />
      </div>
    </section>
  );
}

function format_precise_time(seconds: number) {
  const total_milliseconds = Math.max(0, Math.round(seconds * 1_000));
  const milliseconds = total_milliseconds % 1_000;
  const total_seconds = Math.floor(total_milliseconds / 1_000);
  const display_seconds = total_seconds % 60;
  const total_minutes = Math.floor(total_seconds / 60);
  const minutes = total_minutes % 60;
  const hours = Math.floor(total_minutes / 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(display_seconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
}

function player_storyboard(asset: MediaAsset) {
  if (!asset.thumbnail_storyboard) return null;
  return {
    url: media_url(asset.thumbnail_storyboard.url)!,
    tile_width: asset.thumbnail_storyboard.tile_width,
    tile_height: asset.thumbnail_storyboard.tile_height,
    tiles: asset.thumbnail_storyboard.tiles,
  };
}
