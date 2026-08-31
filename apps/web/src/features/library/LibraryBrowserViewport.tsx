import {
  type CSSProperties,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  DragDropProvider,
  DragOverlay,
  useDragOperation,
} from "@dnd-kit/react";
import {
  KeyboardSensor,
  PointerActivationConstraints,
  PointerSensor,
} from "@dnd-kit/dom";
import {
  type Rect,
  type Virtualizer,
  useVirtualizer,
} from "@tanstack/react-virtual";
import {
  type SelectionEvent,
  SelectionArea,
  useSelection,
} from "@viselect/react";

import { cn } from "@/lib/utils";
import type { LibraryFolder, MediaAsset } from "@/shared/types";
import {
  FolderItem,
  type LibraryFolderDropData,
  type LibraryVideoDragData,
  type LibraryViewMode,
  VideoItem,
} from "./LibraryBrowserItems";
import {
  create_library_browser_items,
  create_library_browser_rows,
  library_browser_column_count,
  library_item_row_index,
} from "./library_browser_rows";
import type { LibraryFocusedItem } from "./use_library_browser_selection";

const LIBRARY_VIRTUAL_OVERSCAN_ROWS = 3;
const LIBRARY_INITIAL_WIDE_WIDTH_PX = 960;
const LIBRARY_INITIAL_COMPACT_WIDTH_PX = 320;
const LIBRARY_INITIAL_VIEWPORT_HEIGHT_PX = 640;
const LIBRARY_LIST_ROW_ESTIMATE_PX = 88;
const LIBRARY_GRID_ROW_CONTENT_ESTIMATE_PX = 128;
const LIBRARY_POINTER_DISTANCE_PX = 5;
const LIBRARY_TOUCH_DELAY_MS = 250;
const LIBRARY_TOUCH_TOLERANCE_PX = 5;
const LIBRARY_VIDEO_SELECTOR = '[data-library-kind="video"]';

const LIBRARY_DND_SENSORS = [
  PointerSensor.configure({
    activationConstraints(event) {
      if (event.pointerType === "touch") {
        return [
          new PointerActivationConstraints.Delay({
            value: LIBRARY_TOUCH_DELAY_MS,
            tolerance: LIBRARY_TOUCH_TOLERANCE_PX,
          }),
        ];
      }
      return [
        new PointerActivationConstraints.Distance({
          value: LIBRARY_POINTER_DISTANCE_PX,
        }),
      ];
    },
  }),
  KeyboardSensor,
];

type LibraryBrowserViewportProps = {
  assets: MediaAsset[];
  compact: boolean;
  current_video_id: string | null;
  direct_folders: LibraryFolder[];
  scroll_element: HTMLDivElement | null;
  scroll_element_ref: RefObject<HTMLDivElement | null>;
  selected_asset_ids: Set<string>;
  selected_folder_id: string | null;
  thumbnail_size: number;
  view_mode: LibraryViewMode;
  move_assets_to_folder: (
    asset_ids: string[],
    folder_id: string,
  ) => Promise<boolean>;
  navigate_to_folder: (folder_id: string | null) => void;
  open_asset: (asset: MediaAsset) => Promise<void>;
  replace_video_selection: (asset_ids: Iterable<string>) => void;
  select_folder: (folder_id: string) => void;
  select_video: (
    asset_id: string,
    options: { additive: boolean; range: boolean },
  ) => void;
  set_focused_item: (item: LibraryFocusedItem) => void;
};

type ActiveDrag = {
  asset_ids: string[];
  title: string;
};

export function LibraryBrowserViewport({
  assets,
  compact,
  current_video_id,
  direct_folders,
  scroll_element,
  scroll_element_ref,
  selected_asset_ids,
  selected_folder_id,
  thumbnail_size,
  view_mode,
  move_assets_to_folder,
  navigate_to_folder,
  open_asset,
  replace_video_selection,
  select_folder,
  select_video,
  set_focused_item,
}: LibraryBrowserViewportProps) {
  const initial_width = compact
    ? LIBRARY_INITIAL_COMPACT_WIDTH_PX
    : LIBRARY_INITIAL_WIDE_WIDTH_PX;
  const [container_width, set_container_width] = useState(initial_width);
  const [active_drag, set_active_drag] = useState<ActiveDrag | null>(null);
  const [drag_announcement, set_drag_announcement] = useState("");
  const active_drag_ref = useRef<ActiveDrag | null>(null);
  const first_visible_item_id_ref = useRef<string | null>(null);
  const marquee_selection_ref = useRef<Set<string>>(new Set());

  const observe_viewport_rect = useCallback(
    (
      instance: Virtualizer<HTMLDivElement, HTMLDivElement>,
      callback: (rect: Rect) => void,
    ) => {
      const viewport_element = instance.scrollElement;
      if (!viewport_element) return;

      const report_rect = () => {
        const bounds = viewport_element.getBoundingClientRect();
        const width = bounds.width || initial_width;
        const height = bounds.height || LIBRARY_INITIAL_VIEWPORT_HEIGHT_PX;
        set_container_width(width);
        callback({ width, height });
      };

      report_rect();
      const observer = new ResizeObserver(report_rect);
      observer.observe(viewport_element);
      return () => observer.disconnect();
    },
    [initial_width],
  );

  const column_count =
    view_mode === "grid"
      ? library_browser_column_count(container_width, thumbnail_size)
      : 1;
  const items = useMemo(
    () => create_library_browser_items(direct_folders, assets),
    [assets, direct_folders],
  );
  const rows = useMemo(
    () => create_library_browser_rows(items, view_mode, column_count),
    [column_count, items, view_mode],
  );
  const rows_ref = useRef(rows);
  rows_ref.current = rows;
  const estimated_row_size =
    view_mode === "list"
      ? LIBRARY_LIST_ROW_ESTIMATE_PX
      : thumbnail_size * (9 / 16) + LIBRARY_GRID_ROW_CONTENT_ESTIMATE_PX;

  // TanStack Virtual 返回可变实例，React Compiler 不能安全地自动记忆化。
  // eslint-disable-next-line react-hooks/incompatible-library
  const row_virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: rows.length,
    getScrollElement: () => scroll_element_ref.current,
    estimateSize: () => estimated_row_size,
    measureElement: (element) =>
      element.getBoundingClientRect().height || estimated_row_size,
    observeElementRect: observe_viewport_rect,
    getItemKey: (index) => rows[index]?.key ?? index,
    overscan: LIBRARY_VIRTUAL_OVERSCAN_ROWS,
    useFlushSync: false,
    initialRect: {
      width: initial_width,
      height: LIBRARY_INITIAL_VIEWPORT_HEIGHT_PX,
    },
    onChange(instance) {
      const first_virtual_row = instance.getVirtualItems().at(0);
      const first_item = first_virtual_row
        ? rows_ref.current[first_virtual_row.index]?.items.at(0)
        : null;
      if (first_item) first_visible_item_id_ref.current = first_item.id;
    },
  });
  const virtual_rows = row_virtualizer.getVirtualItems();
  const virtual_range_key = virtual_rows
    .map((virtual_row) => virtual_row.key)
    .join("|");

  useLayoutEffect(() => {
    const anchor_id = first_visible_item_id_ref.current;
    if (!anchor_id) return;
    const row_index = library_item_row_index(rows, anchor_id);
    if (row_index >= 0) {
      row_virtualizer.scrollToIndex(row_index, { align: "start" });
    }
  }, [column_count, row_virtualizer, rows, thumbnail_size, view_mode]);

  function handle_selection_start({ event, selection }: SelectionEvent) {
    const keep_existing = Boolean(
      event instanceof MouseEvent && (event.ctrlKey || event.metaKey),
    );
    const initial_selection = keep_existing
      ? new Set(selected_asset_ids)
      : new Set<string>();
    marquee_selection_ref.current = initial_selection;
    selection.clearSelection(true, true);
    replace_video_selection(initial_selection);
  }

  function handle_selection_move({ store }: SelectionEvent) {
    const next = new Set(marquee_selection_ref.current);
    for (const element of store.changed.added) {
      const asset_id = library_asset_id(element);
      if (asset_id) next.add(asset_id);
    }
    for (const element of store.changed.removed) {
      const asset_id = library_asset_id(element);
      if (asset_id && element.isConnected) next.delete(asset_id);
    }
    marquee_selection_ref.current = next;
    replace_video_selection(next);
  }

  function handle_drag_start(event: DragStartEvent) {
    const source_data = library_video_drag_data(event.operation.source?.data);
    if (!source_data) return;
    const asset_ids = selected_asset_ids.has(source_data.asset_id)
      ? [...selected_asset_ids]
      : [source_data.asset_id];
    if (!selected_asset_ids.has(source_data.asset_id)) {
      select_video(source_data.asset_id, { additive: false, range: false });
    }
    const next_drag = { asset_ids, title: source_data.title };
    active_drag_ref.current = next_drag;
    set_active_drag(next_drag);
    set_drag_announcement(
      asset_ids.length === 1
        ? `开始移动“${source_data.title}”`
        : `开始移动 ${asset_ids.length} 个视频`,
    );
  }

  function handle_drag_over(event: DragOverEvent) {
    const target_data = library_folder_drop_data(event.operation.target?.data);
    set_drag_announcement(
      target_data ? `将移动到“${target_data.name}”` : "当前没有有效文件夹落点",
    );
  }

  function handle_drag_end(event: DragEndEvent) {
    void finish_drag(event);
  }

  async function finish_drag(event: DragEndEvent) {
    const drag = active_drag_ref.current;
    const target_data = library_folder_drop_data(event.operation.target?.data);
    active_drag_ref.current = null;
    set_active_drag(null);

    if (!drag || event.canceled || !target_data) {
      set_drag_announcement(event.canceled ? "已取消移动" : "未移动视频");
      return;
    }

    const moved = await move_assets_to_folder(
      drag.asset_ids,
      target_data.folder_id,
    );
    set_drag_announcement(
      moved
        ? `已移动 ${drag.asset_ids.length} 个视频到“${target_data.name}”`
        : `移动到“${target_data.name}”失败`,
    );
  }

  return (
    <DragDropProvider
      sensors={LIBRARY_DND_SENSORS}
      onDragStart={handle_drag_start}
      onDragOver={handle_drag_over}
      onDragEnd={handle_drag_end}
    >
      <SelectionArea
        className="library_browser_selection_surface min-h-full"
        boundaries={scroll_element ?? undefined}
        startAreas={scroll_element ?? undefined}
        selectables={LIBRARY_VIDEO_SELECTOR}
        selectionAreaClass="library_browser_selection_area"
        features={{ touch: false, singleTap: { allow: false } }}
        behaviour={{
          intersect: "touch",
          overlap: "keep",
          startThreshold: LIBRARY_POINTER_DISTANCE_PX,
        }}
        onBeforeStart={({ event }) => can_start_marquee(event)}
        onStart={handle_selection_start}
        onMove={handle_selection_move}
      >
        <SelectionRangeResolver range_key={virtual_range_key} />
        <div
          className="relative w-full"
          style={{ height: `${row_virtualizer.getTotalSize()}px` }}
          data-library-virtual-content="true"
        >
          {virtual_rows.map((virtual_row) => {
            const row = rows[virtual_row.index];
            if (!row) return null;
            return (
              <div
                key={virtual_row.key}
                ref={row_virtualizer.measureElement}
                className={cn(
                  "absolute top-0 left-0 grid w-full",
                  view_mode === "grid" ? "gap-3 pb-3" : "pb-2",
                )}
                data-index={virtual_row.index}
                data-library-virtual-row="true"
                style={
                  {
                    transform: `translateY(${virtual_row.start}px)`,
                    gridTemplateColumns:
                      view_mode === "grid"
                        ? `repeat(${column_count}, minmax(0, 1fr))`
                        : "minmax(0, 1fr)",
                  } satisfies CSSProperties
                }
              >
                {row.items.map((item) =>
                  item.kind === "folder" ? (
                    <FolderItem
                      key={item.id}
                      folder={item.folder}
                      view_mode={view_mode}
                      selected={selected_folder_id === item.id}
                      on_click={select_folder}
                      on_focus={() =>
                        set_focused_item({ kind: "folder", id: item.id })
                      }
                      on_open={navigate_to_folder}
                    />
                  ) : (
                    <VideoItem
                      key={item.id}
                      asset={item.asset}
                      view_mode={view_mode}
                      compact={compact}
                      current={item.id === current_video_id}
                      selected={selected_asset_ids.has(item.id)}
                      on_click={(click_event) =>
                        select_video(item.id, {
                          additive: click_event.ctrlKey || click_event.metaKey,
                          range: click_event.shiftKey,
                        })
                      }
                      on_focus={() =>
                        set_focused_item({ kind: "video", id: item.id })
                      }
                      on_open={() => void open_asset(item.asset)}
                    />
                  ),
                )}
              </div>
            );
          })}
        </div>
      </SelectionArea>

      <p className="sr-only" aria-live="assertive">
        {drag_announcement}
      </p>
      <LibraryDragOverlay active_drag={active_drag} />
    </DragDropProvider>
  );
}

function SelectionRangeResolver({ range_key }: { range_key: string }) {
  const selection = useSelection();

  useEffect(() => {
    selection?.resolveSelectables();
  }, [range_key, selection]);

  return null;
}

function LibraryDragOverlay({
  active_drag,
}: {
  active_drag: ActiveDrag | null;
}) {
  const operation = useDragOperation();
  const visible = Boolean(active_drag && operation.source);

  return (
    <DragOverlay dropAnimation={null}>
      {visible && active_drag ? (
        <div
          className="pointer-events-none max-w-72 rounded-lg border bg-popover px-3 py-2 text-sm font-medium text-popover-foreground shadow-lg"
          data-library-drag-overlay="true"
        >
          {active_drag.asset_ids.length === 1
            ? active_drag.title
            : `共 ${active_drag.asset_ids.length} 个视频`}
        </div>
      ) : null}
    </DragOverlay>
  );
}

function can_start_marquee(event: MouseEvent | TouchEvent | null): boolean {
  if (!(event instanceof MouseEvent) || event.button !== 0) return false;
  const target = event.target instanceof Element ? event.target : null;
  return !target?.closest("[data-library-item], [data-library-drag-handle]");
}

function library_asset_id(element: Element): string | null {
  if (!(element instanceof HTMLElement)) return null;
  return element.dataset.libraryId ?? null;
}

function library_video_drag_data(value: unknown): LibraryVideoDragData | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Partial<LibraryVideoDragData>;
  return data.kind === "video" &&
    typeof data.asset_id === "string" &&
    typeof data.title === "string"
    ? (data as LibraryVideoDragData)
    : null;
}

function library_folder_drop_data(
  value: unknown,
): LibraryFolderDropData | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Partial<LibraryFolderDropData>;
  return data.kind === "folder" &&
    typeof data.folder_id === "string" &&
    typeof data.name === "string"
    ? (data as LibraryFolderDropData)
    : null;
}
