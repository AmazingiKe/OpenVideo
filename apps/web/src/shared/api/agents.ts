import type {
  AgentArtifact,
  AgentContextAttachment,
  AgentDefinitionAvailability,
  AgentEventType,
  AgentPermissionGrantScope,
  AgentRetrievalScope,
  AgentRun,
  AgentSession,
  AgentSessionState,
  AgentThinkingMode,
} from "../types";
import { api_base_url, ApiError, request_json } from "./client";

export function list_agent_definitions(
  signal?: AbortSignal,
): Promise<AgentDefinitionAvailability[]> {
  return request_json("/api/agent-definitions", { signal });
}

export function list_agent_sessions(
  filters: { agent_id?: string; asset_id?: string },
  signal?: AbortSignal,
): Promise<AgentSession[]> {
  const query = new URLSearchParams();
  if (filters.agent_id) query.set("agent_id", filters.agent_id);
  if (filters.asset_id) query.set("asset_id", filters.asset_id);
  return request_json(`/api/agent-sessions?${query.toString()}`, { signal });
}

export function create_agent_session(
  request: {
    agent_id: string;
    asset_id: string;
    title?: string;
    context?: Record<string, unknown>;
  },
  signal?: AbortSignal,
): Promise<AgentSession> {
  return request_json("/api/agent-sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal,
  });
}

export function get_agent_session(
  session_id: string,
  signal?: AbortSignal,
): Promise<AgentSessionState> {
  return request_json(`/api/agent-sessions/${encodeURIComponent(session_id)}`, {
    signal,
  });
}

export function create_agent_run(
  session_id: string,
  request: {
    request_key: string;
    ai_model_id: string;
    content?: string;
    task_input?: Record<string, unknown>;
    thinking_mode?: AgentThinkingMode;
    retrieval_scope?: AgentRetrievalScope;
    context_attachments?: AgentContextAttachment[];
  },
  signal?: AbortSignal,
): Promise<AgentRun> {
  return request_json(
    `/api/agent-sessions/${encodeURIComponent(session_id)}/runs`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal,
    },
  );
}

export function get_agent_run(
  run_id: string,
  signal?: AbortSignal,
): Promise<AgentRun> {
  return request_json(`/api/agent-runs/${encodeURIComponent(run_id)}`, {
    signal,
  });
}

export type UnifiedAgentRunEvent = {
  event: AgentEventType;
  data: {
    event_id: string;
    sequence: number;
    [key: string]: unknown;
  };
};

export async function stream_unified_agent_run(
  run_id: string,
  on_event: (event: UnifiedAgentRunEvent) => void,
  signal?: AbortSignal,
  last_sequence = 0,
): Promise<void> {
  const response = await fetch(
    `${api_base_url}/api/agent-runs/${encodeURIComponent(run_id)}/events`,
    {
      signal,
      headers:
        last_sequence > 0
          ? { "Last-Event-ID": String(last_sequence) }
          : undefined,
    },
  );
  if (!response.ok || !response.body) {
    throw new ApiError(`请求失败（${response.status}）`, response.status);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      const event_name = block.match(/^event: (.+)$/m)?.[1];
      const data = block.match(/^data: (.+)$/m)?.[1];
      if (event_name && data) {
        on_event({
          event: event_name as AgentEventType,
          data: JSON.parse(data),
        });
      }
    }
    if (done) break;
  }
}

export function resolve_agent_artifact(
  artifact_id: string,
  action: "approve" | "reject",
  grant_scope: AgentPermissionGrantScope = "once",
  signal?: AbortSignal,
): Promise<AgentArtifact> {
  return request_json(
    `/api/agent-artifacts/${encodeURIComponent(artifact_id)}/${action}`,
    {
      method: "POST",
      headers:
        action === "approve"
          ? { "Content-Type": "application/json" }
          : undefined,
      body: action === "approve" ? JSON.stringify({ grant_scope }) : undefined,
      signal,
    },
  );
}

export function cancel_agent_run(
  run_id: string,
  signal?: AbortSignal,
): Promise<AgentRun> {
  return request_json(`/api/agent-runs/${encodeURIComponent(run_id)}/cancel`, {
    method: "POST",
    signal,
  });
}
