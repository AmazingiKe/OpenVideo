import {
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";

import type { LibraryFolder, MediaAsset } from "@/shared/types";
import {
  normalized_rectangle,
  rectangles_intersect,
  type SelectionRectangle,
} from "./library_browser_geometry";

type FocusedItem =
  { kind: "folder"; id: string } | { kind: "video"; id: string } | null;

type ContextTarget = "background" | FocusedItem;

type MarqueeGesture = {
  pointer_id: number;
  start_x: number;
  start_y: number;
  base_selection: Set<string>;
};

type LibraryBrowserSelectionOptions = {
  assets: MediaAsset[];
  current_folder: LibraryFolder | undefined;
  current_folder_id: string | null;
  deferred_search: string;
  folders: LibraryFolder[];
  open_asset: (asset: MediaAsset) => Promise<void>;
  set_current_folder_id: (folder_id: string | null) => void;
};

const SEARCH_INPUT_SELECTOR =
  'input, textarea, select, [contenteditable="true"]';
const LIBRARY_ITEM_SELECTOR = '[data-library-item="true"]';
const MARQUEE_DRAG_THRESHOLD_PX = 3;

export function use_library_browser_selection({
  assets,
  current_folder,
  current_folder_id,
  deferred_search,
  folders,
  open_asset,
  set_current_folder_id,
}: LibraryBrowserSelectionOptions) {
  const [selected_folder_id, set_selected_folder_id] = useState<string | null>(
    null,
  );
  const [selected_asset_ids, set_selected_asset_ids] = useState<Set<string>>(
    new Set(),
  );
  const [focused_item, set_focused_item] = useState<FocusedItem>(null);
  const [context_target, set_context_target] =
    useState<ContextTarget>("background");
  const [dragging_asset_ids, set_dragging_asset_ids] = useState<string[]>([]);
  const [drop_folder_id, set_drop_folder_id] = useState<string | null>(null);
  const [selection_rectangle, set_selection_rectangle] =
    useState<SelectionRectangle | null>(null);
  const selection_anchor_id_ref = useRef<string | null>(null);
  const marquee_gesture_ref = useRef<MarqueeGesture | null>(null);

  const all_visible_videos_selected =
    assets.length > 0 && selected_asset_ids.size === assets.length;
  const context_folder =
    context_target !== "background" && context_target?.kind === "folder"
      ? (folders.find((folder) => folder.folder_id === context_target.id) ??
        null)
      : null;
  const context_asset =
    context_target !== "background" && context_target?.kind === "video"
      ? (assets.find((asset) => asset.asset_id === context_target.id) ?? null)
      : null;

  useEffect(() => {
    const visible_asset_ids = new Set(assets.map((asset) => asset.asset_id));
    set_selected_asset_ids((current) => {
      const next = new Set(
        [...current].filter((asset_id) => visible_asset_ids.has(asset_id)),
      );
      return next.size === current.size ? current : next;
    });
    if (
      selection_anchor_id_ref.current &&
      !visible_asset_ids.has(selection_anchor_id_ref.current)
    ) {
      selection_anchor_id_ref.current = null;
    }
  }, [assets]);

  function clear_selection() {
    set_selected_folder_id(null);
    set_selected_asset_ids(new Set());
    selection_anchor_id_ref.current = null;
  }

  function navigate_to_folder(folder_id: string | null) {
    set_current_folder_id(folder_id);
    set_focused_item(null);
    clear_selection();
  }

  function navigate_to_parent() {
    if (deferred_search) return;
    navigate_to_folder(current_folder?.parent_id ?? null);
  }

  function select_folder(folder_id: string) {
    set_selected_folder_id(folder_id);
    set_selected_asset_ids(new Set());
    selection_anchor_id_ref.current = null;
    set_focused_item({ kind: "folder", id: folder_id });
  }

  function select_video(
    asset_id: string,
    options: { additive: boolean; range: boolean },
  ) {
    const visible_asset_ids = assets.map((asset) => asset.asset_id);
    const asset_index = visible_asset_ids.indexOf(asset_id);
    const anchor_index = selection_anchor_id_ref.current
      ? visible_asset_ids.indexOf(selection_anchor_id_ref.current)
      : -1;
    let next: Set<string>;

    if (options.range && anchor_index >= 0 && asset_index >= 0) {
      const range_start = Math.min(anchor_index, asset_index);
      const range_end = Math.max(anchor_index, asset_index);
      next = options.additive ? new Set(selected_asset_ids) : new Set<string>();
      visible_asset_ids
        .slice(range_start, range_end + 1)
        .forEach((visible_asset_id) => next.add(visible_asset_id));
    } else if (options.additive) {
      next = new Set(selected_asset_ids);
      if (next.has(asset_id)) next.delete(asset_id);
      else next.add(asset_id);
    } else {
      next = new Set([asset_id]);
    }

    set_selected_folder_id(null);
    set_selected_asset_ids(next);
    selection_anchor_id_ref.current = asset_id;
    set_focused_item({ kind: "video", id: asset_id });
  }

  function select_all_videos() {
    if (all_visible_videos_selected) {
      clear_selection();
      return;
    }
    set_selected_folder_id(null);
    set_selected_asset_ids(new Set(assets.map((asset) => asset.asset_id)));
    const last_asset_id = assets.at(-1)?.asset_id ?? null;
    selection_anchor_id_ref.current = last_asset_id;
    set_focused_item(
      last_asset_id ? { kind: "video", id: last_asset_id } : null,
    );
  }

  function open_focused_item(item: FocusedItem) {
    if (!item) return;
    if (item.kind === "folder") {
      navigate_to_folder(item.id);
      return;
    }
    const asset = assets.find((candidate) => candidate.asset_id === item.id);
    if (asset) void open_asset(asset);
  }

  function handle_key_down(event: KeyboardEvent<HTMLDivElement>) {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.matches(SEARCH_INPUT_SELECTOR)) return;
    const target_item = target?.closest<HTMLElement>(LIBRARY_ITEM_SELECTOR);
    const target_kind = target_item?.dataset.libraryKind;
    const target_id = target_item?.dataset.libraryId;
    const keyboard_item: FocusedItem =
      target_id && (target_kind === "folder" || target_kind === "video")
        ? { kind: target_kind, id: target_id }
        : focused_item;

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      select_all_videos();
      return;
    }
    if (event.key === "Escape") {
      clear_selection();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      open_focused_item(keyboard_item);
      return;
    }
    if (event.key === " " && keyboard_item?.kind === "video") {
      event.preventDefault();
      select_video(keyboard_item.id, { additive: true, range: false });
      return;
    }
    if (
      (event.key === "Backspace" ||
        (event.altKey && event.key === "ArrowLeft")) &&
      !deferred_search &&
      current_folder_id !== null
    ) {
      event.preventDefault();
      navigate_to_parent();
    }
  }

  function handle_pointer_down(event: PointerEvent<HTMLDivElement>) {
    if (
      event.button !== 0 ||
      (event.pointerType && event.pointerType !== "mouse")
    ) {
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("[data-library-item]")) return;

    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    const base_selection =
      event.ctrlKey || event.metaKey
        ? new Set(selected_asset_ids)
        : new Set<string>();
    marquee_gesture_ref.current = {
      pointer_id: event.pointerId,
      start_x: event.clientX,
      start_y: event.clientY,
      base_selection,
    };
    set_selected_folder_id(null);
    set_selected_asset_ids(base_selection);
    selection_anchor_id_ref.current = null;
    set_selection_rectangle(null);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function handle_pointer_move(event: PointerEvent<HTMLDivElement>) {
    const gesture = marquee_gesture_ref.current;
    if (!gesture || gesture.pointer_id !== event.pointerId) return;
    const horizontal_distance = Math.abs(event.clientX - gesture.start_x);
    const vertical_distance = Math.abs(event.clientY - gesture.start_y);
    if (
      horizontal_distance < MARQUEE_DRAG_THRESHOLD_PX &&
      vertical_distance < MARQUEE_DRAG_THRESHOLD_PX
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
      .querySelectorAll<HTMLElement>('[data-library-kind="video"]')
      .forEach((card) => {
        const asset_id = card.dataset.libraryId;
        if (
          asset_id &&
          rectangles_intersect(selection_bounds, card.getBoundingClientRect())
        ) {
          next.add(asset_id);
        }
      });
    set_selected_asset_ids(next);
  }

  function finish_marquee_selection(event: PointerEvent<HTMLDivElement>) {
    const gesture = marquee_gesture_ref.current;
    if (!gesture || gesture.pointer_id !== event.pointerId) return;
    marquee_gesture_ref.current = null;
    set_selection_rectangle(null);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handle_context_menu(event: MouseEvent<HTMLDivElement>) {
    const target = event.target instanceof Element ? event.target : null;
    const item = target?.closest<HTMLElement>("[data-library-item]");
    const item_id = item?.dataset.libraryId;
    const item_kind = item?.dataset.libraryKind;
    if (!item_id || (item_kind !== "folder" && item_kind !== "video")) {
      set_context_target("background");
      return;
    }
    const next_target = { kind: item_kind, id: item_id } as FocusedItem;
    set_context_target(next_target);
    set_focused_item(next_target);
    if (item_kind === "folder") {
      select_folder(item_id);
    } else if (!selected_asset_ids.has(item_id)) {
      select_video(item_id, { additive: false, range: false });
    }
  }

  function handle_video_drag_start(
    event: DragEvent<HTMLButtonElement>,
    asset: MediaAsset,
  ) {
    const dragged_ids = selected_asset_ids.has(asset.asset_id)
      ? [...selected_asset_ids]
      : [asset.asset_id];
    if (!selected_asset_ids.has(asset.asset_id)) {
      select_video(asset.asset_id, { additive: false, range: false });
    }
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", asset.title);
    set_dragging_asset_ids(dragged_ids);
  }

  function handle_folder_drag_over(
    event: DragEvent<HTMLButtonElement>,
    folder_id: string,
  ) {
    if (dragging_asset_ids.length === 0) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    set_drop_folder_id(folder_id);
  }

  return {
    all_visible_videos_selected,
    clear_selection,
    context_asset,
    context_folder,
    dragging_asset_ids,
    drop_folder_id,
    finish_marquee_selection,
    handle_context_menu,
    handle_folder_drag_over,
    handle_key_down,
    handle_pointer_down,
    handle_pointer_move,
    handle_video_drag_start,
    navigate_to_folder,
    navigate_to_parent,
    select_all_videos,
    select_folder,
    select_video,
    selected_asset_ids,
    selected_folder_id,
    selection_rectangle,
    set_dragging_asset_ids,
    set_drop_folder_id,
    set_focused_item,
  };
}
