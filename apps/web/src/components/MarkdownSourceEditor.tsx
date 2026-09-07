import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import { useMemo, useState } from "react";

import type { MarkdownSelection } from "./MarkdownEditor";
import { AgentContextMenuItem } from "./AgentContextSource";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

export function MarkdownSourceEditor({
  markdown: source,
  on_change,
  on_selection_change,
  on_add_context,
}: {
  markdown: string;
  on_change: (markdown: string) => void;
  on_selection_change: (selection: MarkdownSelection | null) => void;
  on_add_context?: () => void;
}) {
  const [context_action, set_context_action] = useState<(() => void) | null>(
    null,
  );
  const extensions = useMemo(
    () => [
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      EditorState.tabSize.of(2),
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({ "aria-label": "Markdown 源码" }),
      EditorView.updateListener.of((update) => {
        if (!update.selectionSet) return;
        const selection = update.state.selection.main;
        on_selection_change(
          selection.empty
            ? null
            : {
                start: selection.from,
                end: selection.to,
                text: update.state.sliceDoc(selection.from, selection.to),
              },
        );
      }),
    ],
    [on_selection_change],
  );

  return (
    <ContextMenu
      onOpenChange={(open) => {
        // 菜单取得焦点时编辑器可能清空选区，保留右键时的文字快照。
        if (open) set_context_action(() => on_add_context ?? null);
      }}
    >
      <ContextMenuTrigger asChild disabled={!on_add_context}>
        <div className="flex min-h-0 flex-1">
          <CodeMirror
            value={source}
            height="100%"
            extensions={extensions}
            onChange={on_change}
            aria-label="Markdown 源码"
            className="summary-source-editor min-h-0 flex-1"
            basicSetup={{
              bracketMatching: true,
              closeBrackets: true,
              foldGutter: true,
              highlightActiveLine: true,
              highlightActiveLineGutter: true,
              lineNumbers: true,
              searchKeymap: true,
            }}
          />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent aria-label="选中文字">
        <ContextMenuGroup>
          {context_action ? (
            <AgentContextMenuItem on_add={context_action} />
          ) : null}
        </ContextMenuGroup>
      </ContextMenuContent>
    </ContextMenu>
  );
}
