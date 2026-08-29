import {
  ChevronRight,
  Copy,
  FilePlus2,
  FileText,
  FolderTree,
  ListTree,
  Pencil,
  Search,
  Trash2,
} from "lucide-react";
import {
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from "react";

import {
  extract_markdown_headings,
  type MarkdownHeading,
} from "@/components/markdown_document";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type { SummaryDocument } from "@/shared/types";

const MAX_DOCUMENT_DEPTH = 2;
const DOCUMENT_DEPTH_PADDING = ["pl-2", "pl-6", "pl-10"] as const;
const OUTLINE_DEPTH_PADDING = [
  "pl-2",
  "pl-5",
  "pl-8",
  "pl-11",
  "pl-14",
  "pl-17",
] as const;

export type DocumentTreeRow = {
  depth: number;
  document: SummaryDocument;
  has_children: boolean;
};

export type DocumentPlacement = {
  parent_document_id: string;
  position: number;
};

type DropTarget = {
  document_id: string;
  edge: "before" | "inside" | "after";
};

export function SummaryDocumentNavigation({
  active_heading_id,
  documents,
  markdown,
  on_create,
  on_delete,
  on_duplicate,
  on_heading_select,
  on_move,
  on_rename,
  on_select,
  reordering,
  selected_document_id,
}: {
  active_heading_id: string | null;
  documents: SummaryDocument[];
  markdown: string;
  on_create: (parent_document_id: string) => void;
  on_delete: (document: SummaryDocument) => void;
  on_duplicate: (document: SummaryDocument) => void;
  on_heading_select: (heading_id: string) => void;
  on_move: (
    document_id: string,
    parent_document_id: string,
    position: number,
  ) => void;
  on_rename: (document: SummaryDocument, title: string) => void;
  on_select: (document_id: string) => void;
  reordering: boolean;
  selected_document_id: string;
}) {
  const selected_document = documents.find(
    (document) => document.document_id === selected_document_id,
  );
  const by_id = useMemo(
    () =>
      new Map(documents.map((document) => [document.document_id, document])),
    [documents],
  );
  const create_parent =
    selected_document &&
    document_depth(selected_document, by_id) < MAX_DOCUMENT_DEPTH
      ? selected_document.document_id
      : selected_document?.parent_document_id;

  return (
    <Tabs
      defaultValue="documents"
      className="h-full min-h-0 gap-0 bg-card"
      aria-label="总结导航"
    >
      <div className="flex items-center justify-between gap-2 border-b px-2 py-2">
        <TabsList variant="line" className="min-w-0 flex-1">
          <TabsTrigger value="documents">
            <FolderTree data-icon="inline-start" />
            文档
          </TabsTrigger>
          <TabsTrigger value="outline">
            <ListTree data-icon="inline-start" />
            大纲
          </TabsTrigger>
        </TabsList>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={!create_parent}
          onClick={() => create_parent && on_create(create_parent)}
          aria-label="新建子文档"
          title="新建子文档"
        >
          <FilePlus2 />
        </Button>
      </div>
      <TabsContent value="documents" className="min-h-0">
        <DocumentTree
          documents={documents}
          selected_document_id={selected_document_id}
          on_select={on_select}
          on_create={on_create}
          on_rename={on_rename}
          on_duplicate={on_duplicate}
          on_move={on_move}
          on_delete={on_delete}
          reordering={reordering}
        />
      </TabsContent>
      <TabsContent value="outline" className="min-h-0">
        <DocumentOutline
          markdown={markdown}
          active_heading_id={active_heading_id}
          on_select={on_heading_select}
        />
      </TabsContent>
    </Tabs>
  );
}

export function DocumentTree({
  documents,
  selected_document_id,
  on_select,
  on_create,
  on_rename,
  on_duplicate,
  on_move,
  reordering,
  on_delete,
}: {
  documents: SummaryDocument[];
  selected_document_id: string;
  on_select: (document_id: string) => void;
  on_create: (parent_document_id: string) => void;
  on_rename: (document: SummaryDocument, title: string) => void;
  on_duplicate: (document: SummaryDocument) => void;
  on_move: (
    document_id: string,
    parent_document_id: string,
    position: number,
  ) => void;
  reordering: boolean;
  on_delete: (document: SummaryDocument) => void;
}) {
  const [collapsed_ids, set_collapsed_ids] = useState<Set<string>>(new Set());
  const [editing_id, set_editing_id] = useState<string | null>(null);
  const [editing_title, set_editing_title] = useState("");
  const [dragged_id, set_dragged_id] = useState<string | null>(null);
  const [drop_target, set_drop_target] = useState<DropTarget | null>(null);
  const tree_ref = useRef<HTMLDivElement>(null);
  const rows = useMemo(
    () => build_document_tree_rows(documents, collapsed_ids),
    [collapsed_ids, documents],
  );
  function toggle_collapsed(document_id: string) {
    set_collapsed_ids((current) => {
      const next = new Set(current);
      if (next.has(document_id)) next.delete(document_id);
      else next.add(document_id);
      return next;
    });
  }

  function begin_rename(document: SummaryDocument) {
    set_editing_id(document.document_id);
    set_editing_title(document.title);
  }

  function finish_rename(document: SummaryDocument) {
    const title = editing_title.trim();
    set_editing_id(null);
    if (title && title !== document.title) on_rename(document, title);
  }

  function finish_drag() {
    set_dragged_id(null);
    set_drop_target(null);
  }

  function update_drop_target(
    event: DragEvent<HTMLDivElement>,
    target: SummaryDocument,
  ) {
    if (!dragged_id || reordering) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientY - bounds.top) / bounds.height;
    const edge = ratio < 0.3 ? "before" : ratio > 0.7 ? "after" : "inside";
    const placement = document_drop_placement(
      documents,
      dragged_id,
      target.document_id,
      edge,
    );
    if (!placement) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    set_drop_target({ document_id: target.document_id, edge });
  }

  function drop_document(target: DropTarget) {
    if (!dragged_id) return;
    const placement = document_drop_placement(
      documents,
      dragged_id,
      target.document_id,
      target.edge,
    );
    finish_drag();
    if (placement)
      on_move(dragged_id, placement.parent_document_id, placement.position);
  }

  function handle_tree_key(
    event: KeyboardEvent<HTMLDivElement>,
    row: DocumentTreeRow,
    index: number,
  ) {
    if (event.target instanceof HTMLInputElement) return;
    const items = Array.from(
      tree_ref.current?.querySelectorAll<HTMLDivElement>("[role=treeitem]") ??
        [],
    );
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const offset = event.key === "ArrowDown" ? 1 : -1;
      items[index + offset]?.focus();
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      items[event.key === "Home" ? 0 : items.length - 1]?.focus();
      return;
    }
    if (event.key === "ArrowRight" && row.has_children) {
      event.preventDefault();
      if (collapsed_ids.has(row.document.document_id))
        toggle_collapsed(row.document.document_id);
      else items[index + 1]?.focus();
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (row.has_children && !collapsed_ids.has(row.document.document_id)) {
        toggle_collapsed(row.document.document_id);
        return;
      }
      const parent_id = row.document.parent_document_id;
      if (parent_id)
        tree_ref.current
          ?.querySelector<HTMLDivElement>(`[data-document-id="${parent_id}"]`)
          ?.focus();
      return;
    }
    if (event.key === "F2") {
      event.preventDefault();
      begin_rename(row.document);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      on_select(row.document.document_id);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        ref={tree_ref}
        className="min-h-0 flex-1 overflow-y-auto p-2"
        role="tree"
        aria-label="文档树"
        aria-busy={reordering}
      >
        {rows.map((row, index) => {
          const document = row.document;
          const selected = document.document_id === selected_document_id;
          const is_root = document.parent_document_id === null;
          const depth_class = DOCUMENT_DEPTH_PADDING[row.depth] ?? "pl-10";
          const target_edge =
            drop_target?.document_id === document.document_id
              ? drop_target.edge
              : null;
          return (
            <ContextMenu key={document.document_id}>
              <ContextMenuTrigger asChild>
                <div
                  role="treeitem"
                  tabIndex={selected ? 0 : -1}
                  data-document-id={document.document_id}
                  aria-label={document.title}
                  aria-current={selected ? "page" : undefined}
                  aria-level={row.depth + 1}
                  aria-expanded={
                    row.has_children
                      ? !collapsed_ids.has(document.document_id)
                      : undefined
                  }
                  className={cn(
                    "group relative flex min-w-0 items-center rounded-md border-y-2 border-transparent focus-visible:ring-3 focus-visible:ring-focus-ring focus-visible:outline-none",
                    depth_class,
                    target_edge === "before" && "border-t-primary",
                    target_edge === "after" && "border-b-primary",
                    target_edge === "inside" && "bg-accent",
                    dragged_id === document.document_id && "opacity-50",
                  )}
                  onDragOver={(event) => update_drop_target(event, document)}
                  onDrop={(event) => {
                    event.preventDefault();
                    if (drop_target) drop_document(drop_target);
                  }}
                  onClick={() => on_select(document.document_id)}
                  onKeyDown={(event) => handle_tree_key(event, row, index)}
                >
                  {row.has_children ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      onClick={(event) => {
                        event.stopPropagation();
                        toggle_collapsed(document.document_id);
                      }}
                      aria-label={`${collapsed_ids.has(document.document_id) ? "展开" : "折叠"}${document.title}`}
                      tabIndex={-1}
                    >
                      <ChevronRight
                        className={cn(
                          "transition-transform",
                          !collapsed_ids.has(document.document_id) &&
                            "rotate-90",
                        )}
                      />
                    </Button>
                  ) : (
                    <span className="size-6 shrink-0" aria-hidden="true" />
                  )}
                  {editing_id === document.document_id ? (
                    <Input
                      autoFocus
                      value={editing_title}
                      onChange={(event) =>
                        set_editing_title(event.target.value)
                      }
                      onClick={(event) => event.stopPropagation()}
                      onBlur={() => finish_rename(document)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") finish_rename(document);
                        if (event.key === "Escape") set_editing_id(null);
                      }}
                      aria-label={`重命名 ${document.title}`}
                      className="h-7 min-w-0 flex-1"
                    />
                  ) : (
                    <Button
                      type="button"
                      variant={selected ? "secondary" : "ghost"}
                      className="min-w-0 flex-1 justify-start"
                      tabIndex={-1}
                      draggable={!is_root && !reordering}
                      onDoubleClick={() => begin_rename(document)}
                      onDragStart={(event) => {
                        if (is_root) return;
                        set_dragged_id(document.document_id);
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData(
                          "text/plain",
                          document.document_id,
                        );
                      }}
                      onDragEnd={finish_drag}
                    >
                      <FileText data-icon="inline-start" />
                      <span className="truncate">{document.title}</span>
                    </Button>
                  )}
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuGroup>
                  <ContextMenuItem
                    disabled={row.depth >= MAX_DOCUMENT_DEPTH}
                    onSelect={() => on_create(document.document_id)}
                  >
                    <FilePlus2 /> 新建子文档
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => begin_rename(document)}>
                    <Pencil /> 重命名
                    <ContextMenuShortcut>F2</ContextMenuShortcut>
                  </ContextMenuItem>
                  <ContextMenuItem
                    disabled={is_root}
                    onSelect={() => on_duplicate(document)}
                  >
                    <Copy /> 创建副本
                  </ContextMenuItem>
                </ContextMenuGroup>
                {!is_root ? (
                  <>
                    <ContextMenuSeparator />
                    <ContextMenuGroup>
                      <ContextMenuItem
                        variant="destructive"
                        onSelect={() => on_delete(document)}
                      >
                        <Trash2 /> 删除
                      </ContextMenuItem>
                    </ContextMenuGroup>
                  </>
                ) : null}
              </ContextMenuContent>
            </ContextMenu>
          );
        })}
      </div>
      <span className="sr-only" aria-live="polite">
        {reordering ? "正在保存文档结构" : ""}
      </span>
    </div>
  );
}

export function DocumentOutline({
  markdown,
  active_heading_id,
  on_select,
}: {
  markdown: string;
  active_heading_id: string | null;
  on_select: (heading_id: string) => void;
}) {
  const [query, set_query] = useState("");
  const [collapsed_ids, set_collapsed_ids] = useState<Set<string>>(new Set());
  const headings = useMemo(
    () => extract_markdown_headings(markdown),
    [markdown],
  );
  const nodes = useMemo(() => build_outline_nodes(headings), [headings]);
  const visible_ids = useMemo(
    () => outline_visible_ids(nodes, query),
    [nodes, query],
  );

  if (headings.length === 0) {
    return (
      <Empty className="h-full border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ListTree />
          </EmptyMedia>
          <EmptyTitle>暂无文档大纲</EmptyTitle>
          <EmptyDescription>添加 Markdown 标题后会自动生成。</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => set_query(event.target.value)}
            placeholder="搜索标题"
            aria-label="搜索文档大纲"
            className="pl-8"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2" role="tree">
        {nodes.map((node) => (
          <OutlineNode
            key={node.heading.id}
            node={node}
            active_heading_id={active_heading_id}
            collapsed_ids={collapsed_ids}
            visible_ids={visible_ids}
            on_select={on_select}
            on_toggle={(heading_id) =>
              set_collapsed_ids((current) => {
                const next = new Set(current);
                if (next.has(heading_id)) next.delete(heading_id);
                else next.add(heading_id);
                return next;
              })
            }
          />
        ))}
      </div>
    </div>
  );
}

type OutlineNodeValue = {
  heading: MarkdownHeading;
  children: OutlineNodeValue[];
};

function OutlineNode({
  node,
  active_heading_id,
  collapsed_ids,
  visible_ids,
  on_select,
  on_toggle,
}: {
  node: OutlineNodeValue;
  active_heading_id: string | null;
  collapsed_ids: Set<string>;
  visible_ids: Set<string>;
  on_select: (heading_id: string) => void;
  on_toggle: (heading_id: string) => void;
}) {
  if (!visible_ids.has(node.heading.id)) return null;
  const collapsed = collapsed_ids.has(node.heading.id);
  const depth_class = OUTLINE_DEPTH_PADDING[node.heading.level - 1] ?? "pl-17";
  return (
    <div role="none">
      <div className={cn("flex min-w-0 items-center", depth_class)}>
        {node.children.length > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => on_toggle(node.heading.id)}
            aria-label={`${collapsed ? "展开" : "折叠"}${node.heading.title}`}
            tabIndex={-1}
          >
            <ChevronRight
              className={cn("transition-transform", !collapsed && "rotate-90")}
            />
          </Button>
        ) : (
          <span className="size-6 shrink-0" aria-hidden="true" />
        )}
        <Button
          type="button"
          role="treeitem"
          variant={
            active_heading_id === node.heading.id ? "secondary" : "ghost"
          }
          className="min-w-0 flex-1 justify-start font-normal"
          onClick={() => on_select(node.heading.id)}
          aria-current={
            active_heading_id === node.heading.id ? "location" : undefined
          }
          aria-level={node.heading.level}
          aria-expanded={node.children.length > 0 ? !collapsed : undefined}
        >
          <span className="truncate">{node.heading.title}</span>
        </Button>
      </div>
      {!collapsed
        ? node.children.map((child) => (
            <OutlineNode
              key={child.heading.id}
              node={child}
              active_heading_id={active_heading_id}
              collapsed_ids={collapsed_ids}
              visible_ids={visible_ids}
              on_select={on_select}
              on_toggle={on_toggle}
            />
          ))
        : null}
    </div>
  );
}

export function build_document_tree_rows(
  documents: SummaryDocument[],
  collapsed_ids: Set<string> = new Set(),
): DocumentTreeRow[] {
  const children_by_parent = new Map<string | null, SummaryDocument[]>();
  for (const document of documents) {
    const siblings = children_by_parent.get(document.parent_document_id) ?? [];
    siblings.push(document);
    children_by_parent.set(document.parent_document_id, siblings);
  }
  for (const siblings of children_by_parent.values()) {
    siblings.sort(compare_documents);
  }
  const rows: DocumentTreeRow[] = [];
  function visit(parent_id: string | null, depth: number) {
    for (const document of children_by_parent.get(parent_id) ?? []) {
      const children = children_by_parent.get(document.document_id) ?? [];
      rows.push({
        depth,
        document,
        has_children: children.length > 0,
      });
      if (!collapsed_ids.has(document.document_id))
        visit(document.document_id, depth + 1);
    }
  }
  visit(null, 0);
  return rows;
}

export function document_drop_placement(
  documents: SummaryDocument[],
  dragged_document_id: string,
  target_document_id: string,
  edge: DropTarget["edge"],
): DocumentPlacement | null {
  if (dragged_document_id === target_document_id) return null;
  const by_id = new Map(
    documents.map((document) => [document.document_id, document]),
  );
  const dragged = by_id.get(dragged_document_id);
  const target = by_id.get(target_document_id);
  if (!dragged || !target || dragged.parent_document_id === null) return null;
  if (is_document_descendant(target, dragged_document_id, by_id)) return null;

  const parent_id =
    edge === "inside" ? target.document_id : target.parent_document_id;
  if (!parent_id) return null;
  const parent = by_id.get(parent_id);
  if (!parent) return null;
  const parent_depth = document_depth(parent, by_id);
  if (
    parent_depth + 1 + document_subtree_height(dragged_document_id, documents) >
    MAX_DOCUMENT_DEPTH
  )
    return null;

  const siblings = documents
    .filter(
      (document) =>
        document.parent_document_id === parent_id &&
        document.document_id !== dragged_document_id,
    )
    .sort(compare_documents);
  if (edge === "inside")
    return { parent_document_id: parent_id, position: siblings.length };
  const target_index = siblings.findIndex(
    (document) => document.document_id === target_document_id,
  );
  if (target_index < 0) return null;
  return {
    parent_document_id: parent_id,
    position: target_index + (edge === "after" ? 1 : 0),
  };
}

function document_depth(
  document: SummaryDocument,
  by_id: Map<string, SummaryDocument>,
): number {
  let depth = 0;
  let parent_id = document.parent_document_id;
  const visited = new Set<string>();
  while (parent_id) {
    if (visited.has(parent_id)) return MAX_DOCUMENT_DEPTH + 1;
    visited.add(parent_id);
    const parent = by_id.get(parent_id);
    if (!parent) return MAX_DOCUMENT_DEPTH + 1;
    depth += 1;
    parent_id = parent.parent_document_id;
  }
  return depth;
}

function document_subtree_height(
  document_id: string,
  documents: SummaryDocument[],
): number {
  const children = documents.filter(
    (document) => document.parent_document_id === document_id,
  );
  if (children.length === 0) return 0;
  return (
    1 +
    Math.max(
      ...children.map((document) =>
        document_subtree_height(document.document_id, documents),
      ),
    )
  );
}

function is_document_descendant(
  document: SummaryDocument,
  ancestor_id: string,
  by_id: Map<string, SummaryDocument>,
): boolean {
  let parent_id = document.parent_document_id;
  while (parent_id) {
    if (parent_id === ancestor_id) return true;
    parent_id = by_id.get(parent_id)?.parent_document_id ?? null;
  }
  return false;
}

function compare_documents(left: SummaryDocument, right: SummaryDocument) {
  return (
    left.position - right.position ||
    left.created_at.localeCompare(right.created_at)
  );
}

function build_outline_nodes(headings: MarkdownHeading[]): OutlineNodeValue[] {
  const roots: OutlineNodeValue[] = [];
  const stack: OutlineNodeValue[] = [];
  for (const heading of headings) {
    const node = { heading, children: [] };
    while (
      stack.length > 0 &&
      stack[stack.length - 1]!.heading.level >= heading.level
    )
      stack.pop();
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else roots.push(node);
    stack.push(node);
  }
  return roots;
}

function outline_visible_ids(
  nodes: OutlineNodeValue[],
  query: string,
): Set<string> {
  const normalized = query.trim().toLocaleLowerCase();
  const visible = new Set<string>();
  function visit(node: OutlineNodeValue): boolean {
    let child_matches = false;
    for (const child of node.children) {
      if (visit(child)) child_matches = true;
    }
    const matches = node.heading.title.toLocaleLowerCase().includes(normalized);
    if (!normalized || matches || child_matches) visible.add(node.heading.id);
    return matches || child_matches;
  }
  nodes.forEach(visit);
  return visible;
}
