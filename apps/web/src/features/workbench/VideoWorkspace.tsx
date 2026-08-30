import { type RefObject } from "react";
import { Play } from "lucide-react";

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Player, type PlayerHandle } from "@/features/player/Player";
import { media_url } from "@/shared/api";
import { format_marker_label } from "@/shared/marker_labels";
import type {
  AgentEvidenceRange,
  MediaAsset,
  MediaMarker,
  Transcript,
} from "@/shared/types";

type VideoWorkspaceProps = {
  asset: MediaAsset | null;
  markers: MediaMarker[];
  transcript: Transcript | null;
  evidence_range?: AgentEvidenceRange | null;
  player_ref: RefObject<PlayerHandle | null>;
  on_time_change: (seconds: number) => void;
  on_pause_change: (paused: boolean) => void;
  on_playback_rate_change: (rate: number) => void;
};

export function VideoWorkspace({
  asset,
  markers,
  transcript,
  evidence_range = null,
  player_ref,
  on_time_change,
  on_pause_change,
  on_playback_rate_change,
}: VideoWorkspaceProps) {
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
        <p className="max-w-1/3 shrink truncate text-xs text-muted-foreground">
          {asset.author_name ?? "未知作者"}
        </p>
      </header>
      <div className="workspace_stage flex min-h-0 flex-1">
        <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-player-canvas">
          <div className="min-h-56 flex-1 bg-player-canvas p-5 pb-2 max-[600px]:p-2 max-[600px]:pb-1">
            <Player
              key={asset.asset_id}
              ref={player_ref}
              src={media_url(asset.playback_url)}
              scrub_src={
                asset.scrub_preview_url
                  ? media_url(asset.scrub_preview_url)
                  : null
              }
              subtitles={transcript?.segments ?? []}
              evidence_range={evidence_range}
              markers={markers.map((marker) => ({
                start_seconds: marker.start_seconds,
                label: format_marker_label(marker),
              }))}
              thumbnails={player_storyboard(asset)}
              on_time_change={on_time_change}
              on_pause_change={on_pause_change}
              on_playback_rate_change={on_playback_rate_change}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

function player_storyboard(asset: MediaAsset) {
  if (!asset.thumbnail_storyboard) return null;
  return {
    url: media_url(asset.thumbnail_storyboard.url),
    tile_width: asset.thumbnail_storyboard.tile_width,
    tile_height: asset.thumbnail_storyboard.tile_height,
    tiles: asset.thumbnail_storyboard.tiles,
  };
}
