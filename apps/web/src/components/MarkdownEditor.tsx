import { useEffect, useMemo, useRef, useState } from "react";
import { CrepeBuilder } from "@milkdown/crepe/builder";
import { blockEdit } from "@milkdown/crepe/feature/block-edit";
import { codeMirror } from "@milkdown/crepe/feature/code-mirror";
import { imageBlock } from "@milkdown/crepe/feature/image-block";
import { latex } from "@milkdown/crepe/feature/latex";
import { linkTooltip } from "@milkdown/crepe/feature/link-tooltip";
import { placeholder } from "@milkdown/crepe/feature/placeholder";
import { table } from "@milkdown/crepe/feature/table";
import { toolbar } from "@milkdown/crepe/feature/toolbar";
import { toggleLinkCommand } from "@milkdown/kit/component/link-tooltip";
import type { Ctx } from "@milkdown/kit/ctx";
import {
  commandsCtx,
  editorViewCtx,
  editorViewOptionsCtx,
  schemaCtx,
} from "@milkdown/kit/core";
import { lift } from "@milkdown/kit/prose/commands";
import { liftListItem } from "@milkdown/kit/prose/schema-list";
import { Plugin, Selection, TextSelection } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import {
  blockquoteSchema,
  bulletListSchema,
  codeBlockSchema,
  emphasisSchema,
  headingSchema,
  inlineCodeSchema,
  isMarkSelectedCommand,
  isNodeSelectedCommand,
  linkSchema,
  listItemSchema,
  orderedListSchema,
  paragraphSchema,
  setBlockTypeCommand,
  strongSchema,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  toggleStrongCommand,
  wrapInBlockTypeCommand,
} from "@milkdown/kit/preset/commonmark";
import {
  strikethroughSchema,
  toggleStrikethroughCommand,
} from "@milkdown/kit/preset/gfm";
import { $prose, replaceAll } from "@milkdown/kit/utils";
import { Milkdown, MilkdownProvider, useEditor } from "@milkdown/react";
import "@milkdown/crepe/theme/common/style.css";

import {
  EMPTY_MARKDOWN_FORMATTING_STATE,
  MarkdownEditorContextMenu,
  type MarkdownBlockStyle,
  type MarkdownFormattingState,
  type MarkdownInlineStyle,
} from "./MarkdownEditorContextMenu";
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
  const [has_format_selection, set_has_format_selection] = useState(false);
  const [formatting_state, set_formatting_state] =
    useState<MarkdownFormattingState>(EMPTY_MARKDOWN_FORMATTING_STATE);

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
        .addFeature(blockEdit, {
          textGroup: {
            label: "文本",
            text: { label: "正文" },
            h1: { label: "一级标题" },
            h2: { label: "二级标题" },
            h3: { label: "三级标题" },
            h4: { label: "四级标题" },
            h5: { label: "五级标题" },
            h6: { label: "六级标题" },
            quote: { label: "引用" },
            divider: { label: "分隔线" },
          },
          listGroup: {
            label: "列表",
            bulletList: { label: "项目列表" },
            orderedList: { label: "编号列表" },
            taskList: { label: "任务列表" },
          },
          advancedGroup: {
            label: "插入",
            image: { label: "图片" },
            codeBlock: { label: "代码块" },
            table: { label: "表格" },
            math: { label: "公式块" },
          },
        })
        .addFeature(toolbar, {
          boldLabel: "粗体",
          italicLabel: "斜体",
          strikethroughLabel: "删除线",
          codeLabel: "行内代码",
          latexLabel: "行内公式",
          linkLabel: "链接",
        })
        .addFeature(linkTooltip, {
          inputPlaceholder: "粘贴链接…",
        })
        .addFeature(imageBlock, {
          inlineUploadButton: "上传",
          inlineUploadPlaceholderText: "或粘贴图片链接",
          blockUploadButton: "上传图片",
          blockConfirmButton: "确认",
          blockCaptionPlaceholderText: "填写图片说明",
          blockUploadPlaceholderText: "或粘贴图片链接",
        })
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
        listener.selectionUpdated((context, selection) => {
          if (selection.empty) {
            set_has_format_selection(false);
            selection_ref.current(null);
            return;
          }
          const content = selection.content().content;
          const selected_text = content.textBetween(0, content.size, "\n");
          const has_selected_text = selected_text.trim().length > 0;
          set_has_format_selection(has_selected_text);
          if (has_selected_text)
            set_formatting_state(read_formatting_state(context));
          selection_ref.current({
            start: selection.from,
            end: selection.to,
            text: selected_text,
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

  const refresh_formatting_state = () => {
    const editor = get();
    if (!editor) return;
    editor.action((context) => {
      set_formatting_state(read_formatting_state(context));
    });
  };

  const apply_inline_style = (style: MarkdownInlineStyle) => {
    const editor = get();
    if (!editor) return;
    editor.action((context) => {
      run_inline_style(context, style);
      set_formatting_state(read_formatting_state(context));
    });
  };

  const apply_block_style = (style: MarkdownBlockStyle) => {
    const editor = get();
    if (!editor) return;
    editor.action((context) => {
      run_block_style(context, style);
      set_formatting_state(read_formatting_state(context));
    });
  };

  return (
    <MarkdownEditorContextMenu
      enabled={!readonly && !loading && has_format_selection}
      formatting_state={formatting_state}
      on_inline_style={apply_inline_style}
      on_block_style={apply_block_style}
      on_open_change={(open) => {
        if (open) refresh_formatting_state();
      }}
    >
      <div
        ref={root_ref}
        className="summary-milkdown min-h-0 flex-1 overflow-y-auto"
        aria-busy={loading}
      >
        <Milkdown />
      </div>
    </MarkdownEditorContextMenu>
  );
}

const MATH_INLINE_NODE_NAME = "math_inline";
const TOGGLE_LATEX_COMMAND_NAME = "ToggleLatex";
const MAX_WRAPPER_LIFT_DEPTH = 8;

function read_formatting_state(context: Ctx): MarkdownFormattingState {
  const commands = context.get(commandsCtx);
  const schema = context.get(schemaCtx);
  const math_inline = schema.nodes[MATH_INLINE_NODE_NAME];
  return {
    block_style: selected_block_style(context),
    bold: commands.call(isMarkSelectedCommand.key, strongSchema.type(context)),
    italic: commands.call(
      isMarkSelectedCommand.key,
      emphasisSchema.type(context),
    ),
    strikethrough: commands.call(
      isMarkSelectedCommand.key,
      strikethroughSchema.type(context),
    ),
    inline_code: commands.call(
      isMarkSelectedCommand.key,
      inlineCodeSchema.type(context),
    ),
    inline_math: math_inline
      ? commands.call(isNodeSelectedCommand.key, math_inline)
      : false,
    link: commands.call(isMarkSelectedCommand.key, linkSchema.type(context)),
  };
}

function selected_block_style(context: Ctx): MarkdownBlockStyle {
  const view = context.get(editorViewCtx);
  const { $from } = view.state.selection;
  const heading = headingSchema.type(context);
  const code_block = codeBlockSchema.type(context);
  const blockquote = blockquoteSchema.type(context);
  const bullet_list = bulletListSchema.type(context);
  const ordered_list = orderedListSchema.type(context);
  const list_item = listItemSchema.type(context);
  let task_list = false;
  let quote = false;

  for (let depth = $from.depth; depth >= 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.type === list_item && node.attrs.checked !== null)
      task_list = true;
    if (node.type === ordered_list) return "ordered-list";
    if (node.type === bullet_list)
      return task_list ? "task-list" : "bullet-list";
    if (node.type === blockquote) quote = true;
  }

  if ($from.depth === 0) {
    const first_selected_node =
      view.state.doc.nodeAt(view.state.selection.from) ??
      view.state.doc.firstChild;
    if (first_selected_node?.type === ordered_list) return "ordered-list";
    if (first_selected_node?.type === bullet_list) {
      const first_list_item = first_selected_node.firstChild;
      return first_list_item?.attrs.checked !== null
        ? "task-list"
        : "bullet-list";
    }
    if (first_selected_node?.type === blockquote) return "quote";
    if (first_selected_node?.type === heading) {
      const level = Number(first_selected_node.attrs.level);
      if (level === 1) return "heading-1";
      if (level === 2) return "heading-2";
      if (level === 3) return "heading-3";
    }
    if (first_selected_node?.type === code_block) return "code-block";
  }

  if (quote) return "quote";
  if ($from.parent.type === heading) {
    const level = Number($from.parent.attrs.level);
    if (level === 1) return "heading-1";
    if (level === 2) return "heading-2";
    if (level === 3) return "heading-3";
  }
  if ($from.parent.type === code_block) return "code-block";
  return "paragraph";
}

function run_inline_style(context: Ctx, style: MarkdownInlineStyle) {
  const commands = context.get(commandsCtx);
  switch (style) {
    case "bold":
      commands.call(toggleStrongCommand.key);
      return;
    case "italic":
      commands.call(toggleEmphasisCommand.key);
      return;
    case "strikethrough":
      commands.call(toggleStrikethroughCommand.key);
      return;
    case "inline-code":
      commands.call(toggleInlineCodeCommand.key);
      return;
    case "inline-math":
      commands.call(TOGGLE_LATEX_COMMAND_NAME);
      return;
    case "link":
      commands.call(toggleLinkCommand.key);
  }
}

function run_block_style(context: Ctx, style: MarkdownBlockStyle) {
  select_nonempty_document_content(context);
  lift_selected_wrappers(context);
  const commands = context.get(commandsCtx);
  switch (style) {
    case "paragraph":
      commands.call(setBlockTypeCommand.key, {
        nodeType: paragraphSchema.type(context),
      });
      return;
    case "heading-1":
    case "heading-2":
    case "heading-3":
      commands.call(setBlockTypeCommand.key, {
        nodeType: headingSchema.type(context),
        attrs: { level: Number(style.at(-1)) },
      });
      return;
    case "quote":
      commands.call(wrapInBlockTypeCommand.key, {
        nodeType: blockquoteSchema.type(context),
      });
      return;
    case "bullet-list":
      commands.call(wrapInBlockTypeCommand.key, {
        nodeType: bulletListSchema.type(context),
      });
      return;
    case "ordered-list":
      commands.call(wrapInBlockTypeCommand.key, {
        nodeType: orderedListSchema.type(context),
      });
      return;
    case "task-list":
      commands.call(wrapInBlockTypeCommand.key, {
        nodeType: listItemSchema.type(context),
        attrs: { checked: false },
      });
      return;
    case "code-block":
      commands.call(setBlockTypeCommand.key, {
        nodeType: codeBlockSchema.type(context),
      });
  }
}

function select_nonempty_document_content(context: Ctx) {
  const view = context.get(editorViewCtx);
  const { doc, selection } = view.state;
  if (selection.$from.depth !== 0) return;

  let first_block_start: number | null = null;
  let last_block_end: number | null = null;
  doc.forEach((node, offset) => {
    if (!node.textContent.trim()) return;
    first_block_start ??= offset;
    last_block_end = offset + node.nodeSize;
  });
  if (first_block_start === null || last_block_end === null) return;

  const start = Selection.findFrom(doc.resolve(first_block_start), 1, true);
  const end = Selection.findFrom(doc.resolve(last_block_end), -1, true);
  if (!start || !end) return;
  view.dispatch(
    view.state.tr.setSelection(TextSelection.create(doc, start.from, end.to)),
  );
}

function lift_selected_wrappers(context: Ctx) {
  select_wrapped_block_content(context);
  const commands = context.get(commandsCtx);
  const list_item = listItemSchema.type(context);
  for (let depth = 0; depth < MAX_WRAPPER_LIFT_DEPTH; depth += 1) {
    const style = selected_block_style(context);
    if (
      style === "bullet-list" ||
      style === "ordered-list" ||
      style === "task-list"
    ) {
      if (!commands.inline(liftListItem(list_item))) return;
      continue;
    }
    if (style === "quote") {
      if (!commands.inline(lift)) return;
      continue;
    }
    return;
  }
}

function select_wrapped_block_content(context: Ctx) {
  const view = context.get(editorViewCtx);
  const { doc, selection } = view.state;
  if (selection.$from.depth !== 0) return;
  const first_selected_node = doc.nodeAt(selection.from) ?? doc.firstChild;
  if (!first_selected_node) return;
  const is_list =
    first_selected_node.type === bulletListSchema.type(context) ||
    first_selected_node.type === orderedListSchema.type(context);
  const is_quote = first_selected_node.type === blockquoteSchema.type(context);
  if (!is_list && !is_quote) return;

  const block_end = Math.min(
    selection.from + first_selected_node.nodeSize,
    doc.content.size,
  );
  const start = Selection.findFrom(doc.resolve(selection.from), 1, true);
  const end = Selection.findFrom(doc.resolve(block_end), -1, true);
  if (!start || !end) return;
  view.dispatch(
    view.state.tr.setSelection(TextSelection.create(doc, start.from, end.to)),
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
