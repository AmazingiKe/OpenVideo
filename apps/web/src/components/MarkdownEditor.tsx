import { useEffect, useMemo, useRef } from "react";
import { CrepeBuilder } from "@milkdown/crepe/builder";
import { blockEdit } from "@milkdown/crepe/feature/block-edit";
import { codeMirror } from "@milkdown/crepe/feature/code-mirror";
import { imageBlock } from "@milkdown/crepe/feature/image-block";
import { latex } from "@milkdown/crepe/feature/latex";
import { linkTooltip } from "@milkdown/crepe/feature/link-tooltip";
import { placeholder } from "@milkdown/crepe/feature/placeholder";
import { table } from "@milkdown/crepe/feature/table";
import { toolbar } from "@milkdown/crepe/feature/toolbar";
import { editorViewOptionsCtx } from "@milkdown/kit/core";
import { Plugin } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import { $prose, replaceAll } from "@milkdown/kit/utils";
import { Milkdown, MilkdownProvider, useEditor } from "@milkdown/react";
import "@milkdown/crepe/theme/common/style.css";

import { normalize_math_delimiters } from "./markdown_document";

export type MarkdownSelection = {
  start: number;
  end: number;
  text: string;
};

type MarkdownEditorProps = {
  document_key: string;
  markdown: string;
  on_change: (markdown: string) => void;
  on_selection_change: (selection: MarkdownSelection | null) => void;
  on_active_heading_change?: (heading_id: string | null) => void;
  target_heading_id?: string | null;
  on_target_heading_reached?: () => void;
  readonly?: boolean;
};

export function MarkdownEditor(props: MarkdownEditorProps) {
  return (
    <MilkdownProvider key={props.document_key}>
      <MarkdownEditorInner {...props} />
    </MilkdownProvider>
  );
}

function MarkdownEditorInner({
  markdown,
  on_change,
  on_selection_change,
  on_active_heading_change,
  on_target_heading_reached,
  target_heading_id,
  readonly = false,
}: MarkdownEditorProps) {
  const normalized_markdown = useMemo(
    () => normalize_math_delimiters(markdown),
    [markdown],
  );
  const change_ref = useRef(on_change);
  const selection_ref = useRef(on_selection_change);
  const active_heading_ref = useRef(on_active_heading_change);
  const controlled_markdown_ref = useRef(normalized_markdown);
  const editor_markdown_ref = useRef(normalized_markdown);
  const root_ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    change_ref.current = on_change;
    selection_ref.current = on_selection_change;
    active_heading_ref.current = on_active_heading_change;
    controlled_markdown_ref.current = normalized_markdown;
  }, [
    normalized_markdown,
    on_active_heading_change,
    on_change,
    on_selection_change,
  ]);

  const { get, loading } = useEditor(
    (root) => {
      const editor = new CrepeBuilder({
        root,
        defaultValue: normalized_markdown,
      })
        .addFeature(blockEdit)
        .addFeature(toolbar)
        .addFeature(linkTooltip)
        .addFeature(imageBlock)
        .addFeature(table)
        .addFeature(codeMirror, {
          copyText: "复制代码",
          noResultText: "未找到语言",
          previewLabel: "预览",
          previewLoading: "正在渲染…",
          previewToggleText: (preview_only) =>
            preview_only ? "编辑源码" : "隐藏预览",
          renderPreview: render_code_preview,
          searchPlaceholder: "搜索代码语言",
        })
        .addFeature(latex)
        .addFeature(placeholder, {
          text: "从这里开始整理视频知识…",
          mode: "block",
        })
        .setReadonly(readonly);
      editor.editor.use(task_checkbox_plugin);
      editor.editor.config((context) => {
        context.update(editorViewOptionsCtx, (options) => ({
          ...options,
          attributes: { "aria-label": "Markdown 文档编辑器" },
        }));
      });
      editor.on((listener) => {
        listener.markdownUpdated(
          (_context, next_markdown, previous_markdown) => {
            editor_markdown_ref.current = next_markdown;
            if (
              next_markdown !== previous_markdown &&
              next_markdown !== controlled_markdown_ref.current
            )
              change_ref.current(next_markdown);
          },
        );
        listener.selectionUpdated((_context, selection) => {
          if (selection.empty) {
            selection_ref.current(null);
            return;
          }
          const content = selection.content().content;
          selection_ref.current({
            start: selection.from,
            end: selection.to,
            text: content.textBetween(0, content.size, "\n"),
          });
        });
      });
      return editor;
    },
    [readonly],
  );

  useEffect(() => {
    if (loading || editor_markdown_ref.current === normalized_markdown) return;
    const editor = get();
    if (!editor) return;
    editor_markdown_ref.current = normalized_markdown;
    editor.action(replaceAll(normalized_markdown));
  }, [get, loading, normalized_markdown]);

  useEffect(() => {
    const root = root_ref.current;
    if (!root) return;
    const update_active_heading = () => {
      const headings = Array.from(
        root.querySelectorAll<HTMLHeadingElement>(
          ".ProseMirror h1[id], .ProseMirror h2[id], .ProseMirror h3[id], .ProseMirror h4[id], .ProseMirror h5[id], .ProseMirror h6[id]",
        ),
      );
      const threshold = root.getBoundingClientRect().top + 96;
      let active: string | null = null;
      let nearest_distance = Number.POSITIVE_INFINITY;
      for (const heading of headings) {
        const distance = Math.abs(
          heading.getBoundingClientRect().top - threshold,
        );
        if (distance >= nearest_distance) continue;
        nearest_distance = distance;
        active = heading.id || active;
      }
      active_heading_ref.current?.(active);
    };
    root.addEventListener("scroll", update_active_heading, { passive: true });
    const frame = window.requestAnimationFrame(update_active_heading);
    return () => {
      window.cancelAnimationFrame(frame);
      root.removeEventListener("scroll", update_active_heading);
    };
  }, [normalized_markdown]);

  useEffect(() => {
    if (!target_heading_id || loading) return;
    const root = root_ref.current;
    const target = Array.from(
      root?.querySelectorAll<HTMLHeadingElement>(
        ".ProseMirror h1[id], .ProseMirror h2[id], .ProseMirror h3[id], .ProseMirror h4[id], .ProseMirror h5[id], .ProseMirror h6[id]",
      ) ?? [],
    ).find((element) => element.id === target_heading_id);
    if (!target) return;
    target.tabIndex = -1;
    const reduced_motion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    target.scrollIntoView({
      behavior: reduced_motion ? "auto" : "smooth",
      block: "start",
    });
    target.focus({ preventScroll: true });
    active_heading_ref.current?.(target_heading_id);
    on_target_heading_reached?.();
  }, [loading, on_target_heading_reached, target_heading_id]);

  return (
    <div
      ref={root_ref}
      className="summary-milkdown min-h-0 flex-1 overflow-y-auto"
      aria-busy={loading}
    >
      <Milkdown />
    </div>
  );
}

const task_checkbox_plugin = $prose(
  () =>
    new Plugin({
      props: {
        decorations(state) {
          const checkboxes: Decoration[] = [];
          state.doc.descendants((node, position) => {
            if (node.type.name !== "list_item" || node.attrs.checked === null)
              return;
            const checked = Boolean(node.attrs.checked);
            checkboxes.push(
              Decoration.widget(
                position + 1,
                () => {
                  const checkbox = document.createElement("button");
                  checkbox.type = "button";
                  checkbox.className = "summary-task-checkbox";
                  checkbox.contentEditable = "false";
                  checkbox.dataset.position = String(position);
                  checkbox.dataset.state = checked ? "checked" : "unchecked";
                  checkbox.setAttribute("aria-pressed", String(checked));
                  checkbox.setAttribute(
                    "aria-label",
                    checked ? "标记为未完成" : "标记为已完成",
                  );
                  checkbox.textContent = checked ? "✓" : "";
                  checkbox.addEventListener("mousedown", (event) =>
                    event.preventDefault(),
                  );
                  return checkbox;
                },
                {
                  key: `task-checkbox-${position}-${checked}`,
                  side: -1,
                },
              ),
            );
          });
          return DecorationSet.create(state.doc, checkboxes);
        },
        handleDOMEvents: {
          click(view, event) {
            const target = event.target;
            if (!(target instanceof Element)) return false;
            const checkbox = target.closest<HTMLButtonElement>(
              ".summary-task-checkbox",
            );
            if (!checkbox) return false;
            event.preventDefault();
            if (!view.editable) return true;
            const position = Number(checkbox.dataset.position);
            const task_item = view.state.doc.nodeAt(position);
            if (
              !Number.isInteger(position) ||
              task_item?.type.name !== "list_item"
            )
              return true;
            view.dispatch(
              view.state.tr.setNodeMarkup(position, undefined, {
                ...task_item.attrs,
                checked: !task_item.attrs.checked,
              }),
            );
            return true;
          },
        },
      },
    }),
);

let mermaid_render_id = 0;

function render_code_preview(
  language: string,
  content: string,
  apply_preview: (preview: HTMLElement | string | null) => void,
): HTMLElement | null {
  if (language.toLocaleLowerCase() !== "mermaid" || !content.trim())
    return null;
  const loading = document.createElement("div");
  loading.className = "summary-diagram-status";
  loading.textContent = "正在渲染 Mermaid 图表…";
  mermaid_render_id += 1;
  const render_id = `openvideo-mermaid-${mermaid_render_id}`;
  void import("mermaid")
    .then(async ({ default: mermaid }) => {
      mermaid.initialize({
        securityLevel: "strict",
        startOnLoad: false,
        suppressErrorRendering: true,
        theme: document.documentElement.classList.contains("dark")
          ? "dark"
          : "default",
      });
      const { svg } = await mermaid.render(render_id, content);
      const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
      const diagram = document.createElement("div");
      diagram.className = "summary-mermaid";
      diagram.append(document.importNode(parsed.documentElement, true));
      apply_preview(diagram);
    })
    .catch((error: unknown) => {
      const message = document.createElement("div");
      message.className = "summary-diagram-error";
      message.setAttribute("role", "alert");
      message.textContent = `Mermaid 图表无法渲染：${
        error instanceof Error ? error.message : "语法无效"
      }`;
      apply_preview(message);
    });
  return loading;
}
