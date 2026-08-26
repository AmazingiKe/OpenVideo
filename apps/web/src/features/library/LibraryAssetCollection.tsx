import {
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { CheckSquare, FolderInput, X } from "lucide-react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  LibraryVideoCard,
  type LibraryViewMode,
} from "@/features/library/LibraryVideoCard";
import { cn } from "@/lib/utils";
import type { LibraryFolder, MediaAsset } from "@/shared/types";

type SelectionRectangle = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type MarqueeGesture = {
  pointer_id: number;
  start_x: number;
  start_y: number;
  base_selection: Set<string>;
};

type LibraryAssetCollectionProps = {
  assets: MediaAsset[];
  folders: LibraryFolder[];
  selected_asset_ids: Set<string>;
  dragging_asset_ids: string[];
  view_mode: LibraryViewMode;
  on_selection_change: (asset_ids: Set<string>) => void;
  on_move: (asset_ids: string[]) => void;
  on_drag_start: (asset_ids: string[]) => void;
  on_drag_end: () => void;
  on_delete: (asset: MediaAsset) => void;
  on_open_markers: (asset: MediaAsset) => void;
  on_open_summary: (asset: MediaAsset) => void;
};

const INTERACTIVE_SELECTOR =
  'a, button, input, select, textarea, [contenteditable="true"], [role="checkbox"], [role="menuitem"]';
const MARQUEE_DRAG_THRESHOLD = 3;

export function LibraryAssetCollection({
  assets,
  folders,
  selected_asset_ids,
  dragging_asset_ids,
  view_mode,
  on_selection_change,
  on_move,
  on_drag_start,
  on_drag_end,
  on_delete,
  on_open_markers,
  on_open_summary,
}: LibraryAssetCollectionProps) {
  const selection_anchor_id = useRef<string | null>(null);
  const marquee_gesture = useRef<MarqueeGesture | null>(null);
  const [selection_rectangle, set_selection_rectangle] =
    useState<SelectionRectangle | null>(null);

  useEffect(() => {
    const visible_asset_ids = new Set(assets.map((asset) => asset.asset_id));
    const visible_selection = new Set(
      [...selected_asset_ids].filter((asset_id) =>
        visible_asset_ids.has(asset_id),
      ),
    );
    if (visible_selection.size !== selected_asset_ids.size) {
      on_selection_change(visible_selection);
    }
    if (
      selection_anchor_id.current &&
      !visible_asset_ids.has(selection_anchor_id.current)
    ) {
      selection_anchor_id.current = null;
    }
  }, [assets, on_selection_change, selected_asset_ids]);

  function select_all_assets() {
    on_selection_change(new Set(assets.map((asset) => asset.asset_id)));
    selection_anchor_id.current = assets.at(-1)?.asset_id ?? null;
  }

  function clear_selection() {
    on_selection_change(new Set());
    selection_anchor_id.current = null;
  }

  function select_asset(
    asset_id: string,
    options: { additive: boolean; range: boolean },
  ) {
    const visible_asset_ids = assets.map((asset) => asset.asset_id);
    const asset_index = visible_asset_ids.indexOf(asset_id);
    const anchor_index = selection_anchor_id.current
      ? visible_asset_ids.indexOf(selection_anchor_id.current)
      : -1;

    if (options.range && anchor_index >= 0 && asset_index >= 0) {
      const range_start = Math.min(anchor_index, asset_index);
      const range_end = Math.max(anchor_index, asset_index);
      const next = options.additive
        ? new Set(selected_asset_ids)
        : new Set<string>();
      visible_asset_ids
        .slice(range_start, range_end + 1)
        .forEach((visible_asset_id) => next.add(visible_asset_id));
      on_selection_change(next);
    } else if (options.additive) {
      const next = new Set(selected_asset_ids);
      if (next.has(asset_id)) next.delete(asset_id);
      else next.add(asset_id);
      on_selection_change(next);
    } else if (!selected_asset_ids.has(asset_id)) {
      on_selection_change(new Set([asset_id]));
    }
    selection_anchor_id.current = asset_id;
  }

  function handle_pointer_down(event: PointerEvent<HTMLDivElement>) {
    if (
      event.button !== 0 ||
      (event.pointerType && event.pointerType !== "mouse")
    ) {
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    if (!target || target.closest(INTERACTIVE_SELECTOR)) return;

    event.currentTarget.focus({ preventScroll: true });
    const asset_card = target.closest<HTMLElement>("[data-library-asset-id]");
    if (asset_card?.dataset.libraryAssetId) {
      select_asset(asset_card.dataset.libraryAssetId, {
        additive: event.ctrlKey || event.metaKey,
        range: event.shiftKey,
      });
      return;
    }

    event.preventDefault();
    const base_selection =
      event.ctrlKey || event.metaKey
        ? new Set(selected_asset_ids)
        : new Set<string>();
    marquee_gesture.current = {
      pointer_id: event.pointerId,
      start_x: event.clientX,
      start_y: event.clientY,
      base_selection,
    };
    on_selection_change(base_selection);
    selection_anchor_id.current = null;
    set_selection_rectangle(null);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function handle_pointer_move(event: PointerEvent<HTMLDivElement>) {
    const gesture = marquee_gesture.current;
    if (!gesture || gesture.pointer_id !== event.pointerId) return;
    const horizontal_distance = Math.abs(event.clientX - gesture.start_x);
    const vertical_distance = Math.abs(event.clientY - gesture.start_y);
    if (
      horizontal_distance < MARQUEE_DRAG_THRESHOLD &&
      vertical_distance < MARQUEE_DRAG_THRESHOLD
    ) {
      return;
    }

    const selection_bounds = normalized_rectangle(
      gesture.start_x,
      gesture.start_y,
      event.clientX,
      event.clientY,
    );
    const container_bounds = event.currentTarget.getBoundingClientRect();
    set_selection_rectangle({
      left: selection_bounds.left - container_bounds.left,
      top: selection_bounds.top - container_bounds.top,
      width: selection_bounds.width,
      height: selection_bounds.height,
    });

    const next = new Set(gesture.base_selection);
    event.currentTarget
      .querySelectorAll<HTMLElement>("[data-library-asset-id]")
      .forEach((card) => {
        const asset_id = card.dataset.libraryAssetId;
        if (
          asset_id &&
          rectangles_intersect(selection_bounds, card.getBoundingClientRect())
        ) {
          next.add(asset_id);
        }
      });
    on_selection_change(next);
  }

  function finish_marquee_selection(event: PointerEvent<HTMLDivElement>) {
    const gesture = marquee_gesture.current;
    if (!gesture || gesture.pointer_id !== event.pointerId) return;
    marquee_gesture.current = null;
    set_selection_rectangle(null);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handle_key_down(event: KeyboardEvent<HTMLDivElement>) {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.matches("input, textarea, [contenteditable='true']")) return;

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      select_all_assets();
    } else if (event.key === "Escape") {
      clear_selection();
    }
  }

  function handle_context_menu(event: MouseEvent<HTMLDivElement>) {
    const target = event.target instanceof Element ? event.target : null;
    const asset_card = target?.closest<HTMLElement>("[data-library-asset-id]");
    const asset_id = asset_card?.dataset.libraryAssetId;
    if (asset_id && !selected_asset_ids.has(asset_id)) {
      on_selection_change(new Set([asset_id]));
      selection_anchor_id.current = asset_id;
    }
  }

  function handle_drag_start(
    event: DragEvent<HTMLDivElement>,
    asset: MediaAsset,
  ) {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(INTERACTIVE_SELECTOR)) {
      event.preventDefault();
      return;
    }

    const dragged_ids = selected_asset_ids.has(asset.asset_id)
      ? [...selected_asset_ids]
      : [asset.asset_id];
    if (!selected_asset_ids.has(asset.asset_id)) {
      on_selection_change(new Set(dragged_ids));
      selection_anchor_id.current = asset.asset_id;
    }
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", asset.title);
    on_drag_start(dragged_ids);
  }

  const selected_count = selected_asset_ids.size;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className="relative rounded-xl outline-none select-none focus-visible:ring-2 focus-visible:ring-focus-subtle"
          role="region"
          aria-label="视频选择区域"
          tabIndex={0}
          onPointerDown={handle_pointer_down}
          onPointerMove={handle_pointer_move}
          onPointerUp={finish_marquee_selection}
          onPointerCancel={finish_marquee_selection}
          onKeyDown={handle_key_down}
          onContextMenu={handle_context_menu}
        >
          <p className="sr-only" aria-live="polite">
            {selected_count > 0
              ? `已选择 ${selected_count} 个视频`
              : "未选择视频"}
          </p>
          <div
            className={cn(
              view_mode === "grid"
                ? "grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"
                : "flex flex-col gap-3",
            )}
          >
            {assets.map((asset) => (
              <div
                key={asset.asset_id}
                draggable
                className={cn(
                  "cursor-grab rounded-xl active:cursor-grabbing",
                  dragging_asset_ids.includes(asset.asset_id) && "opacity-60",
                )}
                onDragStart={(event) => handle_drag_start(event, asset)}
                onDragEnd={on_drag_end}
              >
                <LibraryVideoCard
                  asset={asset}
                  selected={selected_asset_ids.has(asset.asset_id)}
                  view_mode={view_mode}
                  folder_name={
                    folders.find(
                      (folder) => folder.folder_id === asset.folder_id,
                    )?.name ?? "未分类"
                  }
                  on_selected_change={(selected) => {
                    const next = new Set(selected_asset_ids);
                    if (selected) {
                      next.add(asset.asset_id);
                      selection_anchor_id.current = asset.asset_id;
                    } else {
                      next.delete(asset.asset_id);
                    }
                    on_selection_change(next);
                  }}
                  on_move={() => on_move([asset.asset_id])}
                  on_delete={() => on_delete(asset)}
                  on_open_markers={() => on_open_markers(asset)}
                  on_open_summary={() => on_open_summary(asset)}
                />
              </div>
            ))}
          </div>
          {selection_rectangle ? (
            <div
              className="pointer-events-none absolute rounded-sm border border-primary bg-primary-muted"
              style={selection_rectangle satisfies CSSProperties}
              aria-hidden="true"
            />
          ) : null}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuLabel>
          {selected_count > 0
            ? `已选择 ${selected_count} 个视频`
            : "当前搜索结果"}
        </ContextMenuLabel>
        <ContextMenuSeparator />
        <ContextMenuGroup>
          <ContextMenuItem
            disabled={selected_count === 0}
            onSelect={() => on_move([...selected_asset_ids])}
          >
            <FolderInput />
            移动所选
          </ContextMenuItem>
          <ContextMenuItem onSelect={select_all_assets}>
            <CheckSquare />
            全选当前结果
          </ContextMenuItem>
          <ContextMenuItem
            disabled={selected_count === 0}
            onSelect={clear_selection}
          >
            <X />
            取消选择
          </ContextMenuItem>
        </ContextMenuGroup>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function normalized_rectangle(
  start_x: number,
  start_y: number,
  end_x: number,
  end_y: number,
): SelectionRectangle & { right: number; bottom: number } {
  const left = Math.min(start_x, end_x);
  const top = Math.min(start_y, end_y);
  const right = Math.max(start_x, end_x);
  const bottom = Math.max(start_y, end_y);
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  };
}

function rectangles_intersect(
  first: { left: number; top: number; right: number; bottom: number },
  second: { left: number; top: number; right: number; bottom: number },
) {
  return !(
    first.right < second.left ||
    first.left > second.right ||
    first.bottom < second.top ||
    first.top > second.bottom
  );
}
