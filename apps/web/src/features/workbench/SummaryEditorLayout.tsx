import { CircleCheck, PanelLeft, PanelRight } from "lucide-react";
import type { ReactNode } from "react";

import { AgentPanel } from "@/components/AgentPanel";
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
import type {
  AgentArtifact,
  AiModelSummary,
  SummaryDocument,
} from "@/shared/types";
import {
  DeleteDocumentDialog,
  DocumentEditor,
  DocumentTree,
  NewDocumentDialog,
  type SaveStatus,
} from "./SummaryWorkspacePanels";

type SummaryEditorLayoutProps = {
  agent_sheet_open: boolean;
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
  models: AiModelSummary[];
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
  selection: MarkdownSelection | null;
  select_document: (document_id: string) => void;
  set_agent_sheet_open: (open: boolean) => void;
  set_delete_target: (document: SummaryDocument) => void;
  set_editor_mode: (mode: "visual" | "source") => void;
  set_new_document_open: (open: boolean) => void;
  set_new_document_title: (title: string) => void;
  set_selection: (selection: MarkdownSelection | null) => void;
  set_tree_sheet_open: (open: boolean) => void;
  tree_sheet_open: boolean;
};

export function SummaryEditorLayout({
  agent_sheet_open,
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
  models,
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
  selection,
  select_document,
  set_agent_sheet_open,
  set_delete_target,
  set_editor_mode,
  set_new_document_open,
  set_new_document_title,
  set_selection,
  set_tree_sheet_open,
  tree_sheet_open,
}: SummaryEditorLayoutProps) {
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
  const agent_panel = (
    <AgentPanel
      agent_id="summary"
      asset_id={selected_asset_id}
      models={models}
      context={{ document_id: selected_document.document_id }}
      task_input={{
        document_id: selected_document.document_id,
        expected_revision: selected_document.revision,
        selection,
      }}
      run_options={[
        {
          value: "chat",
          label: "文档问答",
          description: "只回答问题，不修改总结；可使用纯聊天模型。",
          task_input: { intent: "chat" },
        },
        {
          value: "edit",
          label: "修改总结",
          description: "生成整批修改预览，确认后才会写入文档。",
          task_input: { intent: "edit" },
          required_capabilities: ["tools"],
        },
      ]}
      on_artifact_change={on_artifact_change}
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
        onClick={() => set_agent_sheet_open(true)}
      >
        <PanelRight data-icon="inline-start" /> Agent
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
      {generation_notice ? (
        <div className="shrink-0 px-2 pt-2">
          <Alert role="status" aria-live="polite" aria-label="已保留单一主文档">
            <CircleCheck aria-hidden="true" />
            <AlertTitle>已保留单一主文档</AlertTitle>
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
            <Sheet open={agent_sheet_open} onOpenChange={set_agent_sheet_open}>
              <SheetContent
                side="right"
                className="w-[min(92vw,26rem)] gap-0 p-0"
              >
                <SheetHeader className="sr-only">
                  <SheetTitle>总结 Agent</SheetTitle>
                  <SheetDescription>建议需确认后才会应用</SheetDescription>
                </SheetHeader>
                {agent_panel}
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
            <ResizablePanel id="summary-editor" defaultSize="50%" minSize="34%">
              {editor}
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel
              id="summary-agent"
              defaultSize="30%"
              minSize="24%"
              maxSize="42%"
            >
              {agent_panel}
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
