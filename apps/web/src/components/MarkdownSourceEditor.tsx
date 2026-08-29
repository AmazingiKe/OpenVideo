import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import { useMemo } from "react";

import type { MarkdownSelection } from "./MarkdownEditor";

export function MarkdownSourceEditor({
  markdown: source,
  on_change,
  on_selection_change,
}: {
  markdown: string;
  on_change: (markdown: string) => void;
  on_selection_change: (selection: MarkdownSelection | null) => void;
}) {
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
  );
}
