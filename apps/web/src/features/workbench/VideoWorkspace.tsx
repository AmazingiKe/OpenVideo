import { useEffect, useRef, useState, type RefObject } from "react";
import {
  Pause,
  Maximize,
  Minimize,
  PictureInPicture2,
  Play,
  RotateCcw,
  RotateCw,
  Settings,
  Volume1,
  Volume2,
  VolumeX,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Slider } from "@/components/ui/slider";
import { Player, type PlayerHandle } from "@/features/player/Player";
import { media_url } from "@/shared/api";
import { format_time } from "@/shared/format";
import type { MediaAsset, MediaMarker, Transcript } from "@/shared/types";

const SEEK_STEP_SECONDS = 10;
const LOW_VOLUME_THRESHOLD = 0.5;
const VOLUME_PERCENT_MAX = 100;
const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

type VideoWorkspaceProps = {
  asset: MediaAsset | null;
  markers: MediaMarker[];
  transcript: Transcript | null;
  player_ref: RefObject<PlayerHandle | null>;
  on_time_change: (seconds: number) => void;
};

export function VideoWorkspace({
  asset,
  markers,
  transcript,
  player_ref,
  on_time_change,
}: VideoWorkspaceProps) {
  const [is_paused, set_is_paused] = useState(true);
  const [volume, set_volume] = useState(1);
  const [is_muted, set_is_muted] = useState(false);
  const [playback_rate, set_playback_rate] = useState(1);
  const [is_picture_in_picture, set_is_picture_in_picture] = useState(false);
  const [is_fullscreen, set_is_fullscreen] = useState(false);
  const [can_picture_in_picture, set_can_picture_in_picture] = useState(false);
  const transport_time_ref = useRef<number | null>(null);

  useEffect(() => {
    transport_time_ref.current = null;
    set_is_paused(true);
    set_volume(1);
    set_is_muted(false);
    set_playback_rate(1);
    set_is_picture_in_picture(false);
    set_is_fullscreen(false);
    set_can_picture_in_picture(false);
  }, [asset?.asset_id]);

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
        <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-[var(--player-canvas)]">
          <div className="min-h-56 flex-1 bg-[var(--player-canvas)] p-5 pb-2 max-[600px]:p-2 max-[600px]:pb-1">
            <Player
              key={asset.asset_id}
              ref={player_ref}
              src={media_url(asset.playback_url)}
              subtitles={transcript?.segments ?? []}
              markers={markers.map((marker) => ({
                time_seconds: marker.time_seconds,
                label: format_time(marker.time_seconds),
              }))}
              thumbnails={player_storyboard(asset)}
              on_time_change={(seconds) => {
                transport_time_ref.current = seconds;
                on_time_change(seconds);
              }}
              on_pause_change={set_is_paused}
              on_volume_change={(next_volume, muted) => {
                set_volume(next_volume);
                set_is_muted(muted);
              }}
              on_presentation_change={(state) => {
                set_playback_rate(state.playback_rate);
                set_is_picture_in_picture(state.picture_in_picture);
                set_is_fullscreen(state.fullscreen);
                set_can_picture_in_picture(state.can_picture_in_picture);
              }}
            />
          </div>
          <div
            className="grid min-h-11 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center border-t bg-background/95 px-4 max-[600px]:grid-cols-[auto_minmax(0,1fr)] max-[600px]:gap-2 max-[600px]:px-2"
            aria-label="播放控制"
          >
            <div className="col-start-2 flex items-center gap-2 max-[600px]:col-start-1">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() =>
                  seek_relative(
                    player_ref,
                    transport_time_ref,
                    -SEEK_STEP_SECONDS,
                  )
                }
                aria-label={`后退 ${SEEK_STEP_SECONDS} 秒`}
              >
                <RotateCcw data-icon="inline-start" aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="icon-sm"
                onClick={() => player_ref.current?.toggle_playback()}
                aria-label={is_paused ? "播放" : "暂停"}
              >
                {is_paused ? (
                  <Play data-icon="inline-start" aria-hidden="true" />
                ) : (
                  <Pause data-icon="inline-start" aria-hidden="true" />
                )}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() =>
                  seek_relative(
                    player_ref,
                    transport_time_ref,
                    SEEK_STEP_SECONDS,
                  )
                }
                aria-label={`快进 ${SEEK_STEP_SECONDS} 秒`}
              >
                <RotateCw data-icon="inline-start" aria-hidden="true" />
              </Button>
            </div>
            <PlayerUtilityControls
              volume={volume}
              muted={is_muted}
              playback_rate={playback_rate}
              picture_in_picture={is_picture_in_picture}
              fullscreen={is_fullscreen}
              can_picture_in_picture={can_picture_in_picture}
              on_volume_change={(next_volume) =>
                player_ref.current?.set_volume(next_volume)
              }
              on_mute_toggle={() => player_ref.current?.toggle_muted()}
              on_playback_rate_change={(rate) =>
                player_ref.current?.set_playback_rate(rate)
              }
              on_picture_in_picture_toggle={() =>
                player_ref.current?.toggle_picture_in_picture()
              }
              on_fullscreen_toggle={() =>
                player_ref.current?.toggle_fullscreen()
              }
            />
          </div>
        </div>
      </div>
    </section>
  );
}

function PlayerUtilityControls({
  volume,
  muted,
  playback_rate,
  picture_in_picture,
  fullscreen,
  can_picture_in_picture,
  on_volume_change,
  on_mute_toggle,
  on_playback_rate_change,
  on_picture_in_picture_toggle,
  on_fullscreen_toggle,
}: {
  volume: number;
  muted: boolean;
  playback_rate: number;
  picture_in_picture: boolean;
  fullscreen: boolean;
  can_picture_in_picture: boolean;
  on_volume_change: (volume: number) => void;
  on_mute_toggle: () => void;
  on_playback_rate_change: (rate: number) => void;
  on_picture_in_picture_toggle: () => void;
  on_fullscreen_toggle: () => void;
}) {
  const volume_percent = Math.round(volume * VOLUME_PERCENT_MAX);
  let VolumeIcon = Volume2;
  if (muted || volume_percent === 0) VolumeIcon = VolumeX;
  else if (volume < LOW_VOLUME_THRESHOLD) VolumeIcon = Volume1;

  return (
    <div
      className="col-start-3 flex min-w-0 items-center gap-1 justify-self-end max-[600px]:col-start-2"
      aria-label="播放器设置"
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`播放设置，当前 ${playback_rate} 倍速`}
          >
            <Settings data-icon="inline-start" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="end">
          <DropdownMenuLabel>播放速度</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={String(playback_rate)}
            onValueChange={(value) => on_playback_rate_change(Number(value))}
          >
            {PLAYBACK_RATES.map((rate) => (
              <DropdownMenuRadioItem key={rate} value={String(rate)}>
                {rate}×
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={!can_picture_in_picture}
        onClick={on_picture_in_picture_toggle}
        aria-label={picture_in_picture ? "退出画中画" : "进入画中画"}
        aria-pressed={picture_in_picture}
      >
        <PictureInPicture2 data-icon="inline-start" aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={on_fullscreen_toggle}
        aria-label={fullscreen ? "退出全屏" : "进入全屏"}
        aria-pressed={fullscreen}
      >
        {fullscreen ? (
          <Minimize data-icon="inline-start" aria-hidden="true" />
        ) : (
          <Maximize data-icon="inline-start" aria-hidden="true" />
        )}
      </Button>
      <div className="flex min-w-0 items-center gap-2" aria-label="音量控制">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={on_mute_toggle}
          aria-label={muted ? "取消静音" : "静音"}
        >
          <VolumeIcon data-icon="inline-start" aria-hidden="true" />
        </Button>
        <Slider
          className="w-24 max-[600px]:w-14"
          min={0}
          max={VOLUME_PERCENT_MAX}
          step={1}
          value={[volume_percent]}
          onValueChange={([next_volume = 0]) =>
            on_volume_change(next_volume / VOLUME_PERCENT_MAX)
          }
          aria-label="音量"
        />
        <output
          className="w-8 text-right font-mono text-xs text-muted-foreground max-[600px]:hidden"
          aria-label="当前音量"
        >
          {volume_percent}%
        </output>
      </div>
    </div>
  );
}

function seek_relative(
  player_ref: RefObject<PlayerHandle | null>,
  transport_time_ref: RefObject<number | null>,
  offset_seconds: number,
) {
  const player = player_ref.current;
  if (!player) return;
  const current_time = transport_time_ref.current ?? player.current_time();
  const next_time = Math.max(0, current_time + offset_seconds);
  transport_time_ref.current = next_time;
  player.seek_to(next_time);
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
