import {
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
  Bot,
  ChevronDown,
  Code2,
  Download,
  Eye,
  FilePlus2,
  FileText,
  FolderTree,
  GripVertical,
  History,
  MessageSquareText,
  MoreVertical,
  PanelLeft,
  PanelRight,
  Plus,
  Save,
  Trash2,
} from "lucide-react";

import { AiModelSelect } from "@/components/AiModelSelect";
import { RESOURCE_QUERY_KEYS } from "@/app/query_cache";
import {
  MarkdownEditor,
  type MarkdownSelection,
} from "@/components/MarkdownEditor";
import {
  Bubble,
  Marker,
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
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
  create_summary_agent_message,
  create_summary_agent_session,
  create_summary_child,
  create_summary_media,
  delete_summary_document,
  delete_summary_agent_session,
  generate_summary_documents,
  get_summary_agent_session,
  list_summary_agent_sessions,
  list_summary_documents,
  reorder_summary_children,
  resolve_summary_proposal,
  stream_agent_run,
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
  AgentEvent,
  SummaryAgentSessionState,
  SummaryAgentSession,
  SummaryDetail,
  SummaryDocument,
  SummaryEditProposal,
  SummaryMediaSuggestion,
  Transcript,
} from "@/shared/types";
import {
  AgentToolTrace,
  type AgentToolTraceData,
} from "./SummaryAgentToolTrace";

const AUTO_SAVE_DELAY_MS = 1_000;
const SUMMARY_TIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

type SaveStatus = "saved" | "saving" | "failed" | "conflict";

type SummaryWorkspaceProps = {
  selected_asset: MediaAsset | null;
  segments: MediaSegment[];
  transcript: Transcript | null;
  on_error?: (message: string | null) => void;
};

type SummaryProject = {
  documents: SummaryDocument[];
  sessions: SummaryAgentSession[];
  session: SummaryAgentSessionState | null;
};

const EMPTY_SUMMARY_PROJECT: SummaryProject = {
  documents: [],
  sessions: [],
  session: null,
};

async function load_summary_project(
  asset_id: string,
  signal?: AbortSignal,
): Promise<SummaryProject> {
  const documents = await list_summary_documents(asset_id, signal);
  if (documents.length === 0) return EMPTY_SUMMARY_PROJECT;
  const sessions = await list_summary_agent_sessions(asset_id, signal);
  const active_session = sessions[0];
  const session = active_session
    ? await get_summary_agent_session(active_session.session.session_id, signal)
    : null;
  return { documents, sessions, session };
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
  const [agent_sessions, set_agent_sessions] = useState<SummaryAgentSession[]>(
    initial_project.sessions,
  );
  const [agent_session, set_agent_session] =
    useState<SummaryAgentSessionState | null>(initial_project.session);
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
  const [delete_session_target, set_delete_session_target] =
    useState<SummaryAgentSession | null>(null);
  const [reordering, set_reordering] = useState(false);
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
  const active_document_revision_ref = useRef<number | null>(null);
  const draft_markdown_ref = useRef("");
  const draft_title_ref = useRef("");
  const dirty_ref = useRef(false);
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

  const load_agent_session = useCallback(
    async (session_id: string, signal?: AbortSignal) => {
      set_agent_session(await get_summary_agent_session(session_id, signal));
    },
    [],
  );

  const load_agent_sessions = useCallback(
    async (
      asset_id: string,
      signal?: AbortSignal,
      preferred_session_id?: string,
    ) => {
      const loaded = await list_summary_agent_sessions(asset_id, signal);
      set_agent_sessions(loaded);
      const active =
        loaded.find(
          (item) => item.session.session_id === preferred_session_id,
        ) ?? loaded[0];
      if (active) await load_agent_session(active.session.session_id, signal);
      else set_agent_session(null);
      return loaded;
    },
    [load_agent_session],
  );

  const load_documents = useCallback(
    async (
      asset_id: string,
      signal?: AbortSignal,
      preferred_session_id?: string,
    ) => {
      const loaded = await list_summary_documents(asset_id, signal);
      set_documents(loaded);
      set_selected_document_id((current) =>
        loaded.some((document) => document.document_id === current)
          ? current
          : (loaded.find((document) => document.parent_document_id === null)
              ?.document_id ?? null),
      );
      if (loaded.length > 0) {
        await load_agent_sessions(asset_id, signal, preferred_session_id);
      } else {
        set_agent_sessions([]);
        set_agent_session(null);
      }
      return loaded;
    },
    [load_agent_sessions],
  );

  useEffect(() => {
    set_generation_model_id(
      (current) => current ?? models[0]?.model_id ?? null,
    );
    set_agent_model_id((current) => current ?? models[0]?.model_id ?? null);
  }, [models]);

  useEffect(() => {
    const resource_error =
      models_error ??
      (project_query.error ? error_message(project_query.error) : null);
    if (resource_error) on_error?.(resource_error);
  }, [models_error, on_error, project_query.error]);

  useEffect(() => {
    active_asset_id_ref.current = selected_asset_id;
    set_export_relative_path(null);
    set_export_pending(false);
    if (!selected_asset_id) {
      set_documents([]);
      set_selected_document_id(null);
      set_agent_sessions([]);
      set_agent_session(null);
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
    set_agent_sessions(project.sessions);
    set_agent_session(project.session);
  }, [project_query.data]);

  useEffect(() => {
    project_state_ref.current = {
      documents,
      sessions: agent_sessions,
      session: agent_session,
    };
  }, [agent_session, agent_sessions, documents]);

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
      active_document_id_ref.current = selected_document.document_id;
      active_document_revision_ref.current = selected_document.revision;
      set_draft_markdown(selected_document.markdown);
      set_draft_title(selected_document.title);
      draft_markdown_ref.current = selected_document.markdown;
      draft_title_ref.current = selected_document.title;
      update_dirty(false);
      set_save_status("saved");
      set_selection(null);
    }
  }, [dirty, selected_document, update_dirty]);

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
          update_dirty(!unchanged);
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
  }, [
    dirty,
    draft_markdown,
    draft_title,
    save_status,
    selected_document,
    update_dirty,
  ]);

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
      if (root) await load_agent_sessions(selected_asset.asset_id);
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

  async function create_agent_session() {
    if (!selected_asset || !selected_document || agent_pending) return;
    try {
      const created = await create_summary_agent_session(
        selected_asset.asset_id,
        selected_document.document_id,
      );
      set_agent_sessions((current) => [created, ...current]);
      set_agent_session(created);
      set_agent_instruction("");
      set_agent_stage(null);
    } catch (error) {
      on_error?.(error_message(error));
    }
  }

  async function select_agent_session(session_id: string) {
    if (agent_pending || agent_session?.session.session_id === session_id)
      return;
    try {
      await load_agent_session(session_id);
      set_agent_instruction("");
      set_agent_stage(null);
    } catch (error) {
      on_error?.(error_message(error));
    }
  }

  async function remove_agent_session() {
    if (!delete_session_target || !selected_asset) return;
    const deleted_id = delete_session_target.session.session_id;
    try {
      await delete_summary_agent_session(deleted_id);
      const remaining = agent_sessions.filter(
        (item) => item.session.session_id !== deleted_id,
      );
      set_delete_session_target(null);
      await load_agent_sessions(
        selected_asset.asset_id,
        undefined,
        remaining[0]?.session.session_id,
      );
    } catch (error) {
      on_error?.(error_message(error));
    }
  }

  async function send_agent_instruction() {
    if (
      !agent_session ||
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
      set_agent_session((current) =>
        current
          ? {
              ...current,
              events: [
                ...current.events,
                optimistic_agent_event(current.session.session_id, instruction),
              ],
            }
          : current,
      );
      const run = await create_summary_agent_message(
        agent_session.session.session_id,
        {
          document_id: selected_document.document_id,
          expected_revision: selected_document.revision,
          content: instruction,
          ai_model_id: agent_model_id,
          selection,
        },
      );
      await stream_agent_run<SummaryEditProposal>(run.run_id, (event) => {
        if (event.event === "status")
          set_agent_stage(status_label(event.data.stage));
        if (
          event.event === "assistant_chunk" ||
          event.event === "assistant_message" ||
          event.event === "tool_call" ||
          event.event === "tool_result"
        ) {
          const event_types = {
            assistant_chunk: "assistant/chunk",
            assistant_message: "assistant/message",
            tool_call: "tool/call",
            tool_result: "tool/result",
          } as const;
          set_agent_session((current) =>
            current
              ? {
                  ...current,
                  events: append_agent_event(
                    current.events,
                    stream_agent_event(
                      current.session.session_id,
                      run.run_id,
                      event.data,
                      event_types[event.event],
                    ),
                  ),
                }
              : current,
          );
        }
        if (event.event === "proposal") {
          set_agent_session((current) =>
            current
              ? {
                  ...current,
                  proposals: [...current.proposals, event.data.proposal],
                }
              : current,
          );
        }
        if (event.event === "error") throw new Error(event.data.message);
      });
      await load_agent_sessions(
        selected_document.asset_id,
        undefined,
        agent_session.session.session_id,
      );
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
      const loaded = await load_documents(
        selected_asset.asset_id,
        undefined,
        agent_session?.session.session_id,
      );
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
        if (agent_session) {
          await load_agent_session(agent_session.session.session_id);
        }
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
        update_dirty(false);
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
      on_select={(document_id) => {
        set_selected_document_id(document_id);
        set_tree_sheet_open(false);
      }}
      on_create={() => set_new_document_open(true)}
      on_move={(document_id, direction) => move_child(document_id, direction)}
      on_reorder={(document_ids) => void reorder_children(document_ids)}
      reordering={reordering}
      on_delete={set_delete_target}
    />
  );
  const agent_panel = (
    <SummaryAgentPanel
      models={models}
      sessions={agent_sessions}
      session={agent_session}
      model_id={agent_model_id}
      on_model_change={set_agent_model_id}
      selection={selection}
      documents={documents}
      selected_document={selected_document}
      events={agent_session?.events ?? []}
      proposals={agent_session?.proposals ?? []}
      stage={agent_stage}
      instruction={agent_instruction}
      on_instruction_change={set_agent_instruction}
      pending={agent_pending}
      disabled={!agent_session}
      on_submit={() => void send_agent_instruction()}
      on_new_session={() => void create_agent_session()}
      on_select_session={(session_id) => void select_agent_session(session_id)}
      on_delete_session={set_delete_session_target}
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
        update_dirty(true);
        set_save_status("saving");
      }}
      on_markdown_change={(markdown) => {
        set_draft_markdown(markdown);
        draft_markdown_ref.current = markdown;
        update_dirty(true);
        set_save_status("saving");
      }}
      on_mode_change={set_editor_mode}
      on_selection_change={set_selection}
      on_retry={() => {
        set_save_status("saving");
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
      <DeleteAgentSessionDialog
        session={delete_session_target}
        on_open_change={(open) => {
          if (!open) set_delete_session_target(null);
        }}
        on_confirm={() => void remove_agent_session()}
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
        <MarkdownEditor
          document_key={document.document_id}
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

type AgentDisplayMessage = {
  message_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
};

type AgentTimelineItem =
  | { type: "message"; created_at: string; message: AgentDisplayMessage }
  | { type: "tool"; created_at: string; trace: AgentToolTraceData };

function optimistic_agent_event(
  session_id: string,
  content: string,
): AgentEvent {
  const event_id = `optimistic-${Date.now()}`;
  return {
    event_id,
    session_id,
    sequence: Number.MAX_SAFE_INTEGER,
    run_id: null,
    event_type: "user/message",
    payload: { content },
    created_at: new Date().toISOString(),
  };
}

function stream_agent_event(
  session_id: string,
  run_id: string,
  data: { event_id: string; sequence: number } & Record<string, unknown>,
  event_type: AgentEvent["event_type"],
): AgentEvent {
  const { event_id, sequence, ...payload } = data;
  return {
    event_id,
    session_id,
    sequence,
    run_id,
    event_type,
    payload,
    created_at: new Date().toISOString(),
  };
}

function append_agent_event(
  events: AgentEvent[],
  event: AgentEvent,
): AgentEvent[] {
  if (events.some((item) => item.event_id === event.event_id)) return events;
  return [...events, event];
}

function agent_event_timeline(events: AgentEvent[]): AgentTimelineItem[] {
  const completed_run_ids = new Set(
    events
      .filter((event) => event.event_type === "assistant/message")
      .map((event) => event.run_id),
  );
  const streaming_messages = new Map<string, AgentDisplayMessage>();
  const tool_traces = new Map<
    string,
    { created_at: string; trace: AgentToolTraceData }
  >();
  const timeline: AgentTimelineItem[] = [];

  for (const event of events) {
    if (event.event_type === "assistant/chunk" && event.run_id) {
      if (completed_run_ids.has(event.run_id)) continue;
      const current = streaming_messages.get(event.run_id);
      streaming_messages.set(event.run_id, {
        message_id: `stream-${event.run_id}`,
        role: "assistant",
        content: `${current?.content ?? ""}${String(event.payload.content ?? "")}`,
        created_at: current?.created_at ?? event.created_at,
      });
      continue;
    }
    if (
      event.event_type === "user/message" ||
      event.event_type === "assistant/message" ||
      event.event_type === "archive/message"
    ) {
      const role =
        event.event_type === "user/message"
          ? "user"
          : event.event_type === "assistant/message"
            ? "assistant"
            : event.payload.role === "user"
              ? "user"
              : "assistant";
      const content = String(event.payload.content ?? "");
      if (!content) continue;
      const created_at =
        typeof event.payload.created_at === "string"
          ? event.payload.created_at
          : event.created_at;
      timeline.push({
        type: "message",
        created_at,
        message: {
          message_id: event.event_id,
          role,
          content,
          created_at,
        },
      });
      continue;
    }
    if (event.event_type === "tool/call") {
      const call_id = String(event.payload.call_id ?? "");
      if (!call_id) continue;
      tool_traces.set(call_id, {
        created_at: event.created_at,
        trace: {
          call_id,
          name: String(event.payload.name ?? "unknown_tool"),
          arguments:
            typeof event.payload.arguments === "object" &&
            event.payload.arguments !== null
              ? (event.payload.arguments as Record<string, unknown>)
              : {},
        },
      });
      continue;
    }
    if (event.event_type === "tool/result") {
      const call_id = String(event.payload.call_id ?? "");
      const current = tool_traces.get(call_id);
      if (current) current.trace.result = event.payload.result;
    }
  }
  for (const message of streaming_messages.values()) {
    timeline.push({ type: "message", created_at: message.created_at, message });
  }
  for (const trace of tool_traces.values()) {
    timeline.push({ type: "tool", ...trace });
  }
  return timeline;
}

function SummaryAgentPanel({
  models,
  sessions,
  session,
  model_id,
  on_model_change,
  selection,
  documents,
  selected_document,
  events,
  proposals,
  stage,
  instruction,
  on_instruction_change,
  pending,
  disabled,
  on_submit,
  on_new_session,
  on_select_session,
  on_delete_session,
  on_resolve,
  media_pending_id,
  on_generate_media,
}: {
  models: AiModelSummary[];
  sessions: SummaryAgentSession[];
  session: SummaryAgentSessionState | null;
  model_id: string | null;
  on_model_change: (model_id: string | null) => void;
  selection: MarkdownSelection | null;
  documents: SummaryDocument[];
  selected_document: SummaryDocument;
  events: AgentEvent[];
  proposals: SummaryEditProposal[];
  stage: string | null;
  instruction: string;
  on_instruction_change: (instruction: string) => void;
  pending: boolean;
  disabled: boolean;
  on_submit: () => void;
  on_new_session: () => void;
  on_select_session: (session_id: string) => void;
  on_delete_session: (session: SummaryAgentSession) => void;
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
  const timeline = [
    ...agent_event_timeline(events),
    ...proposals.map((proposal) => ({
      type: "proposal" as const,
      created_at: proposal.created_at,
      proposal,
    })),
  ].sort((left, right) => left.created_at.localeCompare(right.created_at));

  return (
    <aside
      className="flex h-full min-h-0 flex-col bg-card"
      aria-label="总结 Agent"
    >
      <div className="flex flex-col gap-3 border-b p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
            <Bot aria-hidden="true" /> 总结 Agent
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={on_new_session}
              disabled={pending}
              aria-label="新建 Agent 对话"
            >
              <Plus />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => session && on_delete_session(session)}
              disabled={pending || sessions.length <= 1 || !session}
              aria-label="删除当前 Agent 对话"
            >
              <Trash2 />
            </Button>
          </div>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              className="w-full justify-between"
              disabled={pending || !session}
            >
              <span className="flex min-w-0 items-center gap-2">
                <History data-icon="inline-start" />
                <span className="truncate">
                  {session?.session.title ?? "选择历史"}
                </span>
              </span>
              <ChevronDown data-icon="inline-end" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>
              Agent 历史 · {sessions.length} 条
            </DropdownMenuLabel>
            <DropdownMenuGroup>
              {sessions.map((item) => (
                <DropdownMenuItem
                  key={item.session.session_id}
                  onSelect={() => on_select_session(item.session.session_id)}
                >
                  <History />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{item.session.title}</span>
                    <time className="text-xs text-muted-foreground">
                      {format_summary_time(item.session.updated_at)}
                    </time>
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem onSelect={on_new_session}>
                <Plus /> 新建对话
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <AiModelSelect
          id="summary-agent-model"
          label="对话模型"
          models={models}
          value={model_id}
          on_change={on_model_change}
          disabled={pending}
        />
        <Badge variant="outline" className="max-w-full justify-start truncate">
          {selected_document.title} ·{" "}
          {selection ? `已选择 ${selection.text.length} 个字符` : "全文"}
        </Badge>
      </div>
      <MessageScroller className="flex-1">
        {timeline.length === 0 ? (
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
        {timeline.map((item) =>
          item.type === "message" ? (
            <Message key={item.message.message_id} role={item.message.role}>
              <div className="flex max-w-[88%] flex-col gap-1">
                <Bubble role={item.message.role} className="max-w-full">
                  {item.message.content}
                </Bubble>
                <time className="px-1 text-xs text-muted-foreground">
                  {format_summary_time(item.message.created_at)}
                </time>
              </div>
            </Message>
          ) : item.type === "tool" ? (
            <AgentToolTrace
              key={item.trace.call_id}
              trace={item.trace}
            />
          ) : (
            <ProposalCard
              key={item.proposal.proposal_id}
              proposal={item.proposal}
              document_title={
                documents.find(
                  (document) =>
                    document.document_id === item.proposal.document_id,
                )?.title ?? "已删除文档"
              }
              on_resolve={on_resolve}
              media_pending_id={media_pending_id}
              on_generate_media={on_generate_media}
            />
          ),
        )}
        {stage ? <Marker>{stage}</Marker> : null}
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
  document_title,
  on_resolve,
  media_pending_id,
  on_generate_media,
}: {
  proposal: SummaryEditProposal;
  document_title: string;
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
    <Card size="sm">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm">修改建议</CardTitle>
          <Badge
            variant={proposal.status === "stale" ? "destructive" : "secondary"}
          >
            {proposal_status_label(proposal.status)}
          </Badge>
        </div>
        <CardDescription>{proposal.explanation}</CardDescription>
        <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
          <span>{document_title}</span>
          <span>版本 {proposal.base_revision}</span>
          <time>{format_summary_time(proposal.created_at)}</time>
        </div>
      </CardHeader>
      {proposal.status === "pending" ? (
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
      ) : null}
      <CardFooter className="justify-between">
        <span className="text-xs text-muted-foreground">
          {proposal.status === "pending" ? "确认后才会写入文档" : "处理完成"}
        </span>
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

function DeleteAgentSessionDialog({
  session,
  on_open_change,
  on_confirm,
}: {
  session: SummaryAgentSession | null;
  on_open_change: (open: boolean) => void;
  on_confirm: () => void;
}) {
  return (
    <Dialog open={session !== null} onOpenChange={on_open_change}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>删除 Agent 历史</DialogTitle>
          <DialogDescription>
            “{session?.session.title}”中的消息和修改建议将永久删除。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">取消</Button>
          </DialogClose>
          <Button variant="destructive" onClick={on_confirm}>
            删除历史
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
  const labels: Record<string, string> = {
    pending: "等待 Agent 开始",
    running: "Agent 正在思考",
    degraded: "当前模型已降级为纯聊天",
    cancelled: "运行已取消",
    interrupted: "运行被应用重启中断",
  };
  return labels[stage] ?? stage;
}

function proposal_status_label(status: SummaryEditProposal["status"]): string {
  return {
    pending: "待确认",
    accepted: "已接受",
    rejected: "已拒绝",
    stale: "已过期",
  }[status];
}

function format_summary_time(value: string): string {
  const time = new Date(value);
  return Number.isNaN(time.getTime())
    ? value
    : SUMMARY_TIME_FORMATTER.format(time);
}
