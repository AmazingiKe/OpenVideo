import { CircleCheck, FilePlus2, PanelLeft, PanelRight } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import {
  GlobalAssistantRegistration,
  use_global_assistant_controls,
} from "@/app/global_assistant";
import { AgentContextSource } from "@/components/AgentContextSource";
import type { AgentContextAttachmentDraft } from "@/components/agent_context";
import type { MarkdownSelection } from "@/components/MarkdownEditor";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  AgentArtifact,
  SummaryDocument,
  SummaryVersion,
} from "@/shared/types";
import {
  DeleteDocumentDialog,
  DocumentEditor,
  DocumentTree,
  NewDocumentDialog,
  type SaveStatus,
} from "./SummaryWorkspacePanels";

type SummaryEditorLayoutProps = {
  child_documents: SummaryDocument[];
  compact_layout: boolean;
  create_child: () => void;
  delete_target: SummaryDocument | null;
  draft_markdown: string;
  draft_title: string;
  editor_mode: "visual" | "source";
  export_pending: boolean;
  export_relative_path: string | null;
  generation_notice: string | null;
  move_child: (document_id: string, direction: -1 | 1) => void;
  new_document_open: boolean;
  new_document_title: string;
  on_artifact_change: (artifact: AgentArtifact) => void | Promise<void>;
  on_delete_confirm: () => void;
  on_export: () => void;
  on_markdown_change: (markdown: string) => void;
  on_retry: () => void;
  on_title_change: (title: string) => void;
  remove_delete_target: () => void;
  reorder_children: (document_ids: string[]) => void;
  reordering: boolean;
  root_document: SummaryDocument;
  save_status: SaveStatus;
  selected_asset_id: string;
  selected_document: SummaryDocument;
  versions: SummaryVersion[];
  current_version_id: string | null;
  on_version_change: (version_id: string) => void;
  on_generate_version: () => void;
  selection: MarkdownSelection | null;
  select_document: (document_id: string) => void;
  set_delete_target: (document: SummaryDocument) => void;
  set_editor_mode: (mode: "visual" | "source") => void;
  set_new_document_open: (open: boolean) => void;
  set_new_document_title: (title: string) => void;
  set_selection: (selection: MarkdownSelection | null) => void;
  set_tree_sheet_open: (open: boolean) => void;
  tree_sheet_open: boolean;
};

export function SummaryEditorLayout({
  child_documents,
  compact_layout,
  create_child,
  delete_target,
  draft_markdown,
  draft_title,
  editor_mode,
  export_pending,
  export_relative_path,
  generation_notice,
  move_child,
  new_document_open,
  new_document_title,
  on_artifact_change,
  on_delete_confirm,
  on_export,
  on_markdown_change,
  on_retry,
  on_title_change,
  remove_delete_target,
  reorder_children,
  reordering,
  root_document,
  save_status,
  selected_asset_id,
  selected_document,
  versions,
  current_version_id,
  on_version_change,
  on_generate_version,
  selection,
  select_document,
  set_delete_target,
  set_editor_mode,
  set_new_document_open,
  set_new_document_title,
  set_selection,
  set_tree_sheet_open,
  tree_sheet_open,
}: SummaryEditorLayoutProps) {
  const selection_attachment = useMemo(
    () =>
      summary_context_attachment(
        selected_asset_id,
        selected_document,
        selection,
      ),
    [selected_asset_id, selected_document, selection],
  );
  const [agent_context_attachments, set_agent_context_attachments] = useState<
    AgentContextAttachmentDraft[]
  >([]);
  useEffect(() => {
    set_agent_context_attachments([]);
  }, [selected_asset_id, selected_document.document_id]);
  const assistant_binding = useMemo(
    () => ({
      agent_id: "summary",
      asset_id: selected_asset_id,
      context_label: `总结文档 · ${selected_document.title}`,
      context: {
        document_id: selected_document.document_id,
        version_id: selected_document.version_id,
      },
      task_input: {
        document_id: selected_document.document_id,
        version_id: selected_document.version_id,
        expected_revision: selected_document.revision,
        selection,
      },
      context_attachments: agent_context_attachments,
      placeholder: "询问视频内容，或直接描述希望怎样修改总结…",
      panel_size_percent: 30,
      on_artifact_change,
    }),
    [
      agent_context_attachments,
      on_artifact_change,
      selected_asset_id,
      selected_document,
      selection,
    ],
  );
  const { open_assistant } = use_global_assistant_controls();
  const context_action = selection_attachment ? (
    <AgentContextSource
      attachment={selection_attachment}
      on_add={(attachment) =>
        set_agent_context_attachments((current) => [...current, attachment])
      }
    />
  ) : null;
  const document_tree = (
    <DocumentTree
      root={root_document}
      children={child_documents}
      selected_document_id={selected_document.document_id}
      on_select={select_document}
      on_create={() => set_new_document_open(true)}
      on_move={move_child}
      on_reorder={reorder_children}
      reordering={reordering}
      on_delete={set_delete_target}
    />
  );
  const compact_actions: ReactNode = compact_layout ? (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => set_tree_sheet_open(true)}
      >
        <PanelLeft data-icon="inline-start" /> 文档
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={open_assistant}
      >
        <PanelRight data-icon="inline-start" /> 助手
      </Button>
    </>
  ) : null;
  const editor = (
    <DocumentEditor
      document={selected_document}
      title={draft_title}
      markdown={draft_markdown}
      mode={editor_mode}
      save_status={save_status}
      on_title_change={on_title_change}
      on_markdown_change={on_markdown_change}
      on_mode_change={set_editor_mode}
      on_selection_change={set_selection}
      on_retry={on_retry}
      compact_actions={compact_actions}
      context_action={context_action}
      export_pending={export_pending}
      export_relative_path={export_relative_path}
      on_export={on_export}
    />
  );

  return (
    <section
      className="flex h-full min-h-0 flex-col bg-background"
      aria-label="Markdown 总结工作台"
    >
      <GlobalAssistantRegistration binding={assistant_binding} />
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
        <Select
          value={current_version_id ?? ""}
          onValueChange={on_version_change}
        >
          <SelectTrigger className="w-full sm:w-72" aria-label="总结版本">
            <SelectValue placeholder="选择总结版本" />
          </SelectTrigger>
          <SelectContent>
            {versions.map((version, index) => (
              <SelectItem key={version.version_id} value={version.version_id}>
                版本 {versions.length - index} · {version.preset_id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="button" size="sm" onClick={on_generate_version}>
          <FilePlus2 data-icon="inline-start" aria-hidden="true" />
          生成新版本
        </Button>
      </div>
      {generation_notice ? (
        <div className="shrink-0 px-2 pt-2">
          <Alert role="status" aria-live="polite" aria-label="生成提示">
            <CircleCheck aria-hidden="true" />
            <AlertTitle>生成提示</AlertTitle>
            <AlertDescription>{generation_notice}</AlertDescription>
          </Alert>
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        {compact_layout ? (
          <>
            {editor}
            <Sheet open={tree_sheet_open} onOpenChange={set_tree_sheet_open}>
              <SheetContent side="left" className="w-[min(88vw,22rem)] p-0">
                <SheetHeader className="border-b">
                  <SheetTitle>文档树</SheetTitle>
                  <SheetDescription>管理主文档与一级子文档</SheetDescription>
                </SheetHeader>
                {document_tree}
              </SheetContent>
            </Sheet>
          </>
        ) : (
          <ResizablePanelGroup orientation="horizontal">
            <ResizablePanel
              id="summary-tree"
              defaultSize="20%"
              minSize="15%"
              maxSize="28%"
            >
              {document_tree}
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel id="summary-editor" defaultSize="80%" minSize="60%">
              {editor}
            </ResizablePanel>
          </ResizablePanelGroup>
        )}
      </div>
      <NewDocumentDialog
        open={new_document_open}
        on_open_change={set_new_document_open}
        title={new_document_title}
        on_title_change={set_new_document_title}
        on_create={create_child}
      />
      <DeleteDocumentDialog
        document={delete_target}
        on_open_change={(open) => {
          if (!open) remove_delete_target();
        }}
        on_confirm={on_delete_confirm}
      />
    </section>
  );
}

function summary_context_attachment(
  asset_id: string,
  document: SummaryDocument,
  selection: MarkdownSelection | null,
): AgentContextAttachmentDraft | null {
  if (!selection?.text.trim()) return null;
  return {
    draft_id: `${document.document_id}-${document.revision}-${selection.start}-${selection.end}`,
    kind: "summary_selection",
    asset_id,
    label: `${document.title}选区`,
    reference_id: document.document_id,
    version_id: document.version_id,
    snapshot_text: selection.text,
    selection_start: selection.start,
    selection_end: selection.end,
  };
}
