import { useQuery } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import { RESOURCE_QUERY_KEYS } from "@/app/query_cache";
import {
  cancel_agent_run,
  compact_agent_session_context,
  create_agent_run,
  create_agent_session,
  get_agent_run,
  get_agent_session,
  list_agent_definitions,
  list_agent_sessions,
  resolve_agent_artifact,
  stream_unified_agent_run,
} from "@/shared/api";
import { error_message, is_abort_error } from "@/shared/errors";
import { uuid7 } from "@/shared/identifiers";
import type {
  AgentArtifact,
  AgentEvent,
  AgentFocusContext,
  AgentPermissionGrantScope,
  AgentRun,
  AgentSession,
  AgentSessionState,
  AgentRetrievalScope,
  AgentThinkingMode,
  AiModelSummary,
} from "@/shared/types";
import {
  agent_scope_key,
  materialize_context_attachments,
  type AgentContextAttachmentDraft,
} from "./agent_context";
import { resolve_agent_command, type AgentCommand } from "./agent_commands";

const TERMINAL_RUN_STAGES = new Set<AgentRun["stage"]>([
  "waiting_for_approval",
  "complete",
  "failed",
  "cancelled",
  "interrupted",
]);

type AgentPanelStateOptions = {
  agent_id: string;
  asset_id: string | null;
  commands?: readonly AgentCommand[];
  context: Record<string, unknown>;
  focus_context?: AgentFocusContext;
  models: AiModelSummary[];
  on_artifact_change?: (artifact: AgentArtifact) => void | Promise<void>;
  task_input: Record<string, unknown>;
  default_thinking_mode: AgentThinkingMode;
};

type AgentSubmission = {
  content: string;
  started_at: number;
};

export function use_agent_panel({
  agent_id,
  asset_id,
  commands = [],
  context,
  focus_context,
  models,
  on_artifact_change,
  task_input,
  default_thinking_mode,
}: AgentPanelStateOptions) {
  const scope_key = useMemo(
    () => (asset_id ? agent_scope_key(agent_id, asset_id) : "no-asset"),
    [agent_id, asset_id],
  );
  const definitions_query = useQuery({
    queryKey: RESOURCE_QUERY_KEYS.agent_definitions,
    queryFn: ({ signal }) => list_agent_definitions(signal),
  });
  const definition = useMemo(
    () =>
      definitions_query.data?.find(
        (item) => item.definition.agent_id === agent_id,
      ) ?? null,
    [agent_id, definitions_query.data],
  );
  const [sessions, set_sessions] = useState<AgentSession[]>([]);
  const [state, set_state] = useState<AgentSessionState | null>(null);
  const [model_id, set_model_id] = useState<string | null>(null);
  const [draft, set_draft] = useState("");
  const [thinking_mode, set_thinking_mode] = useState<AgentThinkingMode>(
    default_thinking_mode,
  );
  const [retrieval_scope, set_retrieval_scope] =
    useState<AgentRetrievalScope>("current_asset");
  const [scope_pinned, set_scope_pinned] = useState(false);
  const [last_content, set_last_content] = useState("");
  const [last_task_input, set_last_task_input] = useState<
    Record<string, unknown>
  >({});
  const [active_run, set_active_run] = useState<AgentRun | null>(null);
  const [submission, set_submission] = useState<AgentSubmission | null>(null);
  const [stream_text, set_stream_text] = useState("");
  const [stream_complete, set_stream_complete] = useState(false);
  const [connection_message, set_connection_message] = useState<string | null>(
    null,
  );
  const [compacting_context, set_compacting_context] = useState(false);
  const [error, set_error] = useState<string | null>(null);
  const [restored_scope_key, set_restored_scope_key] = useState<string | null>(
    null,
  );
  const connection_ref = useRef<AbortController | null>(null);
  const submission_ref = useRef(false);
  const run_sequence_ref = useRef(new Map<string, number>());
  const restore_panel_event = useEffectEvent(restore_panel);
  const restoring = Boolean(asset_id) && restored_scope_key !== scope_key;
  const pending =
    active_run !== null && !TERMINAL_RUN_STAGES.has(active_run.stage);

  const compatible_models = useMemo(() => {
    if (!definition) return [];
    const compatible_ids = new Set(definition.compatible_model_ids);
    return models.filter((model) => compatible_ids.has(model.model_id));
  }, [definition, models]);

  useEffect(() => {
    set_model_id((current) =>
      compatible_models.some((model) => model.model_id === current)
        ? current
        : (compatible_models[0]?.model_id ?? null),
    );
  }, [compatible_models]);

  useEffect(() => {
    const controller = new AbortController();
    connection_ref.current?.abort();
    set_sessions([]);
    set_state(null);
    set_active_run(null);
    set_stream_text("");
    set_stream_complete(false);
    set_thinking_mode(default_thinking_mode);
    set_retrieval_scope("current_asset");
    set_scope_pinned(false);
    set_submission(null);
    set_compacting_context(false);
    submission_ref.current = false;
    run_sequence_ref.current.clear();
    set_error(null);
    if (!asset_id) {
      set_restored_scope_key(null);
      return () => controller.abort();
    }
    void restore_panel_event(asset_id, controller.signal);
    return () => {
      controller.abort();
      connection_ref.current?.abort();
    };
  }, [agent_id, asset_id, default_thinking_mode, scope_key]);

  async function restore_panel(asset: string, signal: AbortSignal) {
    try {
      const loaded_sessions = await list_agent_sessions(
        { agent_id, asset_id: asset },
        signal,
      );
      set_sessions(loaded_sessions);
      if (!loaded_sessions[0]) return;
      const restored = await get_agent_session(
        loaded_sessions[0].session_id,
        signal,
      );
      set_state(restored);
      const running = [...restored.runs]
        .reverse()
        .find((run) => !TERMINAL_RUN_STAGES.has(run.stage));
      if (running) {
        set_active_run(running);
        void follow_run(running, restored.events, signal);
      }
    } catch (caught) {
      if (!is_abort_error(caught)) set_error(error_message(caught));
    } finally {
      if (!signal.aborted) set_restored_scope_key(scope_key);
    }
  }

  async function ensure_session(): Promise<AgentSessionState> {
    if (state) return state;
    if (!asset_id) throw new Error("未选择素材");
    const session = await create_agent_session({
      agent_id,
      asset_id,
      context: { ...context, scope_key },
    });
    const created_state: AgentSessionState = {
      session,
      runs: [],
      events: [],
      artifacts: [],
    };
    set_sessions((current) => [session, ...current]);
    set_state(created_state);
    return created_state;
  }

  async function select_session(session_id: string) {
    connection_ref.current?.abort();
    set_submission(null);
    submission_ref.current = false;
    try {
      const selected = await get_agent_session(session_id);
      set_state(selected);
      set_active_run(null);
      set_stream_text("");
      set_stream_complete(false);
      set_error(null);
      const running = [...selected.runs]
        .reverse()
        .find((run) => !TERMINAL_RUN_STAGES.has(run.stage));
      if (running) {
        set_active_run(running);
        void follow_run(running, selected.events);
      }
    } catch (caught) {
      set_error(error_message(caught));
    }
  }

  function start_new_conversation() {
    connection_ref.current?.abort();
    run_sequence_ref.current.clear();
    set_state(null);
    set_active_run(null);
    set_stream_text("");
    set_stream_complete(false);
    set_connection_message(null);
    set_error(null);
    set_draft("");
    set_last_content("");
    set_last_task_input({});
    set_submission(null);
    submission_ref.current = false;
  }

  function submit(
    content_override?: string,
    context_attachment_drafts: AgentContextAttachmentDraft[] = [],
    task_input_override?: Record<string, unknown>,
  ): boolean {
    const next_content = content_override ?? draft;
    if (
      pending ||
      submission_ref.current ||
      !model_id ||
      (!next_content.trim() && definition?.definition.input_mode !== "task")
    ) {
      return false;
    }
    const content = next_content.trim();
    const command_resolution = task_input_override
      ? { task_input: task_input_override, error: null }
      : resolve_agent_command(content, commands, task_input);
    if (command_resolution.error) {
      set_error(command_resolution.error);
      return false;
    }
    submission_ref.current = true;
    set_error(null);
    set_connection_message(null);
    set_stream_text("");
    set_stream_complete(false);
    set_last_content(content);
    set_last_task_input(command_resolution.task_input);
    set_draft("");
    set_submission({ content, started_at: Date.now() });
    void start_submission(
      content,
      context_attachment_drafts,
      model_id,
      command_resolution.task_input,
    );
    return true;
  }

  async function start_submission(
    content: string,
    context_attachment_drafts: AgentContextAttachmentDraft[],
    selected_model_id: string,
    submission_task_input: Record<string, unknown>,
  ) {
    try {
      const context_attachments = await materialize_context_attachments(
        context_attachment_drafts,
      );
      const current = await ensure_session();
      const run = await create_agent_run(current.session.session_id, {
        request_key: `request-${uuid7().replaceAll("-", "")}`,
        ai_model_id: selected_model_id,
        content,
        task_input: submission_task_input,
        thinking_mode,
        retrieval_scope,
        focus_context,
        context_attachments,
      });
      set_active_run(run);
      void follow_run(run, current.events);
      if (!scope_pinned) set_retrieval_scope("current_asset");
    } catch (caught) {
      set_error(error_message(caught));
      set_draft((current) => (current.trim() ? current : content));
      set_submission(null);
      submission_ref.current = false;
    }
  }

  async function follow_run(
    run: AgentRun,
    known_events: AgentEvent[],
    inherited_signal?: AbortSignal,
  ) {
    connection_ref.current?.abort();
    const controller = new AbortController();
    connection_ref.current = controller;
    inherited_signal?.addEventListener("abort", () => controller.abort(), {
      once: true,
    });
    let last_sequence = Math.max(
      0,
      run_sequence_ref.current.get(run.run_id) ?? 0,
      ...known_events
        .filter((event) => event.run_id === run.run_id)
        .map((event) => event.sequence),
    );
    try {
      await stream_unified_agent_run(
        run.run_id,
        ({ event, data }) => {
          last_sequence = Math.max(last_sequence, data.sequence);
          run_sequence_ref.current.set(run.run_id, last_sequence);
          if (event === "message.delta") {
            set_stream_text((current) => current + String(data.content ?? ""));
          }
          if (event !== "message.delta" && event !== "reasoning.delta") {
            set_state((current) => {
              if (
                !current ||
                current.events.some((item) => item.event_id === data.event_id)
              ) {
                return current;
              }
              return {
                ...current,
                events: [
                  ...current.events,
                  {
                    event_id: data.event_id,
                    session_id: current.session.session_id,
                    sequence: data.sequence,
                    run_id: run.run_id,
                    event_type: event,
                    payload: data,
                    created_at: new Date().toISOString(),
                  },
                ],
              };
            });
          }
          if (event === "artifact.created" && data.artifact) {
            const artifact = data.artifact as AgentArtifact;
            set_state((current) =>
              current &&
              !current.artifacts.some(
                (item) => item.artifact_id === artifact.artifact_id,
              )
                ? { ...current, artifacts: [...current.artifacts, artifact] }
                : current,
            );
            void on_artifact_change?.(artifact);
          }
          if (event === "message.completed") {
            set_stream_text(String(data.content ?? ""));
            set_stream_complete(true);
          }
        },
        controller.signal,
        last_sequence,
      );
      const final_run = await get_agent_run(run.run_id, controller.signal);
      const refreshed = await get_agent_session(
        run.session_id,
        controller.signal,
      );
      set_active_run(final_run);
      set_state(refreshed);
      for (const artifact of refreshed.artifacts) {
        if (artifact.status === "approved") {
          void on_artifact_change?.(artifact);
        }
      }
      set_submission(null);
      submission_ref.current = false;
      set_connection_message(null);
      if (final_run.stage === "failed") {
        set_error(final_run.error_message ?? "助手运行失败");
      }
    } catch (caught) {
      if (is_abort_error(caught)) return;
      set_connection_message("连接已中断，可重试并从上次事件继续");
      set_error(error_message(caught));
    }
  }

  async function cancel_run(run_id: string) {
    try {
      const cancelled = await cancel_agent_run(run_id);
      set_active_run(cancelled);
      set_stream_text("");
      set_stream_complete(false);
      set_submission(null);
      submission_ref.current = false;
      connection_ref.current?.abort();
      if (state) set_state(await get_agent_session(state.session.session_id));
    } catch (caught) {
      set_error(error_message(caught));
    }
  }

  async function compact_context() {
    if (!state || pending || compacting_context) return;
    set_compacting_context(true);
    set_error(null);
    set_connection_message(null);
    try {
      const result = await compact_agent_session_context(
        state.session.session_id,
      );
      set_state(await get_agent_session(state.session.session_id));
      if (!result.compressed) set_connection_message(result.message);
    } catch (caught) {
      set_error(error_message(caught));
    } finally {
      set_compacting_context(false);
    }
  }

  async function resolve_artifact(
    artifact: AgentArtifact,
    action: "approve" | "reject" | "undo",
    grant_scope: AgentPermissionGrantScope = "once",
  ) {
    try {
      const resolved = await resolve_agent_artifact(
        artifact.artifact_id,
        action,
        grant_scope,
      );
      set_state((current) =>
        current
          ? {
              ...current,
              artifacts: current.artifacts.map((item) =>
                item.artifact_id === resolved.artifact_id ? resolved : item,
              ),
            }
          : current,
      );
      await on_artifact_change?.(resolved);
    } catch (caught) {
      set_error(error_message(caught));
    }
  }

  const active_run_started_at =
    active_run?.started_at ?? active_run?.created_at;
  const parsed_run_started_at = active_run_started_at
    ? Date.parse(active_run_started_at)
    : Number.NaN;
  const pending_started_at =
    submission?.started_at ??
    (Number.isNaN(parsed_run_started_at) ? undefined : parsed_run_started_at);

  function complete_stream() {
    if (!stream_complete) return;
    set_stream_text("");
    set_stream_complete(false);
  }

  return {
    active_run,
    artifacts: state?.artifacts ?? [],
    cancel_run,
    compact_context,
    compacting_context,
    compatible_models,
    connection_message,
    complete_stream,
    definition,
    draft,
    error:
      error ??
      (definitions_query.error ? error_message(definitions_query.error) : null),
    events: state?.events ?? [],
    follow_run,
    last_content,
    last_task_input,
    model_id,
    pending,
    pending_started_at,
    resolve_artifact,
    select_session,
    sessions,
    set_draft,
    set_model_id,
    set_retrieval_scope,
    set_scope_pinned,
    set_thinking_mode,
    scope_key,
    scope_pinned,
    start_new_conversation,
    state,
    stream_text,
    stream_complete,
    submitted_content: submission?.content ?? null,
    submitting: submission !== null && !pending,
    submit,
    thinking_mode,
    retrieval_scope,
    restoring,
  };
}
