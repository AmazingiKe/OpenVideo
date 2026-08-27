import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  CircleCheck,
  CircleX,
  Code2,
  Download,
  Eye,
  FilePlus2,
  FileText,
  FolderTree,
  GripVertical,
  MoreVertical,
  PanelLeft,
  PanelRight,
  Save,
  Trash2,
} from "lucide-react";

import { AgentPanel } from "@/components/AgentPanel";
import { AiModelSelect } from "@/components/AiModelSelect";
import { RESOURCE_QUERY_KEYS } from "@/app/query_cache";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  MarkdownEditor,
  type MarkdownSelection,
} from "@/components/MarkdownEditor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
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
import { use_ai_models } from "@/features/analysis/use_analysis_resources";
import type {
  AiModelSummary,
  MediaAsset,
  MediaSegment,
  SummaryDetail,
  SummaryDocument,
  Transcript,
} from "@/shared/types";

const AUTO_SAVE_DELAY_MS = 1_000;

type SaveStatus = "saved" | "pending" | "saving" | "failed" | "conflict";

type SummaryWorkspaceProps = {
  selected_asset: MediaAsset | null;
  segments: MediaSegment[];
  transcript: Transcript | null;
  on_error?: (message: string | null) => void;
};

type SummaryProject = {
  documents: SummaryDocument[];
};

const EMPTY_SUMMARY_PROJECT: SummaryProject = {
  documents: [],
};

async function load_summary_project(
  asset_id: string,
  signal?: AbortSignal,
): Promise<SummaryProject> {
  const documents = await list_summary_documents(asset_id, signal);
  return { documents };
}

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

export function SummaryGeneration({
  asset,
  transcript,
  segment_count,
  models,
  model_id,
  on_model_change,
  detail,
  on_detail_change,
  create_subdocuments,
  on_create_subdocuments_change,
  is_generating,
  on_generate,
}: {
  asset: MediaAsset;
  transcript: Transcript | null;
  segment_count: number;
  models: AiModelSummary[];
  model_id: string | null;
  on_model_change: (model_id: string | null) => void;
  detail: SummaryDetail;
  on_detail_change: (detail: SummaryDetail) => void;
  create_subdocuments: boolean;
  on_create_subdocuments_change: (checked: boolean) => void;
  is_generating: boolean;
  on_generate: () => void;
}) {
  return (
    <div className="mx-auto flex h-full w-full max-w-3xl items-center px-4 py-8">
      <Card className="w-full">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText aria-hidden="true" /> 生成 Markdown 总结
          </CardTitle>
          <CardDescription>
            为“{asset.title}
            ”创建一份可持续编辑的知识文档。总结只会在你点击生成后开始。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <AiModelSelect
              id="summary-generation-model"
              label="AI 模型"
              models={models}
              value={model_id}
              on_change={on_model_change}
              allow_without_model
              disabled={is_generating}
              description="不选择模型时使用时间轴结果生成；选择后由模型整理知识文档。"
            />
            <Field>
              <FieldLabel htmlFor="summary_detail">文档详细度</FieldLabel>
              <Select
                value={detail}
                onValueChange={(value) =>
                  on_detail_change(value as SummaryDetail)
                }
              >
                <SelectTrigger id="summary_detail" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="concise">精简</SelectItem>
                    <SelectItem value="standard">标准</SelectItem>
                    <SelectItem value="detailed">详细</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field className="flex-row items-start">
              <Checkbox
                id="create_subdocuments"
                checked={create_subdocuments}
                onCheckedChange={(checked) =>
                  on_create_subdocuments_change(checked === true)
                }
              />
              <div className="flex flex-col gap-1">
                <FieldLabel htmlFor="create_subdocuments">
                  适合时按章节拆分
                </FieldLabel>
                <FieldDescription>
                  仅在内容形成明确章节时生成；否则保留单一主文档。
                </FieldDescription>
              </div>
            </Field>
          </FieldGroup>
          <div className="mt-6 flex flex-wrap gap-2" aria-label="可用分析内容">
            <Badge variant="secondary">
              转写 {transcript?.segments.length ?? 0} 段
            </Badge>
            <Badge variant="secondary">分析事件 {segment_count} 个</Badge>
          </div>
        </CardContent>
        <CardFooter>
          <Button onClick={on_generate} disabled={!transcript || is_generating}>
            {is_generating ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <FileText data-icon="inline-start" />
            )}
            {is_generating ? "正在生成…" : "生成主文档"}
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}

function DocumentTree({
  root,
  children,
  selected_document_id,
  on_select,
  on_create,
  on_move,
  on_reorder,
  reordering,
  on_delete,
}: {
  root: SummaryDocument;
  children: SummaryDocument[];
  selected_document_id: string;
  on_select: (document_id: string) => void;
  on_create: () => void;
  on_move: (document_id: string, direction: -1 | 1) => void;
  on_reorder: (document_ids: string[]) => void;
  reordering: boolean;
  on_delete: (document: SummaryDocument) => void;
}) {
  const [dragged_document_id, set_dragged_document_id] = useState<
    string | null
  >(null);
  const [drop_target, set_drop_target] = useState<{
    document_id: string;
    edge: "before" | "after";
  } | null>(null);

  function finish_drag() {
    set_dragged_document_id(null);
    set_drop_target(null);
  }

  function drop_document(target_document_id: string, edge: "before" | "after") {
    if (!dragged_document_id) return;
    const document_ids = children.map((document) => document.document_id);
    const reordered = reorder_document_ids(
      document_ids,
      dragged_document_id,
      target_document_id,
      edge,
    );
    finish_drag();
    if (reordered.join() !== document_ids.join()) on_reorder(reordered);
  }

  return (
    <nav className="flex h-full min-h-0 flex-col bg-card" aria-label="总结文档">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <FolderTree aria-hidden="true" /> 文档
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={on_create}
          aria-label="新建子文档"
        >
          <FilePlus2 />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2">
        <DocumentButton
          document={root}
          selected={root.document_id === selected_document_id}
          on_select={on_select}
        />
        <div className="flex flex-col gap-1 pl-3">
          {children.map((document, index) => (
            <div
              className={cn(
                "flex min-w-0 items-center gap-1 rounded-md border-y-2 border-transparent",
                drop_target?.document_id === document.document_id &&
                  drop_target.edge === "before" &&
                  "border-t-primary",
                drop_target?.document_id === document.document_id &&
                  drop_target.edge === "after" &&
                  "border-b-primary",
                dragged_document_id === document.document_id && "opacity-50",
              )}
              key={document.document_id}
              onDragOver={(event) => {
                if (!dragged_document_id || reordering) return;
                event.preventDefault();
                const bounds = event.currentTarget.getBoundingClientRect();
                set_drop_target({
                  document_id: document.document_id,
                  edge:
                    event.clientY < bounds.top + bounds.height / 2
                      ? "before"
                      : "after",
                });
              }}
              onDrop={(event) => {
                event.preventDefault();
                const bounds = event.currentTarget.getBoundingClientRect();
                drop_document(
                  document.document_id,
                  event.clientY < bounds.top + bounds.height / 2
                    ? "before"
                    : "after",
                );
              }}
            >
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                draggable={!reordering}
                disabled={reordering}
                onDragStart={(event) => {
                  set_dragged_document_id(document.document_id);
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData(
                    "text/plain",
                    document.document_id,
                  );
                }}
                onDragEnd={finish_drag}
                onKeyDown={(event) => {
                  if (event.key === "ArrowUp" && index > 0) {
                    event.preventDefault();
                    on_move(document.document_id, -1);
                  }
                  if (
                    event.key === "ArrowDown" &&
                    index < children.length - 1
                  ) {
                    event.preventDefault();
                    on_move(document.document_id, 1);
                  }
                }}
                aria-label={`拖动 ${document.title} 调整顺序；也可使用上下方向键`}
              >
                <GripVertical />
              </Button>
              <DocumentButton
                document={document}
                selected={document.document_id === selected_document_id}
                on_select={on_select}
                className="flex-1"
              />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    disabled={reordering}
                    aria-label={`${document.title} 操作`}
                  >
                    <MoreVertical />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuGroup>
                    <DropdownMenuItem
                      disabled={index === 0}
                      onSelect={() => on_move(document.document_id, -1)}
                    >
                      <ArrowUp /> 上移
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={index === children.length - 1}
                      onSelect={() => on_move(document.document_id, 1)}
                    >
                      <ArrowDown /> 下移
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() => on_delete(document)}
                    >
                      <Trash2 /> 删除
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ))}
        </div>
      </div>
      <span className="sr-only" aria-live="polite">
        {reordering ? "正在保存文档顺序" : ""}
      </span>
    </nav>
  );
}

export function reorder_document_ids(
  document_ids: string[],
  dragged_document_id: string,
  target_document_id: string,
  edge: "before" | "after",
): string[] {
  if (dragged_document_id === target_document_id) return document_ids;
  const reordered = document_ids.filter(
    (document_id) => document_id !== dragged_document_id,
  );
  const target_index = reordered.indexOf(target_document_id);
  if (target_index < 0) return document_ids;
  const insertion_index = target_index + (edge === "after" ? 1 : 0);
  reordered.splice(insertion_index, 0, dragged_document_id);
  return reordered;
}

function DocumentButton({
  document,
  selected,
  on_select,
  className,
}: {
  document: SummaryDocument;
  selected: boolean;
  on_select: (document_id: string) => void;
  className?: string;
}) {
  return (
    <Button
      type="button"
      variant={selected ? "secondary" : "ghost"}
      className={cn("min-w-0 justify-start", className)}
      onClick={() => on_select(document.document_id)}
      aria-current={selected ? "page" : undefined}
    >
      <FileText data-icon="inline-start" />
      <span className="truncate">{document.title}</span>
    </Button>
  );
}

function DocumentEditor({
  document,
  title,
  markdown,
  mode,
  save_status,
  on_title_change,
  on_markdown_change,
  on_mode_change,
  on_selection_change,
  on_retry,
  compact_actions,
  export_pending,
  export_relative_path,
  on_export,
}: {
  document: SummaryDocument;
  title: string;
  markdown: string;
  mode: "visual" | "source";
  save_status: SaveStatus;
  on_title_change: (title: string) => void;
  on_markdown_change: (markdown: string) => void;
  on_mode_change: (mode: "visual" | "source") => void;
  on_selection_change: (selection: MarkdownSelection | null) => void;
  on_retry: () => void;
  compact_actions: ReactNode;
  export_pending: boolean;
  export_relative_path: string | null;
  on_export: () => void;
}) {
  return (
    <Tabs
      value={mode}
      onValueChange={(value) => on_mode_change(value as "visual" | "source")}
      className="h-full min-h-0 gap-0 bg-background"
      aria-label="文档编辑器"
    >
      <header className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        {compact_actions}
        <Input
          value={title}
          onChange={(event) => on_title_change(event.target.value)}
          aria-label="文档标题"
          className="min-w-40 flex-1 border-transparent bg-transparent font-medium shadow-none focus-visible:border-input"
        />
        <SaveState status={save_status} on_retry={on_retry} />
        <TabsList aria-label="编辑模式">
          <TabsTrigger value="visual" aria-label="预览模式" title="预览模式">
            <Eye />
          </TabsTrigger>
          <TabsTrigger value="source" aria-label="源码模式" title="源码模式">
            <Code2 />
          </TabsTrigger>
        </TabsList>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={export_pending}
          onClick={on_export}
        >
          {export_pending ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <Download data-icon="inline-start" />
          )}
          {export_pending ? "导出中" : "导出 ZIP"}
        </Button>
        {export_relative_path ? (
          <span
            className="max-w-72 truncate text-xs text-muted-foreground"
            role="status"
            title={export_relative_path}
          >
            已保存：{export_relative_path}
          </span>
        ) : null}
      </header>
      <TabsContent value="visual" className="min-h-0">
        <MarkdownEditorErrorBoundary
          document_id={document.document_id}
          on_use_source={() => on_mode_change("source")}
        >
          <MarkdownEditor
            document_key={document.document_id}
            markdown={markdown}
            on_change={on_markdown_change}
            on_selection_change={on_selection_change}
          />
        </MarkdownEditorErrorBoundary>
      </TabsContent>
      <TabsContent value="source" className="min-h-0">
        <Textarea
          value={markdown}
          onChange={(event) => on_markdown_change(event.target.value)}
          onSelect={(event) => {
            const target = event.currentTarget;
            on_selection_change(
              target.selectionStart === target.selectionEnd
                ? null
                : {
                    start: target.selectionStart,
                    end: target.selectionEnd,
                    text: target.value.slice(
                      target.selectionStart,
                      target.selectionEnd,
                    ),
                  },
            );
          }}
          aria-label="Markdown 源码"
          className="min-h-0 flex-1 resize-none rounded-none border-0 p-6 font-mono shadow-none focus-visible:ring-0"
        />
      </TabsContent>
    </Tabs>
  );
}

function SaveState({
  status,
  on_retry,
}: {
  status: SaveStatus;
  on_retry: () => void;
}) {
  const labels: Record<SaveStatus, string> = {
    saved: "已保存",
    pending: "等待保存",
    saving: "保存中",
    failed: "保存失败",
    conflict: "版本冲突",
  };
  if (status === "failed") {
    return (
      <Button type="button" variant="ghost" size="sm" onClick={on_retry}>
        重试保存
      </Button>
    );
  }
  return (
    <Badge
      variant={status === "conflict" ? "destructive" : "secondary"}
      role="status"
    >
      {status === "saving" ? (
        <Spinner data-icon="inline-start" />
      ) : (
        <Save data-icon="inline-start" />
      )}
      {labels[status]}
    </Badge>
  );
}

type MarkdownEditorErrorBoundaryProps = {
  document_id: string;
  on_use_source: () => void;
  children: ReactNode;
};

type MarkdownEditorErrorBoundaryState = {
  failed: boolean;
};

class MarkdownEditorErrorBoundary extends Component<
  MarkdownEditorErrorBoundaryProps,
  MarkdownEditorErrorBoundaryState
> {
  state: MarkdownEditorErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): MarkdownEditorErrorBoundaryState {
    return { failed: true };
  }

  componentDidUpdate(previous: MarkdownEditorErrorBoundaryProps) {
    if (this.state.failed && previous.document_id !== this.props.document_id) {
      this.setState({ failed: false });
    }
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="p-4">
        <Alert variant="destructive">
          <CircleX aria-hidden="true" />
          <AlertTitle>可视化编辑器未能打开</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-3">
            <span>文档内容仍然安全，可切换到源码模式继续查看和编辑。</span>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={this.props.on_use_source}
              >
                <Code2 data-icon="inline-start" /> 使用源码模式
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => this.setState({ failed: false })}
              >
                重试可视化编辑器
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      </div>
    );
  }
}

function NewDocumentDialog({
  open,
  on_open_change,
  title,
  on_title_change,
  on_create,
}: {
  open: boolean;
  on_open_change: (open: boolean) => void;
  title: string;
  on_title_change: (title: string) => void;
  on_create: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={on_open_change}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建子文档</DialogTitle>
          <DialogDescription>
            子文档只允许一级，文件路径由文档 ID 固定生成。
          </DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel htmlFor="new_summary_document_title">标题</FieldLabel>
          <Input
            id="new_summary_document_title"
            value={title}
            onChange={(event) => on_title_change(event.target.value)}
            autoFocus
          />
        </Field>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">取消</Button>
          </DialogClose>
          <Button onClick={on_create} disabled={!title.trim()}>
            创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDocumentDialog({
  document,
  on_open_change,
  on_confirm,
}: {
  document: SummaryDocument | null;
  on_open_change: (open: boolean) => void;
  on_confirm: () => void;
}) {
  return (
    <Dialog open={document !== null} onOpenChange={on_open_change}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>删除子文档</DialogTitle>
          <DialogDescription>
            “{document?.title}”将从当前总结项目中删除，此操作不可撤销。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">取消</Button>
          </DialogClose>
          <Button variant="destructive" onClick={on_confirm}>
            删除
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SummaryEmpty({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="flex h-full items-center justify-center p-4">
      <Empty className="max-w-md border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FileText />
          </EmptyMedia>
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription>{description}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  );
}
