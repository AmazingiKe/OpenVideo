import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, TriangleAlert } from "lucide-react";

import { RESOURCE_QUERY_KEYS } from "@/app/query_cache";
import type { MarkdownSelection } from "@/components/MarkdownEditor";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  create_summary_export,
  create_summary_child,
  delete_summary_document,
  duplicate_summary_document,
  generate_summary_documents,
  get_asset_summary_illustration_job,
  get_summary_illustration_job,
  list_summary_documents,
  list_summary_presets,
  move_summary_document,
  subscribe_summary_documents,
  update_summary_document,
} from "@/shared/api";
import { error_message } from "@/shared/errors";
import { use_compact_summary_layout } from "@/features/summary/use_compact_summary_layout";
import { create_summary_save_metadata } from "@/features/summary/summary_save_metadata";
import { use_summary_autosave } from "@/features/summary/use_summary_autosave";
import { apply_document_placement } from "./SummaryDocumentNavigation";
import {
  load_summary_project,
  type SummaryProjectSnapshot,
} from "@/features/summary/load_summary_project";
import { use_ai_models } from "@/features/workbench/use_processing_resources";
import type {
  AgentArtifact,
  AiModelSummary,
  MediaAsset,
  MediaSegment,
  SummaryDetail,
  SummaryDocument,
  SummaryIllustrationJob,
  SummaryPreset,
  Transcript,
} from "@/shared/types";
import { SummaryEmpty, SummaryGeneration } from "./SummaryWorkspacePanels";
import { SummaryEditorLayout } from "./SummaryEditorLayout";

const ILLUSTRATION_POLL_DELAY_MS = 750;
const TERMINAL_ILLUSTRATION_STAGES = new Set(["complete", "failed"]);

type SummaryWorkspaceProps = {
  selected_asset: MediaAsset | null;
  segments: MediaSegment[];
  transcript: Transcript | null;
  on_error?: (message: string | null) => void;
};

const EMPTY_SUMMARY_PROJECT: SummaryProjectSnapshot = {
  documents: [],
};

export function SummaryWorkspace({
  selected_asset,
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
  const presets_query = useQuery({
    queryKey: ["summary-presets"],
    queryFn: ({ signal }) => list_summary_presets(signal),
  });
  const presets = useMemo(() => presets_query.data ?? [], [presets_query.data]);
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
  const [generation_preset_id, set_generation_preset_id] = useState("");
  const [generation_user_input, set_generation_user_input] = useState("");
  const [output_language, set_output_language] = useState("zh-CN");
  const [generation_open, set_generation_open] = useState(false);
  const [generation_notice, set_generation_notice] = useState<string | null>(
    null,
  );
  const [illustration_job, set_illustration_job] =
    useState<SummaryIllustrationJob | null>(null);
  const [generation_model_id, set_generation_model_id] = useState<
    string | null
  >(null);
  const [editor_mode, set_editor_mode] = useState<"visual" | "source">(
    "visual",
  );
  const [selection, set_selection] = useState<MarkdownSelection | null>(null);
  const [tree_sheet_open, set_tree_sheet_open] = useState(false);
  const [new_document_open, set_new_document_open] = useState(false);
  const [new_document_parent_id, set_new_document_parent_id] = useState<
    string | null
  >(null);
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
  const project_loaded_ref = useRef(project_query.data !== undefined);
  const project_state_ref = useRef<SummaryProjectSnapshot>(initial_project);

  const selected_document = useMemo(
    () =>
      documents.find(
        (document) => document.document_id === selected_document_id,
      ) ?? null,
    [documents, selected_document_id],
  );
  const root_document =
    documents.find((document) => document.parent_document_id === null) ?? null;
  const handle_document_saved = useCallback((updated: SummaryDocument) => {
    set_documents((current) =>
      current.map((document) =>
        document.document_id === updated.document_id ? updated : document,
      ),
    );
  }, []);
  const handle_recovery_target = useCallback(
    (document_id: string) => {
      if (!documents.some((document) => document.document_id === document_id)) {
        return false;
      }
      set_selected_document_id(document_id);
      return true;
    },
    [documents],
  );
  const autosave = use_summary_autosave({
    asset_id: selected_asset_id,
    document: selected_document,
    on_document_saved: handle_document_saved,
    on_recovery_target: handle_recovery_target,
    on_local_draft_error: on_error,
  });
  const has_unsaved_changes = autosave.has_unsaved_changes;

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
    set_generation_preset_id(
      (current) => current || presets[0]?.preset_id || "",
    );
  }, [presets]);

  useEffect(() => {
    const background_project_error =
      project_query.error && documents.length > 0
        ? error_message(project_query.error)
        : null;
    const resource_error =
      models_error ??
      (presets_query.error ? error_message(presets_query.error) : null) ??
      background_project_error;
    if (resource_error) on_error?.(resource_error);
  }, [
    documents.length,
    models_error,
    on_error,
    presets_query.error,
    project_query.error,
  ]);

  useEffect(() => {
    active_asset_id_ref.current = selected_asset_id;
    set_generation_notice(null);
    set_illustration_job(null);
    set_export_relative_path(null);
    set_export_pending(false);
    set_generation_open(false);
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
    if (!selected_asset_id || documents.length === 0) {
      set_illustration_job(null);
      return;
    }
    const controller = new AbortController();
    void get_asset_summary_illustration_job(
      selected_asset_id,
      controller.signal,
    )
      .then((job) => set_illustration_job(job))
      .catch(() => undefined);
    return () => controller.abort();
  }, [documents.length, selected_asset_id]);

  useEffect(() => {
    if (
      !illustration_job ||
      TERMINAL_ILLUSTRATION_STAGES.has(illustration_job.stage)
    )
      return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      void get_summary_illustration_job(
        illustration_job.job_id,
        controller.signal,
      )
        .then(async (job) => {
          set_illustration_job(job);
          if (
            TERMINAL_ILLUSTRATION_STAGES.has(job.stage) &&
            active_asset_id_ref.current === job.asset_id &&
            !has_unsaved_changes()
          ) {
            set_documents(await list_summary_documents(job.asset_id));
          }
        })
        .catch(() => undefined);
    }, ILLUSTRATION_POLL_DELAY_MS);
    return () => {
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [has_unsaved_changes, illustration_job]);

  useEffect(() => {
    project_state_ref.current = {
      documents,
    };
  }, [documents]);

  useEffect(() => {
    return () => {
      if (!selected_asset_id || !project_loaded_ref.current) return;
      query_client.setQueryData<SummaryProjectSnapshot>(
        RESOURCE_QUERY_KEYS.summary_project(selected_asset_id),
        project_state_ref.current,
      );
    };
  }, [query_client, selected_asset_id]);

  useEffect(() => {
    if (!selected_asset) return;
    return subscribe_summary_documents(selected_asset.asset_id, (loaded) => {
      if (has_unsaved_changes()) return;
      set_documents(loaded);
      set_selected_document_id((current) =>
        loaded.some((document) => document.document_id === current)
          ? current
          : (loaded.find((document) => document.parent_document_id === null)
              ?.document_id ?? null),
      );
    });
  }, [has_unsaved_changes, selected_asset]);

  async function select_document(document_id: string) {
    if (selected_document_id === document_id) {
      set_tree_sheet_open(false);
      return;
    }
    const target_document = documents.find(
      (document) => document.document_id === document_id,
    );
    if (!target_document) return;

    await autosave.flush();
    set_selected_document_id(document_id);
    set_selection(null);
    set_tree_sheet_open(false);
  }

  async function generate_documents() {
    if (!selected_asset || !generation_model_id || !generation_preset_id)
      return;
    if (!(await autosave.flush())) return;
    set_is_generating(true);
    set_generation_notice(null);
    on_error?.(null);
    try {
      const result = await generate_summary_documents(selected_asset.asset_id, {
        ai_model_id: generation_model_id,
        preset_id: generation_preset_id,
        user_input: generation_user_input.trim() || null,
        detail,
        output_language,
      });
      const generated = result.documents;
      set_documents(generated);
      set_illustration_job(result.illustration_job);
      set_generation_open(false);
      set_generation_notice(
        result.context_capacity_unknown
          ? "模型容量未知；本次已使用完整上下文完成生成。"
          : null,
      );
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
    if (!new_document_parent_id || !new_document_title.trim()) return;
    try {
      const created = await create_summary_child(
        new_document_parent_id,
        new_document_title.trim(),
      );
      set_documents((current) => [...current, created]);
      set_selected_document_id(created.document_id);
      set_new_document_title("");
      set_new_document_parent_id(null);
      set_new_document_open(false);
      set_tree_sheet_open(false);
    } catch (error) {
      on_error?.(error_message(error));
    }
  }

  async function remove_child() {
    if (!delete_target || !selected_asset) return;
    try {
      await delete_summary_document(delete_target.document_id);
      await load_documents(selected_asset.asset_id);
      set_delete_target(null);
    } catch (error) {
      on_error?.(error_message(error));
    }
  }

  async function move_document(
    document_id: string,
    parent_document_id: string,
    position: number,
  ) {
    if (reordering) return;
    const previous_documents = documents;
    const reordered_documents = apply_document_placement(
      previous_documents,
      document_id,
      parent_document_id,
      position,
    );
    if (reordered_documents === previous_documents) return;
    const previous_placements = new Map(
      previous_documents.map((document) => [
        document.document_id,
        {
          parent_document_id: document.parent_document_id,
          position: document.position,
        },
      ]),
    );
    set_reordering(true);
    set_documents(reordered_documents);
    try {
      set_documents(
        await move_summary_document(document_id, parent_document_id, position),
      );
    } catch (error) {
      set_documents((current) =>
        current.map((document) => {
          const previous = previous_placements.get(document.document_id);
          return previous
            ? {
                ...document,
                parent_document_id: previous.parent_document_id,
                position: previous.position,
              }
            : document;
        }),
      );
      on_error?.(error_message(error));
    } finally {
      set_reordering(false);
    }
  }

  function open_new_document(parent_document_id: string) {
    set_new_document_parent_id(parent_document_id);
    set_new_document_title("");
    set_new_document_open(true);
  }

  async function duplicate_document(document: SummaryDocument) {
    if (
      document.document_id === selected_document_id &&
      !(await autosave.flush())
    )
      return;
    try {
      const created = await duplicate_summary_document(document.document_id);
      set_documents((current) => [...current, created]);
      set_selected_document_id(created.document_id);
      set_tree_sheet_open(false);
    } catch (error) {
      on_error?.(error_message(error));
    }
  }

  async function rename_document(document: SummaryDocument, title: string) {
    const next_title = title.trim();
    if (!next_title || next_title === document.title) return;
    if (document.document_id === selected_document_id) {
      autosave.change_title(next_title);
      return;
    }
    try {
      const updated = await update_summary_document(
        document.document_id,
        { title: next_title },
        create_summary_save_metadata(),
      );
      set_documents((current) =>
        current.map((item) =>
          item.document_id === updated.document_id ? updated : item,
        ),
      );
    } catch (error) {
      on_error?.(error_message(error));
    }
  }

  if (selected_asset && project_query.isError && documents.length === 0) {
    return (
      <SummaryEmpty
        title="总结项目暂时无法加载"
        description={error_message(project_query.error)}
        icon={TriangleAlert}
        action={
          <Button
            type="button"
            variant="outline"
            disabled={project_query.isFetching}
            onClick={() => void project_query.refetch()}
          >
            {project_query.isFetching ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <RefreshCw data-icon="inline-start" />
            )}
            {project_query.isFetching ? "正在重试" : "重新加载"}
          </Button>
        }
      />
    );
  }
  if (
    !selected_asset ||
    (project_query.isPending && documents.length === 0) ||
    documents.length === 0
  ) {
    return (
      <SummaryWorkspaceInitialState
        selected_asset={selected_asset}
        loading={project_query.isPending}
        transcript={transcript}
        models={models}
        presets={presets}
        model_id={generation_model_id}
        on_model_change={set_generation_model_id}
        detail={detail}
        on_detail_change={set_detail}
        preset_id={generation_preset_id}
        on_preset_change={set_generation_preset_id}
        user_input={generation_user_input}
        on_user_input_change={set_generation_user_input}
        output_language={output_language}
        on_output_language_change={set_output_language}
        is_generating={is_generating}
        on_generate={() => void generate_documents()}
      />
    );
  }
  if (!selected_document || !root_document) return null;
  const editor_asset_id = selected_asset.asset_id;
  const editor_document_id = selected_document.document_id;

  async function refresh_approved_artifact(artifact: AgentArtifact) {
    if (artifact.status !== "approved") return;
    const loaded = await load_documents(editor_asset_id);
    const active = loaded.find(
      (document) => document.document_id === editor_document_id,
    );
    if (active) {
      set_selected_document_id(active.document_id);
    }
  }

  return (
    <>
      <SummaryEditorLayout
        compact_layout={compact_layout}
        create_child={() => void add_child()}
        delete_target={delete_target}
        documents={documents}
        draft_markdown={autosave.markdown}
        draft_title={autosave.title}
        editor_mode={editor_mode}
        export_pending={export_pending}
        export_relative_path={export_relative_path}
        generation_notice={generation_notice}
        illustration_job={illustration_job}
        move_document={(document_id, parent_document_id, position) =>
          void move_document(document_id, parent_document_id, position)
        }
        new_document_open={new_document_open}
        new_document_title={new_document_title}
        on_artifact_change={refresh_approved_artifact}
        on_delete_confirm={() => void remove_child()}
        on_export={() => void export_summary()}
        on_markdown_change={autosave.change_markdown}
        on_duplicate_document={(document) => void duplicate_document(document)}
        on_open_new_document={open_new_document}
        on_rename_document={(document, title) =>
          void rename_document(document, title)
        }
        on_retry={autosave.retry}
        on_title_change={autosave.change_title}
        remove_delete_target={() => set_delete_target(null)}
        reordering={reordering}
        save_status={autosave.status}
        selected_asset_id={editor_asset_id}
        selected_document={selected_document}
        on_regenerate={() => set_generation_open(true)}
        selection={selection}
        select_document={(document_id) => void select_document(document_id)}
        set_delete_target={set_delete_target}
        set_editor_mode={set_editor_mode}
        set_new_document_open={(open) => {
          set_new_document_open(open);
          if (!open) set_new_document_parent_id(null);
        }}
        set_new_document_title={set_new_document_title}
        set_selection={set_selection}
        set_tree_sheet_open={set_tree_sheet_open}
        tree_sheet_open={tree_sheet_open}
      />
      <SummaryGenerationDialog
        open={generation_open}
        on_open_change={set_generation_open}
        asset={selected_asset}
        transcript={transcript}
        models={models}
        presets={presets}
        model_id={generation_model_id}
        on_model_change={set_generation_model_id}
        preset_id={generation_preset_id}
        on_preset_change={set_generation_preset_id}
        detail={detail}
        on_detail_change={set_detail}
        user_input={generation_user_input}
        on_user_input_change={set_generation_user_input}
        output_language={output_language}
        on_output_language_change={set_output_language}
        is_generating={is_generating}
        on_generate={() => void generate_documents()}
      />
    </>
  );
}

function SummaryWorkspaceInitialState({
  selected_asset,
  loading,
  transcript,
  models,
  presets,
  model_id,
  on_model_change,
  detail,
  on_detail_change,
  preset_id,
  on_preset_change,
  user_input,
  on_user_input_change,
  output_language,
  on_output_language_change,
  is_generating,
  on_generate,
}: {
  selected_asset: MediaAsset | null;
  loading: boolean;
  transcript: Transcript | null;
  models: AiModelSummary[];
  presets: SummaryPreset[];
  model_id: string | null;
  on_model_change: (model_id: string | null) => void;
  detail: SummaryDetail;
  on_detail_change: (detail: SummaryDetail) => void;
  preset_id: string;
  on_preset_change: (preset_id: string) => void;
  user_input: string;
  on_user_input_change: (user_input: string) => void;
  output_language: string;
  on_output_language_change: (language: string) => void;
  is_generating: boolean;
  on_generate: () => void;
}) {
  if (!selected_asset) {
    return (
      <SummaryEmpty
        title="尚未选择素材"
        description="请先在标记页选择一个已下载的视频。"
      />
    );
  }
  if (loading) {
    return (
      <div
        className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"
        role="status"
      >
        <Spinner /> 正在读取总结项目
      </div>
    );
  }
  return (
    <div
      className="h-full min-h-0 overflow-y-auto"
      data-slot="summary-generation-scroll-area"
    >
      <SummaryGeneration
        asset={selected_asset}
        transcript={transcript}
        models={models}
        presets={presets}
        model_id={model_id}
        on_model_change={on_model_change}
        detail={detail}
        on_detail_change={on_detail_change}
        preset_id={preset_id}
        on_preset_change={on_preset_change}
        user_input={user_input}
        on_user_input_change={on_user_input_change}
        output_language={output_language}
        on_output_language_change={on_output_language_change}
        is_generating={is_generating}
        on_generate={on_generate}
      />
    </div>
  );
}

function SummaryGenerationDialog({
  open,
  on_open_change,
  asset,
  ...generation_props
}: {
  open: boolean;
  on_open_change: (open: boolean) => void;
  asset: MediaAsset;
  transcript: Transcript | null;
  models: AiModelSummary[];
  presets: SummaryPreset[];
  model_id: string | null;
  on_model_change: (model_id: string | null) => void;
  preset_id: string;
  on_preset_change: (preset_id: string) => void;
  detail: SummaryDetail;
  on_detail_change: (detail: SummaryDetail) => void;
  user_input: string;
  on_user_input_change: (user_input: string) => void;
  output_language: string;
  on_output_language_change: (language: string) => void;
  is_generating: boolean;
  on_generate: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={on_open_change}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>重新生成当前笔记</DialogTitle>
          <DialogDescription>
            重新生成会替换当前笔记。请确认现有内容已保存，再继续生成。
          </DialogDescription>
        </DialogHeader>
        <SummaryGeneration asset={asset} {...generation_props} compact />
      </DialogContent>
    </Dialog>
  );
}
