import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, PanelLeft, PanelRight } from "lucide-react";

import { AgentPanel } from "@/components/AgentPanel";
import { RESOURCE_QUERY_KEYS } from "@/app/query_cache";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { MarkdownSelection } from "@/components/MarkdownEditor";
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
import { Spinner } from "@/components/ui/spinner";
import {
  ApiError,
  create_summary_export,
  create_summary_child,
  delete_summary_document,
  generate_summary_documents,
  list_summary_documents,
  reorder_summary_children,
  subscribe_summary_documents,
  update_summary_document,
} from "@/shared/api";
import { error_message } from "@/shared/errors";
import { use_compact_summary_layout } from "@/features/summary/use_compact_summary_layout";
import {
  load_summary_project,
  type SummaryProject,
} from "@/features/summary/load_summary_project";
import { use_ai_models } from "@/features/analysis/use_analysis_resources";
import type {
  MediaAsset,
  MediaSegment,
  SummaryDetail,
  SummaryDocument,
  Transcript,
} from "@/shared/types";
import {
  DeleteDocumentDialog,
  DocumentEditor,
  DocumentTree,
  NewDocumentDialog,
  SummaryEmpty,
  SummaryGeneration,
  type SaveStatus,
} from "./SummaryWorkspacePanels";

const AUTO_SAVE_DELAY_MS = 1_000;

type SummaryWorkspaceProps = {
  selected_asset: MediaAsset | null;
  segments: MediaSegment[];
  transcript: Transcript | null;
  on_error?: (message: string | null) => void;
};

const EMPTY_SUMMARY_PROJECT: SummaryProject = {
  documents: [],
};

export function SummaryWorkspace({
  selected_asset,
  segments,
  transcript,
  on_error,
}: SummaryWorkspaceProps) {
  const query_client = useQueryClient();
  const selected_asset_id = selected_asset?.asset_id ?? null;
  const project_query = useQuery({
    queryKey: RESOURCE_QUERY_KEYS.summary_project(selected_asset_id),
    queryFn: ({ signal }) => load_summary_project(selected_asset_id!, signal),
    enabled: selected_asset_id !== null,
  });
  const initial_project = project_query.data ?? EMPTY_SUMMARY_PROJECT;
  const { models, error: models_error } = use_ai_models();
  const [documents, set_documents] = useState<SummaryDocument[]>(
    initial_project.documents,
  );
  const [selected_document_id, set_selected_document_id] = useState<
    string | null
  >(
    initial_project.documents.find(
      (document) => document.parent_document_id === null,
    )?.document_id ?? null,
  );
  const [is_generating, set_is_generating] = useState(false);
  const [detail, set_detail] = useState<SummaryDetail>("standard");
  const [create_subdocuments, set_create_subdocuments] = useState(false);
  const [generation_notice, set_generation_notice] = useState<string | null>(
    null,
  );
  const [generation_model_id, set_generation_model_id] = useState<
    string | null
  >(null);
  const [draft_markdown, set_draft_markdown] = useState("");
  const [draft_title, set_draft_title] = useState("");
  const [dirty, set_dirty] = useState(false);
  const [save_status, set_save_status] = useState<SaveStatus>("saved");
  const [editor_mode, set_editor_mode] = useState<"visual" | "source">(
    "visual",
  );
  const [selection, set_selection] = useState<MarkdownSelection | null>(null);
  const [tree_sheet_open, set_tree_sheet_open] = useState(false);
  const [agent_sheet_open, set_agent_sheet_open] = useState(false);
  const [new_document_open, set_new_document_open] = useState(false);
  const [new_document_title, set_new_document_title] = useState("");
  const [delete_target, set_delete_target] = useState<SummaryDocument | null>(
    null,
  );
  const [reordering, set_reordering] = useState(false);
  const [export_pending, set_export_pending] = useState(false);
  const [export_relative_path, set_export_relative_path] = useState<
    string | null
  >(null);
  const compact_layout = use_compact_summary_layout();
  const active_asset_id_ref = useRef<string | null>(
    selected_asset?.asset_id ?? null,
  );
  const active_document_id_ref = useRef<string | null>(null);
  const active_document_revision_ref = useRef<number | null>(null);
  const active_document_title_ref = useRef("");
  const draft_markdown_ref = useRef("");
  const draft_title_ref = useRef("");
  const dirty_ref = useRef(false);
  const save_promise_ref = useRef<Promise<boolean> | null>(null);
  const project_loaded_ref = useRef(project_query.data !== undefined);
  const project_state_ref = useRef<SummaryProject>(initial_project);

  const selected_document = useMemo(
    () =>
      documents.find(
        (document) => document.document_id === selected_document_id,
      ) ?? null,
    [documents, selected_document_id],
  );
  const root_document =
    documents.find((document) => document.parent_document_id === null) ?? null;
  const child_documents = documents
    .filter((document) => document.parent_document_id !== null)
    .sort((left, right) => left.position - right.position);

  const update_dirty = useCallback((next_dirty: boolean) => {
    dirty_ref.current = next_dirty;
    set_dirty(next_dirty);
  }, []);

  const activate_document = useCallback(
    (document: SummaryDocument) => {
      active_document_id_ref.current = document.document_id;
      active_document_revision_ref.current = document.revision;
      active_document_title_ref.current = document.title;
      draft_markdown_ref.current = document.markdown;
      draft_title_ref.current = document.title;
      set_draft_markdown(document.markdown);
      set_draft_title(document.title);
      update_dirty(false);
      set_save_status("saved");
      set_selection(null);
    },
    [update_dirty],
  );

  const save_active_draft = useCallback(async (): Promise<boolean> => {
    const pending_save = save_promise_ref.current;
    if (pending_save) return pending_save;
    if (!dirty_ref.current) return true;

    const document_id = active_document_id_ref.current;
    const expected_revision = active_document_revision_ref.current;
    if (!document_id || expected_revision === null) return false;

    const markdown = draft_markdown_ref.current;
    const draft_title = draft_title_ref.current;
    const title = draft_title.trim() || active_document_title_ref.current;
    set_save_status("saving");

    const save_promise = update_summary_document(
      document_id,
      expected_revision,
      {
        markdown,
        title,
      },
    )
      .then((updated) => {
        set_documents((current) =>
          current.map((document) =>
            document.document_id === updated.document_id ? updated : document,
          ),
        );
        if (active_document_id_ref.current !== document_id) return true;

        active_document_revision_ref.current = updated.revision;
        active_document_title_ref.current = updated.title;
        const current_title = draft_title_ref.current.trim() || updated.title;
        const unchanged =
          draft_markdown_ref.current === markdown && current_title === title;
        if (unchanged && !draft_title.trim()) {
          draft_title_ref.current = updated.title;
          set_draft_title(updated.title);
        }
        update_dirty(!unchanged);
        set_save_status(unchanged ? "saved" : "pending");
        return true;
      })
      .catch((error: unknown) => {
        if (active_document_id_ref.current === document_id) {
          set_save_status(
            error instanceof ApiError && error.status === 409
              ? "conflict"
              : "failed",
          );
        }
        return false;
      })
      .finally(() => {
        if (save_promise_ref.current === save_promise) {
          save_promise_ref.current = null;
        }
      });
    save_promise_ref.current = save_promise;
    return save_promise;
  }, [update_dirty]);

  const load_documents = useCallback(
    async (asset_id: string, signal?: AbortSignal) => {
      const loaded = await list_summary_documents(asset_id, signal);
      set_documents(loaded);
      set_selected_document_id((current) =>
        loaded.some((document) => document.document_id === current)
          ? current
          : (loaded.find((document) => document.parent_document_id === null)
              ?.document_id ?? null),
      );
      return loaded;
    },
    [],
  );

  useEffect(() => {
    set_generation_model_id(
      (current) => current ?? models[0]?.model_id ?? null,
    );
  }, [models]);

  useEffect(() => {
    const resource_error =
      models_error ??
      (project_query.error ? error_message(project_query.error) : null);
    if (resource_error) on_error?.(resource_error);
  }, [models_error, on_error, project_query.error]);

  useEffect(() => {
    active_asset_id_ref.current = selected_asset_id;
    set_generation_notice(null);
    set_export_relative_path(null);
    set_export_pending(false);
    if (!selected_asset_id) {
      set_documents([]);
      set_selected_document_id(null);
    }
  }, [selected_asset_id]);

  useEffect(() => {
    const project = project_query.data;
    if (!project) return;
    project_loaded_ref.current = true;
    set_documents(project.documents);
    set_selected_document_id((current) =>
      project.documents.some((document) => document.document_id === current)
        ? current
        : (project.documents.find(
            (document) => document.parent_document_id === null,
          )?.document_id ?? null),
    );
  }, [project_query.data]);

  useEffect(() => {
    project_state_ref.current = {
      documents,
    };
  }, [documents]);

  useEffect(() => {
    return () => {
      if (!selected_asset_id || !project_loaded_ref.current) return;
      query_client.setQueryData<SummaryProject>(
        RESOURCE_QUERY_KEYS.summary_project(selected_asset_id),
        project_state_ref.current,
      );
    };
  }, [query_client, selected_asset_id]);

  useEffect(() => {
    if (!selected_asset) return;
    return subscribe_summary_documents(selected_asset.asset_id, (loaded) => {
      if (dirty_ref.current) return;
      set_documents(loaded);
      set_selected_document_id((current) =>
        loaded.some((document) => document.document_id === current)
          ? current
          : (loaded.find((document) => document.parent_document_id === null)
              ?.document_id ?? null),
      );
    });
  }, [selected_asset]);

  useEffect(() => {
    if (!selected_document) return;
    const document_changed =
      active_document_id_ref.current !== selected_document.document_id;
    const revision_changed =
      active_document_revision_ref.current !== selected_document.revision;
    if (document_changed || (revision_changed && !dirty)) {
      activate_document(selected_document);
    }
  }, [activate_document, dirty, selected_document]);

  useEffect(() => {
    if (
      !selected_document ||
      !dirty ||
      save_status === "saving" ||
      save_status === "conflict"
    )
      return;
    const timeout = window.setTimeout(() => {
      void save_active_draft();
    }, AUTO_SAVE_DELAY_MS);
    return () => window.clearTimeout(timeout);
  }, [
    dirty,
    draft_markdown,
    draft_title,
    save_active_draft,
    save_status,
    selected_document,
  ]);

  async function select_document(document_id: string) {
    if (selected_document_id === document_id) {
      set_tree_sheet_open(false);
      return;
    }
    const target_document = documents.find(
      (document) => document.document_id === document_id,
    );
    if (!target_document) return;

    while (dirty_ref.current || save_promise_ref.current) {
      if (!(await save_active_draft())) return;
    }
    activate_document(target_document);
    set_selected_document_id(document_id);
    set_tree_sheet_open(false);
  }

  async function generate_documents() {
    if (!selected_asset) return;
    set_is_generating(true);
    set_generation_notice(null);
    on_error?.(null);
    try {
      const generated = await generate_summary_documents(
        selected_asset.asset_id,
        {
          ai_model_id: generation_model_id,
          detail,
          create_subdocuments,
          subdocument_mode: "chapters",
        },
      );
      set_documents(generated);
      const generated_subdocuments = generated.some(
        (document) => document.parent_document_id !== null,
      );
      if (create_subdocuments && !generated_subdocuments) {
        set_generation_notice(
          "当前内容不足以形成独立章节，因此没有创建空白子文档。",
        );
      }
      const root =
        generated.find((document) => document.parent_document_id === null) ??
        null;
      set_selected_document_id(root?.document_id ?? null);
    } catch (error) {
      on_error?.(error_message(error));
    } finally {
      set_is_generating(false);
    }
  }

  async function export_summary() {
    if (!selected_asset || export_pending) return;
    const asset_id = selected_asset.asset_id;
    set_export_pending(true);
    on_error?.(null);
    try {
      const result = await create_summary_export(asset_id);
      if (active_asset_id_ref.current === asset_id) {
        set_export_relative_path(result.relative_path);
      }
    } catch (error) {
      on_error?.(error_message(error));
    } finally {
      if (active_asset_id_ref.current === asset_id) {
        set_export_pending(false);
      }
    }
  }

  async function add_child() {
    if (!root_document || !new_document_title.trim()) return;
    try {
      const created = await create_summary_child(
        root_document.document_id,
        new_document_title.trim(),
      );
      set_documents((current) => [...current, created]);
      set_selected_document_id(created.document_id);
      set_new_document_title("");
      set_new_document_open(false);
      set_tree_sheet_open(false);
    } catch (error) {
      on_error?.(error_message(error));
    }
  }

  async function remove_child() {
    if (!delete_target) return;
    try {
      await delete_summary_document(delete_target.document_id);
      const next = documents.filter(
        (document) => document.document_id !== delete_target.document_id,
      );
      set_documents(next);
      if (selected_document_id === delete_target.document_id) {
        set_selected_document_id(root_document?.document_id ?? null);
      }
      set_delete_target(null);
    } catch (error) {
      on_error?.(error_message(error));
    }
  }

  async function reorder_children(document_ids: string[]) {
    if (!root_document || reordering) return;
    const previous_documents = documents;
    set_reordering(true);
    set_documents((current) =>
      current.map((document) => {
        const position = document_ids.indexOf(document.document_id);
        return position >= 0 ? { ...document, position } : document;
      }),
    );
    try {
      set_documents(
        await reorder_summary_children(root_document.document_id, document_ids),
      );
    } catch (error) {
      set_documents(previous_documents);
      on_error?.(error_message(error));
    } finally {
      set_reordering(false);
    }
  }

  function move_child(document_id: string, direction: -1 | 1) {
    const current_index = child_documents.findIndex(
      (document) => document.document_id === document_id,
    );
    const target_index = current_index + direction;
    if (
      current_index < 0 ||
      target_index < 0 ||
      target_index >= child_documents.length
    )
      return;
    const reordered = [...child_documents];
    [reordered[current_index], reordered[target_index]] = [
      reordered[target_index]!,
      reordered[current_index]!,
    ];
    void reorder_children(reordered.map((document) => document.document_id));
  }

  if (!selected_asset) {
    return (
      <SummaryEmpty
        title="尚未选择素材"
        description="请先在标记页选择一个已下载的视频。"
      />
    );
  }
  if (project_query.isPending && documents.length === 0) {
    return (
      <div
        className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"
        role="status"
      >
        <Spinner /> 正在读取总结项目
      </div>
    );
  }
  if (documents.length === 0) {
    return (
      <SummaryGeneration
        asset={selected_asset}
        transcript={transcript}
        segment_count={segments.length}
        models={models}
        model_id={generation_model_id}
        on_model_change={set_generation_model_id}
        detail={detail}
        on_detail_change={set_detail}
        create_subdocuments={create_subdocuments}
        on_create_subdocuments_change={set_create_subdocuments}
        is_generating={is_generating}
        on_generate={() => void generate_documents()}
      />
    );
  }
  if (!selected_document || !root_document) return null;

  const document_tree = (
    <DocumentTree
      root={root_document}
      children={child_documents}
      selected_document_id={selected_document.document_id}
      on_select={(document_id) => void select_document(document_id)}
      on_create={() => set_new_document_open(true)}
      on_move={(document_id, direction) => move_child(document_id, direction)}
      on_reorder={(document_ids) => void reorder_children(document_ids)}
      reordering={reordering}
      on_delete={set_delete_target}
    />
  );
  const agent_panel = (
    <AgentPanel
      agent_id="summary"
      asset_id={selected_asset.asset_id}
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
      on_artifact_change={async (artifact) => {
        if (artifact.status !== "approved") return;
        const loaded = await load_documents(selected_asset.asset_id);
        const active = loaded.find(
          (document) => document.document_id === selected_document.document_id,
        );
        if (active) {
          active_document_id_ref.current = null;
          set_selected_document_id(active.document_id);
        }
      }}
    />
  );
  const editor = (
    <DocumentEditor
      document={selected_document}
      title={draft_title}
      markdown={draft_markdown}
      mode={editor_mode}
      save_status={save_status}
      on_title_change={(title) => {
        set_draft_title(title);
        draft_title_ref.current = title;
        update_dirty(true);
        set_save_status("pending");
      }}
      on_markdown_change={(markdown) => {
        set_draft_markdown(markdown);
        draft_markdown_ref.current = markdown;
        update_dirty(true);
        set_save_status("pending");
      }}
      on_mode_change={set_editor_mode}
      on_selection_change={set_selection}
      on_retry={() => {
        set_save_status("pending");
        update_dirty(true);
      }}
      compact_actions={
        compact_layout ? (
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
        ) : null
      }
      export_pending={export_pending}
      export_relative_path={export_relative_path}
      on_export={() => void export_summary()}
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
        on_create={() => void add_child()}
      />
      <DeleteDocumentDialog
        document={delete_target}
        on_open_change={(open) => {
          if (!open) set_delete_target(null);
        }}
        on_confirm={() => void remove_child()}
      />
    </section>
  );
}
