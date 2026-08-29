import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import {
  cancel_agent_run,
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
  session_context_matches_scope,
  type AgentContextAttachmentDraft,
} from "./agent_context";

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
  context: Record<string, unknown>;
  models: AiModelSummary[];
  on_artifact_change?: (artifact: AgentArtifact) => void | Promise<void>;
  task_input: Record<string, unknown>;
  default_thinking_mode: AgentThinkingMode;
};

export function use_agent_panel({
  agent_id,
  asset_id,
  context,
  models,
  on_artifact_change,
  task_input,
  default_thinking_mode,
}: AgentPanelStateOptions) {
  const [definition, set_definition] = useState<
    Awaited<ReturnType<typeof list_agent_definitions>>[number] | null
  >(null);
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
  const [preparing_attachments, set_preparing_attachments] = useState(false);
  const [last_content, set_last_content] = useState("");
  const [active_run, set_active_run] = useState<AgentRun | null>(null);
  const [stream_text, set_stream_text] = useState("");
  const [connection_message, set_connection_message] = useState<string | null>(
    null,
  );
  const [error, set_error] = useState<string | null>(null);
  const connection_ref = useRef<AbortController | null>(null);
  const run_sequence_ref = useRef(new Map<string, number>());
  const restore_panel_event = useEffectEvent(restore_panel);
  const scope_key = useMemo(
    () =>
      asset_id ? agent_scope_key(agent_id, asset_id, context) : "no-asset",
    [agent_id, asset_id, context],
  );

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
    set_definition(null);
    set_sessions([]);
    set_state(null);
    set_active_run(null);
    set_stream_text("");
    set_thinking_mode(default_thinking_mode);
    set_retrieval_scope("current_asset");
    set_scope_pinned(false);
    set_preparing_attachments(false);
    run_sequence_ref.current.clear();
    set_error(null);
    if (!asset_id) return () => controller.abort();
    void restore_panel_event(asset_id, controller.signal);
    return () => {
      controller.abort();
      connection_ref.current?.abort();
    };
  }, [agent_id, asset_id, default_thinking_mode, scope_key]);

  async function restore_panel(asset: string, signal: AbortSignal) {
    try {
      const [definitions, loaded_sessions] = await Promise.all([
        list_agent_definitions(signal),
        list_agent_sessions({ agent_id, asset_id: asset }, signal),
      ]);
      const next_definition = definitions.find(
        (item) => item.definition.agent_id === agent_id,
      );
      set_definition(next_definition ?? null);
      const matching_sessions = loaded_sessions.filter((session) =>
        session_context_matches_scope(session.context, scope_key, context),
      );
      set_sessions(matching_sessions);
      if (!matching_sessions[0]) return;
      const restored = await get_agent_session(
        matching_sessions[0].session_id,
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
    const created_state = await get_agent_session(session.session_id);
    set_sessions((current) => [session, ...current]);
    set_state(created_state);
    return created_state;
  }

  async function select_session(session_id: string) {
    connection_ref.current?.abort();
    try {
      const selected = await get_agent_session(session_id);
      set_state(selected);
      set_active_run(null);
      set_stream_text("");
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

  async function submit(
    content_override?: string,
    context_attachment_drafts: AgentContextAttachmentDraft[] = [],
  ): Promise<boolean> {
    const next_content = content_override ?? draft;
    if (
      !model_id ||
      (!next_content.trim() && definition?.definition.input_mode !== "task")
    ) {
      return false;
    }
    const content = next_content.trim();
    set_error(null);
    set_stream_text("");
    set_preparing_attachments(true);
    try {
      const context_attachments = await materialize_context_attachments(
        context_attachment_drafts,
      );
      const current = await ensure_session();
      const run = await create_agent_run(current.session.session_id, {
        request_key: `request-${uuid7().replaceAll("-", "")}`,
        ai_model_id: model_id,
        content,
        task_input,
        thinking_mode,
        retrieval_scope,
        context_attachments,
      });
      set_last_content(content);
      set_draft("");
      set_active_run(run);
      void follow_run(run, current.events);
      if (!scope_pinned) set_retrieval_scope("current_asset");
      return true;
    } catch (caught) {
      set_error(error_message(caught));
      return false;
    } finally {
      set_preparing_attachments(false);
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
            set_stream_text("");
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
      connection_ref.current?.abort();
      if (state) set_state(await get_agent_session(state.session.session_id));
    } catch (caught) {
      set_error(error_message(caught));
    }
  }

  async function resolve_artifact(
    artifact: AgentArtifact,
    action: "approve" | "reject",
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

  return {
    active_run,
    artifacts: state?.artifacts ?? [],
    cancel_run,
    compatible_models,
    connection_message,
    definition,
    draft,
    error,
    events: state?.events ?? [],
    follow_run,
    last_content,
    model_id,
    pending: active_run !== null && !TERMINAL_RUN_STAGES.has(active_run.stage),
    preparing_attachments,
    resolve_artifact,
    select_session,
    sessions,
    set_draft,
    set_retrieval_scope,
    set_scope_pinned,
    set_thinking_mode,
    scope_key,
    scope_pinned,
    state,
    stream_text,
    submit,
    thinking_mode,
    retrieval_scope,
  };
}
