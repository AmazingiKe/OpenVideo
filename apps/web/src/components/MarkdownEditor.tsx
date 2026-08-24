import { useEffect, useRef } from "react";
import { CrepeBuilder } from "@milkdown/crepe/builder";
import { blockEdit } from "@milkdown/crepe/feature/block-edit";
import { codeMirror } from "@milkdown/crepe/feature/code-mirror";
import { imageBlock } from "@milkdown/crepe/feature/image-block";
import { linkTooltip } from "@milkdown/crepe/feature/link-tooltip";
import { placeholder } from "@milkdown/crepe/feature/placeholder";
import { table } from "@milkdown/crepe/feature/table";
import { toolbar } from "@milkdown/crepe/feature/toolbar";
import { editorViewOptionsCtx } from "@milkdown/kit/core";
import { replaceAll } from "@milkdown/kit/utils";
import { Milkdown, MilkdownProvider, useEditor } from "@milkdown/react";
import "@milkdown/crepe/theme/common/style.css";

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
  readonly?: boolean;
};

export function MarkdownEditor(props: MarkdownEditorProps) {
  return (
    <MilkdownProvider>
      <MarkdownEditorInner {...props} />
    </MilkdownProvider>
  );
}

function MarkdownEditorInner({
  document_key,
  markdown,
  on_change,
  on_selection_change,
  readonly = false,
}: MarkdownEditorProps) {
  const change_ref = useRef(on_change);
  const selection_ref = useRef(on_selection_change);
  const controlled_markdown_ref = useRef(markdown);
  const editor_markdown_ref = useRef(markdown);

  useEffect(() => {
    change_ref.current = on_change;
    selection_ref.current = on_selection_change;
    controlled_markdown_ref.current = markdown;
  }, [markdown, on_change, on_selection_change]);

  const { get, loading } = useEditor(
    (root) => {
      const editor = new CrepeBuilder({ root, defaultValue: markdown })
        .addFeature(blockEdit)
        .addFeature(toolbar)
        .addFeature(linkTooltip)
        .addFeature(imageBlock)
        .addFeature(table)
        .addFeature(codeMirror)
        .addFeature(placeholder, {
          text: "从这里开始整理视频知识…",
          mode: "block",
        })
        .setReadonly(readonly);
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
    [document_key, readonly],
  );

  useEffect(() => {
    if (loading || editor_markdown_ref.current === markdown) return;
    const editor = get();
    if (!editor) return;
    editor_markdown_ref.current = markdown;
    editor.action(replaceAll(markdown));
  }, [get, loading, markdown]);

  return (
    <div
      className="summary-milkdown min-h-0 flex-1 overflow-y-auto"
      aria-busy={loading}
    >
      <Milkdown />
    </div>
  );
}
