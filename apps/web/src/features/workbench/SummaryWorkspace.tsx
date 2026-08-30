import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { RESOURCE_QUERY_KEYS } from "@/app/query_cache";
import type { MarkdownSelection } from "@/components/MarkdownEditor";
import { Spinner } from "@/components/ui/spinner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ApiError,
  create_summary_export,
  create_summary_child,
  delete_summary_document,
  duplicate_summary_document,
  generate_summary_documents,
  get_summary_illustration_job,
  get_version_summary_illustration_job,
  list_summary_documents,
  list_summary_presets,
  move_summary_document,
  select_summary_version,
  subscribe_summary_documents,
  update_summary_document,
} from "@/shared/api";
import { error_message } from "@/shared/errors";
import { use_compact_summary_layout } from "@/features/summary/use_compact_summary_layout";
import {
  load_summary_project,
  type SummaryProject,
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
  SummaryVersion,
  Transcript,
} from "@/shared/types";
import {
  DocumentConflictDialog,
  SummaryEmpty,
  SummaryGeneration,
  type DocumentConflict,
  type SaveStatus,
} from "./SummaryWorkspacePanels";
import { SummaryEditorLayout } from "./SummaryEditorLayout";

const AUTO_SAVE_DELAY_MS = 1_000;
const ILLUSTRATION_POLL_DELAY_MS = 750;
const TERMINAL_ILLUSTRATION_STAGES = new Set(["complete", "failed"]);

type SummaryWorkspaceProps = {
  selected_asset: MediaAsset | null;
  segments: MediaSegment[];
  transcript: Transcript | null;
  on_error?: (message: string | null) => void;
};

const EMPTY_SUMMARY_PROJECT: SummaryProject = {
  documents: [],
  versions: [],
  current_version_id: null,
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
  const [versions, set_versions] = useState<SummaryVersion[]>(
    initial_project.versions,
  );
  const [current_version_id, set_current_version_id] = useState<string | null>(
    initial_project.current_version_id,
  );
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
  const [draft_markdown, set_draft_markdown] = useState("");
  const [draft_title, set_draft_title] = useState("");
  const [dirty, set_dirty] = useState(false);
  const [save_status, set_save_status] = useState<SaveStatus>("saved");
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
  const [document_conflict, set_document_conflict] =
    useState<DocumentConflict | null>(null);
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
  const active_document_version_id_ref = useRef<string | null>(null);
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

  const update_dirty = useCallback((next_dirty: boolean) => {
    dirty_ref.current = next_dirty;
    set_dirty(next_dirty);
  }, []);

  const activate_document = useCallback(
    (document: SummaryDocument) => {
      active_document_id_ref.current = document.document_id;
      active_document_revision_ref.current = document.revision;
      active_document_version_id_ref.current = document.version_id;
      active_document_title_ref.current = document.title;
      draft_markdown_ref.current = document.markdown;
      draft_title_ref.current = document.title;
      set_draft_markdown(document.markdown);
      set_draft_title(document.title);
      update_dirty(false);
      set_save_status("saved");
      set_document_conflict(null);
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
      .catch(async (error: unknown) => {
        if (active_document_id_ref.current === document_id) {
          if (error instanceof ApiError && error.status === 409) {
            set_save_status("conflict");
            const asset_id = active_asset_id_ref.current;
            const version_id = active_document_version_id_ref.current;
            if (asset_id && version_id) {
              try {
                const loaded = await list_summary_documents(
                  asset_id,
                  version_id,
                );
                set_documents(loaded);
                const remote_document = loaded.find(
                  (document) => document.document_id === document_id,
                );
                if (remote_document) {
                  set_document_conflict({
                    local_markdown: markdown,
                    local_title: title,
                    remote_document,
                  });
                } else {
                  set_save_status("failed");
                  on_error?.(
                    "文档已在其他位置删除，本地草稿仍保留在当前窗口。",
                  );
                }
              } catch (load_error) {
                set_save_status("failed");
                on_error?.(error_message(load_error));
              }
            } else {
              set_save_status("failed");
            }
          } else {
            set_save_status("failed");
          }
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
  }, [on_error, update_dirty]);

  const load_documents = useCallback(
    async (
      asset_id: string,
      version_id?: string | null,
      signal?: AbortSignal,
    ) => {
      const loaded = await list_summary_documents(asset_id, version_id, signal);
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
    const resource_error =
      models_error ??
      (presets_query.error ? error_message(presets_query.error) : null) ??
      (project_query.error ? error_message(project_query.error) : null);
    if (resource_error) on_error?.(resource_error);
  }, [models_error, on_error, presets_query.error, project_query.error]);

  useEffect(() => {
    active_asset_id_ref.current = selected_asset_id;
    set_generation_notice(null);
    set_illustration_job(null);
    set_export_relative_path(null);
    set_export_pending(false);
    set_generation_open(false);
    set_document_conflict(null);
    if (!selected_asset_id) {
      set_documents([]);
      set_selected_document_id(null);
      set_versions([]);
      set_current_version_id(null);
    }
  }, [selected_asset_id]);

  useEffect(() => {
    const project = project_query.data;
    if (!project) return;
    project_loaded_ref.current = true;
    set_documents(project.documents);
    set_versions(project.versions);
    set_current_version_id(project.current_version_id);
    set_selected_document_id((current) =>
      project.documents.some((document) => document.document_id === current)
        ? current
        : (project.documents.find(
            (document) => document.parent_document_id === null,
          )?.document_id ?? null),
    );
  }, [project_query.data]);

  useEffect(() => {
    if (!current_version_id) {
      set_illustration_job(null);
      return;
    }
    const controller = new AbortController();
    void get_version_summary_illustration_job(
      current_version_id,
      controller.signal,
    )
      .then((job) => set_illustration_job(job))
      .catch(() => undefined);
    return () => controller.abort();
  }, [current_version_id]);

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
            !dirty_ref.current
          ) {
            set_documents(
              await list_summary_documents(job.asset_id, job.version_id),
            );
          }
        })
        .catch(() => undefined);
    }, ILLUSTRATION_POLL_DELAY_MS);
    return () => {
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [illustration_job]);

  useEffect(() => {
    project_state_ref.current = {
      documents,
      versions,
      current_version_id,
    };
  }, [current_version_id, documents, versions]);

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
    if (!selected_asset || !generation_model_id || !generation_preset_id)
      return;
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
      set_versions((current) => [result.version, ...current]);
      set_current_version_id(result.version.version_id);
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
    if (!selected_asset || !current_version_id || export_pending) return;
    const asset_id = selected_asset.asset_id;
    set_export_pending(true);
    on_error?.(null);
    try {
      const result = await create_summary_export(asset_id, current_version_id);
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

  async function change_version(version_id: string) {
    if (!selected_asset || version_id === current_version_id) return;
    while (dirty_ref.current || save_promise_ref.current) {
      if (!(await save_active_draft())) return;
    }
    try {
      await select_summary_version(selected_asset.asset_id, version_id);
      const loaded = await load_documents(selected_asset.asset_id, version_id);
      set_current_version_id(version_id);
      const root = loaded.find(
        (document) => document.parent_document_id === null,
      );
      set_selected_document_id(root?.document_id ?? null);
    } catch (error) {
      on_error?.(error_message(error));
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
      await load_documents(selected_asset.asset_id, current_version_id);
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
    set_reordering(true);
    try {
      set_documents(
        await move_summary_document(document_id, parent_document_id, position),
      );
    } catch (error) {
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
      document.document_id === active_document_id_ref.current &&
      !(await save_active_draft())
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
    if (document.document_id === active_document_id_ref.current) {
      change_title(next_title);
      return;
    }
    try {
      const updated = await update_summary_document(
        document.document_id,
        document.revision,
        { title: next_title },
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
      active_document_id_ref.current = null;
      set_selected_document_id(active.document_id);
    }
  }

  function change_title(title: string) {
    set_draft_title(title);
    draft_title_ref.current = title;
    update_dirty(true);
    set_save_status("pending");
  }

  function change_markdown(markdown: string) {
    set_draft_markdown(markdown);
    draft_markdown_ref.current = markdown;
    update_dirty(true);
    set_save_status("pending");
  }

  function retry_save() {
    set_save_status("pending");
    update_dirty(true);
  }

  function keep_local_conflict() {
    if (!document_conflict) return;
    const remote = document_conflict.remote_document;
    active_document_revision_ref.current = remote.revision;
    active_document_title_ref.current = remote.title;
    set_document_conflict(null);
    set_save_status("pending");
    update_dirty(true);
  }

  function use_remote_conflict() {
    if (!document_conflict) return;
    const remote = document_conflict.remote_document;
    set_documents((current) =>
      current.map((document) =>
        document.document_id === remote.document_id ? remote : document,
      ),
    );
    activate_document(remote);
    set_document_conflict(null);
  }

  return (
    <>
      <SummaryEditorLayout
        compact_layout={compact_layout}
        create_child={() => void add_child()}
        delete_target={delete_target}
        documents={documents}
        draft_markdown={draft_markdown}
        draft_title={draft_title}
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
        on_markdown_change={change_markdown}
        on_duplicate_document={(document) => void duplicate_document(document)}
        on_open_new_document={open_new_document}
        on_rename_document={(document, title) =>
          void rename_document(document, title)
        }
        on_retry={retry_save}
        on_title_change={change_title}
        remove_delete_target={() => set_delete_target(null)}
        reordering={reordering}
        save_status={save_status}
        selected_asset_id={editor_asset_id}
        selected_document={selected_document}
        versions={versions}
        current_version_id={current_version_id}
        on_version_change={(version_id) => void change_version(version_id)}
        on_generate_version={() => set_generation_open(true)}
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
      <DocumentConflictDialog
        conflict={document_conflict}
        on_keep_local={keep_local_conflict}
        on_use_remote={use_remote_conflict}
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
          <DialogTitle>生成新总结版本</DialogTitle>
          <DialogDescription>
            新版本不会覆盖当前版本，生成后会自动切换。
          </DialogDescription>
        </DialogHeader>
        <SummaryGeneration asset={asset} {...generation_props} compact />
      </DialogContent>
    </Dialog>
  );
}
