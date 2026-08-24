import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  Bot,
  Download,
  FilePlus2,
  FileText,
  FolderTree,
  MessageSquareText,
  PanelLeft,
  PanelRight,
  Save,
  Trash2,
} from "lucide-react";

import { AiModelSelect } from "@/components/AiModelSelect";
import {
  MarkdownEditor,
  type MarkdownSelection,
} from "@/components/MarkdownEditor";
import {
  Bubble,
  Message,
  MessageComposer,
  MessageScroller,
} from "@/components/chat";
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
  create_summary_agent_run,
  create_summary_child,
  create_summary_media,
  delete_summary_document,
  generate_summary_documents,
  get_summary_conversation,
  list_ai_models,
  list_summary_documents,
  reorder_summary_children,
  resolve_summary_proposal,
  stream_summary_agent_run,
  update_summary_document,
} from "@/shared/api";
import { error_message, is_abort_error } from "@/shared/errors";
import { use_compact_summary_layout } from "@/features/summary/use_compact_summary_layout";
import type {
  AiModelSummary,
  MediaAsset,
  MediaSegment,
  SummaryConversationState,
  SummaryDetail,
  SummaryDocument,
  SummaryEditProposal,
  SummaryMediaSuggestion,
  SummaryMessage,
  Transcript,
} from "@/shared/types";

const AUTO_SAVE_DELAY_MS = 1_000;

type SaveStatus = "saved" | "saving" | "failed" | "conflict";

type SummaryWorkspaceProps = {
  selected_asset: MediaAsset | null;
  segments: MediaSegment[];
  transcript: Transcript | null;
  on_error?: (message: string | null) => void;
};

export function SummaryWorkspace({
  selected_asset,
  segments,
  transcript,
  on_error,
}: SummaryWorkspaceProps) {
  const [documents, set_documents] = useState<SummaryDocument[]>([]);
  const [selected_document_id, set_selected_document_id] = useState<
    string | null
  >(null);
  const [models, set_models] = useState<AiModelSummary[]>([]);
  const [conversation, set_conversation] =
    useState<SummaryConversationState | null>(null);
  const [is_loading, set_is_loading] = useState(false);
  const [is_generating, set_is_generating] = useState(false);
  const [detail, set_detail] = useState<SummaryDetail>("standard");
  const [create_subdocuments, set_create_subdocuments] = useState(false);
  const [generation_model_id, set_generation_model_id] = useState<
    string | null
  >(null);
  const [agent_model_id, set_agent_model_id] = useState<string | null>(null);
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
  const [agent_instruction, set_agent_instruction] = useState("");
  const [agent_pending, set_agent_pending] = useState(false);
  const [agent_stage, set_agent_stage] = useState<string | null>(null);
  const [media_pending_id, set_media_pending_id] = useState<string | null>(
    null,
  );
  const [export_pending, set_export_pending] = useState(false);
  const [export_relative_path, set_export_relative_path] = useState<
    string | null
  >(null);
  const compact_layout = use_compact_summary_layout();
  const active_asset_id_ref = useRef<string | null>(
    selected_asset?.asset_id ?? null,
  );
  const active_document_id_ref = useRef<string | null>(null);
  const draft_markdown_ref = useRef("");
  const draft_title_ref = useRef("");

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

  const load_conversation = useCallback(
    async (asset_id: string, signal?: AbortSignal) => {
      set_conversation(await get_summary_conversation(asset_id, signal));
    },
    [],
  );

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
      if (loaded.length > 0) await load_conversation(asset_id, signal);
      else set_conversation(null);
      return loaded;
    },
    [load_conversation],
  );

  useEffect(() => {
    const controller = new AbortController();
    void list_ai_models(controller.signal)
      .then((loaded_models) => {
        set_models(loaded_models);
        set_generation_model_id(
          (current) => current ?? loaded_models[0]?.model_id ?? null,
        );
        set_agent_model_id(
          (current) => current ?? loaded_models[0]?.model_id ?? null,
        );
      })
      .catch((error: unknown) => {
        if (!is_abort_error(error)) on_error?.(error_message(error));
      });
    return () => controller.abort();
  }, [on_error]);

  useEffect(() => {
    active_asset_id_ref.current = selected_asset?.asset_id ?? null;
    set_export_relative_path(null);
    set_export_pending(false);
    if (!selected_asset) {
      set_documents([]);
      set_selected_document_id(null);
      set_conversation(null);
      return;
    }
    const controller = new AbortController();
    set_is_loading(true);
    void load_documents(selected_asset.asset_id, controller.signal)
      .catch((error: unknown) => {
        if (!is_abort_error(error)) on_error?.(error_message(error));
      })
      .finally(() => set_is_loading(false));
    return () => controller.abort();
  }, [load_documents, on_error, selected_asset]);

  useEffect(() => {
    if (!selected_document) return;
    if (active_document_id_ref.current !== selected_document.document_id) {
      active_document_id_ref.current = selected_document.document_id;
      set_draft_markdown(selected_document.markdown);
      set_draft_title(selected_document.title);
      draft_markdown_ref.current = selected_document.markdown;
      draft_title_ref.current = selected_document.title;
      set_dirty(false);
      set_save_status("saved");
      set_selection(null);
    }
  }, [selected_document]);

  useEffect(() => {
    if (!selected_document || !dirty || save_status === "conflict") return;
    const document_id = selected_document.document_id;
    const expected_revision = selected_document.revision;
    const markdown = draft_markdown;
    const title = draft_title.trim() || selected_document.title;
    const timeout = window.setTimeout(() => {
      set_save_status("saving");
      void update_summary_document(document_id, expected_revision, {
        markdown,
        title,
      })
        .then((updated) => {
          set_documents((current) =>
            current.map((document) =>
              document.document_id === updated.document_id ? updated : document,
            ),
          );
          const unchanged =
            draft_markdown_ref.current === markdown &&
            draft_title_ref.current.trim() === title;
          set_dirty(!unchanged);
          set_save_status(unchanged ? "saved" : "saving");
        })
        .catch((error: unknown) => {
          set_save_status(
            error instanceof ApiError && error.status === 409
              ? "conflict"
              : "failed",
          );
        });
    }, AUTO_SAVE_DELAY_MS);
    return () => window.clearTimeout(timeout);
  }, [dirty, draft_markdown, draft_title, save_status, selected_document]);

  async function generate_documents() {
    if (!selected_asset) return;
    set_is_generating(true);
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
      const root =
        generated.find((document) => document.parent_document_id === null) ??
        null;
      set_selected_document_id(root?.document_id ?? null);
      if (root) await load_conversation(selected_asset.asset_id);
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

  async function move_child(document_id: string, direction: -1 | 1) {
    if (!root_document) return;
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
    try {
      set_documents(
        await reorder_summary_children(
          root_document.document_id,
          reordered.map((document) => document.document_id),
        ),
      );
    } catch (error) {
      on_error?.(error_message(error));
    }
  }

  async function send_agent_instruction() {
    if (
      !conversation ||
      !selected_document ||
      !agent_model_id ||
      !agent_instruction.trim()
    )
      return;
    set_agent_pending(true);
    set_agent_stage("正在准备相关分析证据");
    try {
      const instruction = agent_instruction.trim();
      set_agent_instruction("");
      set_conversation((current) =>
        current
          ? {
              ...current,
              messages: [
                ...current.messages,
                {
                  message_id: `optimistic-${Date.now()}`,
                  conversation_id: current.conversation.conversation_id,
                  role: "user",
                  content: instruction,
                  created_at: new Date().toISOString(),
                },
              ],
            }
          : current,
      );
      const run = await create_summary_agent_run(
        conversation.conversation.conversation_id,
        {
          document_id: selected_document.document_id,
          expected_revision: selected_document.revision,
          instruction,
          ai_model_id: agent_model_id,
          selection,
        },
      );
      await stream_summary_agent_run(run.run_id, (event) => {
        if (event.event === "status")
          set_agent_stage(status_label(event.data.stage));
        if (event.event === "reply") {
          set_conversation((current) =>
            current
              ? { ...current, messages: [...current.messages, event.data] }
              : current,
          );
        }
        if (event.event === "proposal") {
          set_conversation((current) =>
            current
              ? { ...current, proposals: [...current.proposals, event.data] }
              : current,
          );
        }
        if (event.event === "error") throw new Error(event.data.message);
      });
      await load_conversation(selected_document.asset_id);
      set_agent_stage(null);
    } catch (error) {
      on_error?.(error_message(error));
      set_agent_stage("运行失败");
    } finally {
      set_agent_pending(false);
    }
  }

  async function resolve_proposal(
    proposal: SummaryEditProposal,
    action: "accept" | "reject",
  ) {
    if (!selected_asset) return;
    try {
      await resolve_summary_proposal(proposal.proposal_id, action);
      const loaded = await load_documents(selected_asset.asset_id);
      const active = loaded.find(
        (document) => document.document_id === selected_document_id,
      );
      if (active) {
        active_document_id_ref.current = null;
        set_selected_document_id(active.document_id);
      }
    } catch (error) {
      on_error?.(error_message(error));
      if (error instanceof ApiError && error.status === 409) {
        await load_conversation(selected_asset.asset_id);
      }
    }
  }

  async function generate_suggested_media(
    suggestion: SummaryMediaSuggestion,
    document_id: string,
  ) {
    const target_document = documents.find(
      (document) => document.document_id === document_id,
    );
    if (!target_document) return;
    set_media_pending_id(suggestion.suggestion_id);
    try {
      const result = await create_summary_media(target_document, suggestion);
      set_documents((current) =>
        current.map((document) =>
          document.document_id === result.document.document_id
            ? result.document
            : document,
        ),
      );
      if (result.document.document_id === selected_document_id) {
        set_draft_markdown(result.document.markdown);
        draft_markdown_ref.current = result.document.markdown;
        set_dirty(false);
        set_save_status("saved");
      }
    } catch (error) {
      on_error?.(error_message(error));
    } finally {
      set_media_pending_id(null);
    }
  }

  if (!selected_asset) {
    return (
      <SummaryEmpty
        title="尚未选择素材"
        description="请先在分析页选择一个已下载的视频。"
      />
    );
  }
  if (is_loading) {
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
      on_select={(document_id) => {
        set_selected_document_id(document_id);
        set_tree_sheet_open(false);
      }}
      on_create={() => set_new_document_open(true)}
      on_move={(document_id, direction) =>
        void move_child(document_id, direction)
      }
      on_delete={set_delete_target}
    />
  );
  const agent_panel = (
    <SummaryAgentPanel
      models={models}
      model_id={agent_model_id}
      on_model_change={set_agent_model_id}
      selection={selection}
      messages={conversation?.messages ?? []}
      proposals={conversation?.proposals ?? []}
      stage={agent_stage}
      instruction={agent_instruction}
      on_instruction_change={set_agent_instruction}
      pending={agent_pending}
      disabled={!conversation}
      on_submit={() => void send_agent_instruction()}
      on_resolve={(proposal, action) => void resolve_proposal(proposal, action)}
      media_pending_id={media_pending_id}
      on_generate_media={(suggestion, document_id) =>
        void generate_suggested_media(suggestion, document_id)
      }
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
        set_dirty(true);
        set_save_status("saving");
      }}
      on_markdown_change={(markdown) => {
        set_draft_markdown(markdown);
        draft_markdown_ref.current = markdown;
        set_dirty(true);
        set_save_status("saving");
      }}
      on_mode_change={set_editor_mode}
      on_selection_change={set_selection}
      on_retry={() => {
        set_save_status("saving");
        set_dirty(true);
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
      className="h-full min-h-0 bg-background"
      aria-label="Markdown 总结工作台"
    >
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
              <SheetHeader className="border-b">
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
          <ResizablePanel id="summary-editor" defaultSize="54%" minSize="35%">
            {editor}
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel
            id="summary-agent"
            defaultSize="26%"
            minSize="20%"
            maxSize="36%"
          >
            {agent_panel}
          </ResizablePanel>
        </ResizablePanelGroup>
      )}
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
                  按章节生成子文档
                </FieldLabel>
                <FieldDescription>
                  默认关闭；主文档会使用相对链接建立目录。
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
  on_delete,
}: {
  root: SummaryDocument;
  children: SummaryDocument[];
  selected_document_id: string;
  on_select: (document_id: string) => void;
  on_create: () => void;
  on_move: (document_id: string, direction: -1 | 1) => void;
  on_delete: (document: SummaryDocument) => void;
}) {
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
              className="group flex min-w-0 items-center gap-1"
              key={document.document_id}
            >
              <DocumentButton
                document={document}
                selected={document.document_id === selected_document_id}
                on_select={on_select}
                className="flex-1"
              />
              <div className="flex shrink-0 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => on_move(document.document_id, -1)}
                  disabled={index === 0}
                  aria-label={`上移 ${document.title}`}
                >
                  <ArrowUp />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => on_move(document.document_id, 1)}
                  disabled={index === children.length - 1}
                  aria-label={`下移 ${document.title}`}
                >
                  <ArrowDown />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => on_delete(document)}
                  aria-label={`删除 ${document.title}`}
                >
                  <Trash2 />
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </nav>
  );
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
          <TabsTrigger value="visual">所见即所得</TabsTrigger>
          <TabsTrigger value="source">源码</TabsTrigger>
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
        <MarkdownEditor
          document_key={`${document.document_id}:${document.revision}`}
          markdown={markdown}
          on_change={on_markdown_change}
          on_selection_change={on_selection_change}
        />
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

function SummaryAgentPanel({
  models,
  model_id,
  on_model_change,
  selection,
  messages,
  proposals,
  stage,
  instruction,
  on_instruction_change,
  pending,
  disabled,
  on_submit,
  on_resolve,
  media_pending_id,
  on_generate_media,
}: {
  models: AiModelSummary[];
  model_id: string | null;
  on_model_change: (model_id: string | null) => void;
  selection: MarkdownSelection | null;
  messages: SummaryMessage[];
  proposals: SummaryEditProposal[];
  stage: string | null;
  instruction: string;
  on_instruction_change: (instruction: string) => void;
  pending: boolean;
  disabled: boolean;
  on_submit: () => void;
  on_resolve: (
    proposal: SummaryEditProposal,
    action: "accept" | "reject",
  ) => void;
  media_pending_id: string | null;
  on_generate_media: (
    suggestion: SummaryMediaSuggestion,
    document_id: string,
  ) => void;
}) {
  return (
    <aside
      className="flex h-full min-h-0 flex-col bg-card"
      aria-label="总结 Agent"
    >
      <div className="flex flex-col gap-3 border-b p-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Bot aria-hidden="true" /> 总结 Agent
        </div>
        <AiModelSelect
          id="summary-agent-model"
          label="对话模型"
          models={models}
          value={model_id}
          on_change={on_model_change}
          disabled={pending}
        />
        <Badge variant="outline" className="max-w-full justify-start truncate">
          {selection
            ? `已选择 ${selection.text.length} 个字符`
            : "当前文档全文"}
        </Badge>
      </div>
      <MessageScroller className="flex-1">
        {messages.length === 0 ? (
          <Empty className="border-0">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <MessageSquareText />
              </EmptyMedia>
              <EmptyTitle>从文档修改开始</EmptyTitle>
              <EmptyDescription>
                选择文字或直接描述希望调整的章节。建议确认后才会应用。
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}
        {messages.map((message) => (
          <Message key={message.message_id} role={message.role}>
            <Bubble role={message.role}>{message.content}</Bubble>
          </Message>
        ))}
        {stage ? (
          <Message role="assistant">
            <Bubble role="assistant">{stage}</Bubble>
          </Message>
        ) : null}
        {proposals.map((proposal) => (
          <ProposalCard
            key={proposal.proposal_id}
            proposal={proposal}
            on_resolve={on_resolve}
            media_pending_id={media_pending_id}
            on_generate_media={on_generate_media}
          />
        ))}
      </MessageScroller>
      <MessageComposer
        value={instruction}
        on_change={on_instruction_change}
        on_submit={on_submit}
        pending={pending}
        disabled={disabled || !model_id}
      />
    </aside>
  );
}

function ProposalCard({
  proposal,
  on_resolve,
  media_pending_id,
  on_generate_media,
}: {
  proposal: SummaryEditProposal;
  on_resolve: (
    proposal: SummaryEditProposal,
    action: "accept" | "reject",
  ) => void;
  media_pending_id: string | null;
  on_generate_media: (
    suggestion: SummaryMediaSuggestion,
    document_id: string,
  ) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">修改建议</CardTitle>
        <CardDescription>{proposal.explanation}</CardDescription>
      </CardHeader>
      <CardContent>
        <pre className="max-h-40 overflow-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap">
          {proposal.diff || "文档内容已重新整理。"}
        </pre>
        {proposal.media_suggestions.length > 0 ? (
          <div className="mt-3 flex flex-col gap-2">
            {proposal.media_suggestions.map((suggestion) => (
              <div
                className="flex items-center justify-between gap-2 rounded-md border p-2"
                key={suggestion.suggestion_id}
              >
                <div className="min-w-0 text-xs">
                  <strong className="block truncate">
                    {suggestion.caption}
                  </strong>
                  <span className="text-muted-foreground">
                    {suggestion.media_type === "gif" ? "GIF" : "图片"} ·{" "}
                    {suggestion.start_seconds.toFixed(1)} 秒
                  </span>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    on_generate_media(suggestion, proposal.document_id)
                  }
                  disabled={media_pending_id !== null}
                >
                  {media_pending_id === suggestion.suggestion_id ? (
                    <Spinner data-icon="inline-start" />
                  ) : null}
                  生成
                </Button>
              </div>
            ))}
          </div>
        ) : null}
      </CardContent>
      <CardFooter className="justify-between">
        <Badge
          variant={proposal.status === "stale" ? "destructive" : "secondary"}
        >
          {proposal_status_label(proposal.status)}
        </Badge>
        {proposal.status === "pending" ? (
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => on_resolve(proposal, "reject")}
            >
              拒绝
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => on_resolve(proposal, "accept")}
            >
              接受
            </Button>
          </div>
        ) : null}
      </CardFooter>
    </Card>
  );
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

function status_label(stage: string): string {
  return stage === "running"
    ? "正在整理修改建议"
    : stage === "pending"
      ? "等待 Agent 开始"
      : stage;
}

function proposal_status_label(status: SummaryEditProposal["status"]): string {
  return {
    pending: "待确认",
    accepted: "已接受",
    rejected: "已拒绝",
    stale: "已过期",
  }[status];
}
