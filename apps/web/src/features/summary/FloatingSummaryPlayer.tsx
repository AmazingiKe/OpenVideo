import { motion, useReducedMotion } from "motion/react";
import {
  Captions,
  GripHorizontal,
  Minimize2,
  PictureInPicture2,
  RotateCcw,
} from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

import {
  DIALOG_ENTER_SCALE,
  DIALOG_ENTER_OFFSET_PX,
  OVERLAY_ENTER_TRANSITION,
  OVERLAY_EXIT_TRANSITION,
} from "@/motion_tokens";
import { Button } from "@/components/ui/button";
import { Player, type PlayerHandle } from "@/features/player/Player";
import { record_scrub_preview_metrics } from "@/features/player/scrub_preview_diagnostics";
import { DEFAULT_SUBTITLE_DISPLAY_SETTINGS } from "@/features/player/subtitle_settings";
import { use_storyboard_preview } from "@/features/player/use_storyboard_preview";
import { cn } from "@/lib/utils";
import { media_url } from "@/shared/api";
import type {
  MediaAsset,
  SummaryPlayerGeometry,
  Transcript,
} from "@/shared/types";

const PLAYER_DEFAULT_WIDTH_PX = 400;
const PLAYER_DEFAULT_HEIGHT_PX = 280;
const PLAYER_MIN_WIDTH_PX = 320;
const PLAYER_MIN_HEIGHT_PX = 224;
const PLAYER_EDGE_INSET_PX = 16;
const PLAYER_COMPACT_EDGE_INSET_PX = 8;
const PLAYER_COMPACT_MAX_WIDTH_PX = 640;
const PLAYER_KEYBOARD_STEP_PX = 16;

type FloatingSummaryPlayerProps = {
  asset: MediaAsset | null;
  geometry: SummaryPlayerGeometry | null;
  open: boolean;
  on_geometry_change: (geometry: SummaryPlayerGeometry) => void;
  on_open_change: (open: boolean) => void;
  transcript: Transcript | null;
};

type ContainerSize = {
  width: number;
  height: number;
};

type PointerOperation = {
  kind: "move" | ResizeDirection;
  pointer_id: number;
  pointer_x: number;
  pointer_y: number;
  initial_geometry: SummaryPlayerGeometry;
  current_geometry: SummaryPlayerGeometry;
};

type ResizeDirection = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

const RESIZE_HANDLES: ReadonlyArray<{
  direction: ResizeDirection;
  label: string;
  class_name: string;
}> = [
  {
    direction: "n",
    label: "向上调整参考视频窗口大小",
    class_name: "absolute top-0 right-4 left-4 h-2 cursor-ns-resize",
  },
  {
    direction: "e",
    label: "向右调整参考视频窗口大小",
    class_name: "absolute top-4 right-0 bottom-4 w-2 cursor-ew-resize",
  },
  {
    direction: "s",
    label: "向下调整参考视频窗口大小",
    class_name: "absolute right-4 bottom-0 left-4 h-2 cursor-ns-resize",
  },
  {
    direction: "w",
    label: "向左调整参考视频窗口大小",
    class_name: "absolute top-4 bottom-4 left-0 w-2 cursor-ew-resize",
  },
  {
    direction: "ne",
    label: "向右上调整参考视频窗口大小",
    class_name: "absolute top-0 right-0 size-4 cursor-nesw-resize",
  },
  {
    direction: "se",
    label: "调整参考视频窗口大小",
    class_name: "absolute right-0 bottom-0 size-4 cursor-nwse-resize",
  },
  {
    direction: "sw",
    label: "向左下调整参考视频窗口大小",
    class_name: "absolute bottom-0 left-0 size-4 cursor-nesw-resize",
  },
  {
    direction: "nw",
    label: "向左上调整参考视频窗口大小",
    class_name: "absolute top-0 left-0 size-4 cursor-nwse-resize",
  },
];

export function FloatingSummaryPlayer({
  asset,
  geometry: stored_geometry,
  open,
  on_geometry_change,
  on_open_change,
  transcript,
}: FloatingSummaryPlayerProps) {
  const reduce_motion = useReducedMotion();
  const player_ref = useRef<PlayerHandle>(null);
  const container_ref = useRef<HTMLDivElement>(null);
  const pointer_operation_ref = useRef<PointerOperation | null>(null);
  const [container_size, set_container_size] = useState<ContainerSize>({
    width: 0,
    height: 0,
  });
  const [geometry, set_geometry] = useState<SummaryPlayerGeometry | null>(
    stored_geometry,
  );
  const [captions_enabled, set_captions_enabled] = useState(true);
  const { storyboard, request_storyboard } = use_storyboard_preview(asset);
  const compact = container_size.width <= PLAYER_COMPACT_MAX_WIDTH_PX;
  const displayed_geometry = player_geometry(geometry, container_size, compact);

  useEffect(() => {
    set_geometry(stored_geometry);
  }, [asset?.asset_id, stored_geometry]);

  useEffect(() => {
    set_captions_enabled(true);
  }, [asset?.asset_id]);

  useLayoutEffect(() => {
    const container = container_ref.current;
    if (!container) return;
    const update_size = () => {
      const bounds = container.getBoundingClientRect();
      if (bounds.width === 0 || bounds.height === 0) return;
      set_container_size({ width: bounds.width, height: bounds.height });
    };
    update_size();
    const observer = new ResizeObserver(update_size);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  if (!asset?.playback_url) return null;

  function commit_geometry(next_geometry: SummaryPlayerGeometry) {
    set_geometry(next_geometry);
    on_geometry_change(next_geometry);
  }

  function reset_geometry() {
    commit_geometry(default_player_geometry(container_size));
  }

  function move_with_keyboard(event: KeyboardEvent<HTMLButtonElement>) {
    const offset = keyboard_offset(event);
    if (!offset || compact) return;
    event.preventDefault();
    commit_geometry(
      fit_player_geometry(
        {
          ...displayed_geometry,
          x: displayed_geometry.x + offset.x,
          y: displayed_geometry.y + offset.y,
        },
        container_size,
      ),
    );
  }

  function resize_with_keyboard(event: KeyboardEvent<HTMLButtonElement>) {
    const offset = keyboard_offset(event);
    if (!offset || compact) return;
    event.preventDefault();
    commit_geometry(
      fit_player_geometry(
        {
          ...displayed_geometry,
          width: displayed_geometry.width + offset.x,
          height: displayed_geometry.height + offset.y,
        },
        container_size,
      ),
    );
  }

  function begin_pointer_operation(
    event: PointerEvent<HTMLButtonElement>,
    kind: PointerOperation["kind"],
  ) {
    if (event.button !== 0 || compact) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    pointer_operation_ref.current = {
      kind,
      pointer_id: event.pointerId,
      pointer_x: event.clientX,
      pointer_y: event.clientY,
      initial_geometry: displayed_geometry,
      current_geometry: displayed_geometry,
    };
  }

  function move_pointer_operation(event: PointerEvent<HTMLButtonElement>) {
    const pointer_operation = pointer_operation_ref.current;
    if (
      !pointer_operation ||
      pointer_operation.pointer_id !== event.pointerId
    ) {
      return;
    }
    const delta_x = event.clientX - pointer_operation.pointer_x;
    const delta_y = event.clientY - pointer_operation.pointer_y;
    pointer_operation.current_geometry =
      pointer_operation.kind === "move"
        ? fit_player_geometry(
            {
              ...pointer_operation.initial_geometry,
              x: pointer_operation.initial_geometry.x + delta_x,
              y: pointer_operation.initial_geometry.y + delta_y,
            },
            container_size,
          )
        : resize_player_geometry(
            pointer_operation.initial_geometry,
            pointer_operation.kind,
            delta_x,
            delta_y,
            container_size,
          );
    set_geometry(pointer_operation.current_geometry);
  }

  function finish_pointer_operation(event: PointerEvent<HTMLButtonElement>) {
    const pointer_operation = pointer_operation_ref.current;
    if (
      !pointer_operation ||
      pointer_operation.pointer_id !== event.pointerId
    ) {
      return;
    }
    pointer_operation_ref.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    commit_geometry(pointer_operation.current_geometry);
  }

  return (
    <div
      ref={container_ref}
      className="pointer-events-none absolute inset-0 z-20 overflow-hidden"
      data-slot="floating-summary-player-layer"
    >
      {!open ? (
        <Button
          type="button"
          variant="secondary"
          className="pointer-events-auto absolute right-4 bottom-4 shadow-lg"
          onClick={() => on_open_change(true)}
        >
          <PictureInPicture2 data-icon="inline-start" />
          参考视频
        </Button>
      ) : null}
      <motion.section
        className={cn(
          "pointer-events-auto absolute flex min-h-0 flex-col overflow-hidden rounded-xl border bg-card text-card-foreground shadow-lg",
          !open && "pointer-events-none",
        )}
        style={{
          left: displayed_geometry.x,
          top: displayed_geometry.y,
          width: displayed_geometry.width,
          height: displayed_geometry.height,
        }}
        initial={false}
        animate={{
          opacity: open ? 1 : 0,
          scale: open || reduce_motion ? 1 : DIALOG_ENTER_SCALE,
          y: open || reduce_motion ? 0 : DIALOG_ENTER_OFFSET_PX,
        }}
        transition={open ? OVERLAY_ENTER_TRANSITION : OVERLAY_EXIT_TRANSITION}
        aria-label="总结参考视频"
        aria-hidden={!open}
        inert={!open}
      >
        <header className="flex h-10 shrink-0 items-center gap-1 border-b px-1">
          <button
            type="button"
            className="flex h-8 min-w-0 flex-1 cursor-move items-center gap-2 rounded-md px-2 text-left text-sm font-medium outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-focus-ring disabled:pointer-events-none disabled:opacity-50"
            aria-label="移动参考视频窗口"
            title={compact ? asset.title : "拖动或使用方向键移动播放器"}
            disabled={compact}
            onKeyDown={move_with_keyboard}
            onPointerDown={(event) => begin_pointer_operation(event, "move")}
            onPointerMove={move_pointer_operation}
            onPointerUp={finish_pointer_operation}
            onPointerCancel={finish_pointer_operation}
          >
            <GripHorizontal aria-hidden="true" />
            <span className="truncate">{asset.title}</span>
          </button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="切换总结参考视频字幕"
            aria-pressed={captions_enabled}
            onClick={() => player_ref.current?.toggle_captions()}
          >
            <Captions aria-hidden="true" />
          </Button>
          {!compact ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="恢复播放器默认位置和大小"
              onClick={reset_geometry}
            >
              <RotateCcw aria-hidden="true" />
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="最小化参考视频"
            onClick={() => on_open_change(false)}
          >
            <Minimize2 aria-hidden="true" />
          </Button>
        </header>
        <div className="min-h-0 flex-1 bg-player-canvas p-2">
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
            on_captions_change={set_captions_enabled}
            on_scrub_preview_metrics={record_scrub_preview_metrics}
            on_scrub_preview_unavailable={request_storyboard}
          />
        </div>
        {!compact
          ? RESIZE_HANDLES.map((handle) => (
              <button
                key={handle.direction}
                type="button"
                className={cn(
                  "border-0 bg-transparent p-0 outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
                  handle.class_name,
                )}
                aria-label={handle.label}
                tabIndex={handle.direction === "se" ? 0 : -1}
                onKeyDown={
                  handle.direction === "se" ? resize_with_keyboard : undefined
                }
                onPointerDown={(event) =>
                  begin_pointer_operation(event, handle.direction)
                }
                onPointerMove={move_pointer_operation}
                onPointerUp={finish_pointer_operation}
                onPointerCancel={finish_pointer_operation}
              />
            ))
          : null}
      </motion.section>
    </div>
  );
}

function player_geometry(
  geometry: SummaryPlayerGeometry | null,
  container_size: ContainerSize,
  compact: boolean,
): SummaryPlayerGeometry {
  if (compact) {
    const width = Math.max(
      0,
      container_size.width - PLAYER_COMPACT_EDGE_INSET_PX * 2,
    );
    const height = Math.min(
      PLAYER_DEFAULT_HEIGHT_PX,
      Math.max(0, container_size.height - PLAYER_COMPACT_EDGE_INSET_PX * 2),
    );
    return {
      x: PLAYER_COMPACT_EDGE_INSET_PX,
      y: Math.max(
        PLAYER_COMPACT_EDGE_INSET_PX,
        container_size.height - height - PLAYER_COMPACT_EDGE_INSET_PX,
      ),
      width,
      height,
    };
  }
  return fit_player_geometry(
    geometry ?? default_player_geometry(container_size),
    container_size,
  );
}

function default_player_geometry(
  container_size: ContainerSize,
): SummaryPlayerGeometry {
  return fit_player_geometry(
    {
      x: container_size.width - PLAYER_DEFAULT_WIDTH_PX - PLAYER_EDGE_INSET_PX,
      y:
        container_size.height - PLAYER_DEFAULT_HEIGHT_PX - PLAYER_EDGE_INSET_PX,
      width: PLAYER_DEFAULT_WIDTH_PX,
      height: PLAYER_DEFAULT_HEIGHT_PX,
    },
    container_size,
  );
}

function fit_player_geometry(
  geometry: SummaryPlayerGeometry,
  container_size: ContainerSize,
): SummaryPlayerGeometry {
  const available_width = Math.max(
    PLAYER_MIN_WIDTH_PX,
    container_size.width - PLAYER_EDGE_INSET_PX * 2,
  );
  const available_height = Math.max(
    PLAYER_MIN_HEIGHT_PX,
    container_size.height - PLAYER_EDGE_INSET_PX * 2,
  );
  const width = clamp(geometry.width, PLAYER_MIN_WIDTH_PX, available_width);
  const height = clamp(geometry.height, PLAYER_MIN_HEIGHT_PX, available_height);
  return {
    x: clamp(
      geometry.x,
      PLAYER_EDGE_INSET_PX,
      Math.max(
        PLAYER_EDGE_INSET_PX,
        container_size.width - width - PLAYER_EDGE_INSET_PX,
      ),
    ),
    y: clamp(
      geometry.y,
      PLAYER_EDGE_INSET_PX,
      Math.max(
        PLAYER_EDGE_INSET_PX,
        container_size.height - height - PLAYER_EDGE_INSET_PX,
      ),
    ),
    width,
    height,
  };
}

function resize_player_geometry(
  geometry: SummaryPlayerGeometry,
  direction: ResizeDirection,
  delta_x: number,
  delta_y: number,
  container_size: ContainerSize,
): SummaryPlayerGeometry {
  const maximum_right = container_size.width - PLAYER_EDGE_INSET_PX;
  const maximum_bottom = container_size.height - PLAYER_EDGE_INSET_PX;
  let left = geometry.x;
  let top = geometry.y;
  let right = geometry.x + geometry.width;
  let bottom = geometry.y + geometry.height;

  if (direction.includes("e")) {
    right = clamp(right + delta_x, left + PLAYER_MIN_WIDTH_PX, maximum_right);
  }
  if (direction.includes("w")) {
    left = clamp(
      left + delta_x,
      PLAYER_EDGE_INSET_PX,
      right - PLAYER_MIN_WIDTH_PX,
    );
  }
  if (direction.includes("s")) {
    bottom = clamp(
      bottom + delta_y,
      top + PLAYER_MIN_HEIGHT_PX,
      maximum_bottom,
    );
  }
  if (direction.includes("n")) {
    top = clamp(
      top + delta_y,
      PLAYER_EDGE_INSET_PX,
      bottom - PLAYER_MIN_HEIGHT_PX,
    );
  }
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

function keyboard_offset(
  event: KeyboardEvent<HTMLButtonElement>,
): { x: number; y: number } | null {
  const step = event.shiftKey
    ? PLAYER_KEYBOARD_STEP_PX * 2
    : PLAYER_KEYBOARD_STEP_PX;
  if (event.key === "ArrowLeft") return { x: -step, y: 0 };
  if (event.key === "ArrowRight") return { x: step, y: 0 };
  if (event.key === "ArrowUp") return { x: 0, y: -step };
  if (event.key === "ArrowDown") return { x: 0, y: step };
  return null;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
