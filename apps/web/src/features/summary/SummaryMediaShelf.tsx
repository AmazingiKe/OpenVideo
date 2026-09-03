import { Captions, ChevronDown, ChevronUp, Pause, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Player, type PlayerHandle } from "@/features/player/Player";
import { format_precise_media_time } from "@/features/player/format_media_time";
import { record_scrub_preview_metrics } from "@/features/player/scrub_preview_diagnostics";
import { DEFAULT_SUBTITLE_DISPLAY_SETTINGS } from "@/features/player/subtitle_settings";
import { use_storyboard_preview } from "@/features/player/use_storyboard_preview";
import { cn } from "@/lib/utils";
import { media_url } from "@/shared/api";
import type { MediaAsset, Transcript } from "@/shared/types";

type SummaryMediaShelfProps = {
  asset: MediaAsset | null;
  expanded: boolean;
  on_expanded_change: (expanded: boolean) => void;
  transcript: Transcript | null;
};

export function SummaryMediaShelf({
  asset,
  expanded,
  on_expanded_change,
  transcript,
}: SummaryMediaShelfProps) {
  const player_ref = useRef<PlayerHandle>(null);
  const [current_time, set_current_time] = useState(0);
  const [paused, set_paused] = useState(true);
  const [captions_enabled, set_captions_enabled] = useState(true);
  const { storyboard, request_storyboard } = use_storyboard_preview(asset);
  const playable = Boolean(asset?.playback_url);

  useEffect(() => {
    set_current_time(0);
    set_paused(true);
    set_captions_enabled(true);
  }, [asset?.asset_id]);

  function toggle_captions() {
    player_ref.current?.toggle_captions();
  }

  return (
    <section
      className="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-card"
      aria-label="总结参考视频"
      data-expanded={expanded || undefined}
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={paused ? "播放总结参考视频" : "暂停总结参考视频"}
          disabled={!playable}
          onClick={() => player_ref.current?.toggle_playback()}
        >
          {paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
        </Button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {asset?.title ?? "尚未选择视频"}
          </p>
        </div>
        <output
          className="shrink-0 text-xs text-muted-foreground tabular-nums"
          aria-label="总结参考视频当前时间"
        >
          {format_precise_media_time(current_time)}
        </output>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="切换总结参考视频字幕"
          aria-pressed={captions_enabled}
          disabled={!playable}
          onClick={toggle_captions}
        >
          <Captions aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={expanded ? "收起总结参考视频" : "展开总结参考视频"}
          aria-expanded={expanded}
          disabled={!playable}
          onClick={() => on_expanded_change(!expanded)}
        >
          {expanded ? (
            <ChevronUp aria-hidden="true" />
          ) : (
            <ChevronDown aria-hidden="true" />
          )}
        </Button>
      </header>
      <div
        className={cn(
          "min-h-0 flex-1 bg-player-canvas p-2",
          !expanded && "absolute size-px overflow-hidden p-0",
        )}
      >
        {asset?.playback_url ? (
          <Player
            key={asset.asset_id}
            ref={player_ref}
            src={media_url(asset.playback_url)!}
            subtitles={transcript?.segments ?? []}
            subtitle_display={
              asset.subtitle_display ?? DEFAULT_SUBTITLE_DISPLAY_SETTINGS
            }
            captions_enabled={captions_enabled}
            storyboard={storyboard}
            on_time_change={set_current_time}
            on_pause_change={set_paused}
            on_captions_change={set_captions_enabled}
            on_scrub_preview_metrics={record_scrub_preview_metrics}
            on_scrub_preview_unavailable={request_storyboard}
          />
        ) : (
          <div className="grid h-full place-items-center text-sm text-muted-foreground">
            请先选择一个已完成的视频
          </div>
        )}
      </div>
    </section>
  );
}
