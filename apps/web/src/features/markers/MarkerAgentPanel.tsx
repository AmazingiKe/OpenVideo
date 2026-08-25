import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  ChevronRight,
  History,
  MessageSquareText,
  Plus,
  Trash2,
} from "lucide-react";

import { AiModelSelect } from "@/components/AiModelSelect";
import {
  Bubble,
  Marker as ChatMarker,
  Message,
  MessageComposer,
  MessageScroller,
} from "@/components/chat";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AgentToolTrace } from "@/features/workbench/SummaryAgentToolTrace";
import {
  cancel_agent_run,
  create_marker_agent_message,
  create_marker_agent_session,
  delete_marker_agent_session,
  get_marker_agent_session,
  list_marker_agent_sessions,
  resolve_marker_proposal,
  stream_agent_run,
} from "@/shared/api";
import { error_message, is_abort_error } from "@/shared/errors";
import { format_time } from "@/shared/format";
import type {
  AgentEvent,
  AiModelSummary,
  MarkerAgentSession,
  MarkerAgentSessionState,
  MarkerProposal,
  MarkerProposalChange,
  MarkerRetrievalMode,
  MediaMarker,
} from "@/shared/types";

const RETRIEVAL_MODE_LABELS: Record<MarkerRetrievalMode, string> = {
  transcript: "仅转录",
  auto: "智能",
  vision: "画面理解",
};

type MarkerAgentPanelProps = {
  asset_id: string | null;
  models: AiModelSummary[];
  on_seek: (seconds: number) => void;
  on_candidate_markers_change: (markers: MediaMarker[]) => void;
  on_markers_changed: () => Promise<void>;
};

type DisplayItem =
  | { type: "message"; id: string; role: "user" | "assistant"; content: string }
  | {
      type: "tool";
      id: string;
      name: string;
      arguments: Record<string, unknown>;
      result?: unknown;
    };

export function MarkerAgentPanel({
  asset_id,
  models,
  on_seek,
  on_candidate_markers_change,
  on_markers_changed,
}: MarkerAgentPanelProps) {
  const [sessions, set_sessions] = useState<MarkerAgentSession[]>([]);
  const [session, set_session] = useState<MarkerAgentSessionState | null>(null);
  const [model_id, set_model_id] = useState<string | null>(null);
  const [retrieval_mode, set_retrieval_mode] =
    useState<MarkerRetrievalMode>("auto");
  const [instruction, set_instruction] = useState("");
  const [stream_items, set_stream_items] = useState<DisplayItem[]>([]);
  const [stage, set_stage] = useState<string | null>(null);
  const [pending, set_pending] = useState(false);
  const [active_run_id, set_active_run_id] = useState<string | null>(null);
  const [resolving_id, set_resolving_id] = useState<string | null>(null);
  const [error, set_error] = useState<string | null>(null);
  const mounted_ref = useRef(true);
  const turn_token_ref = useRef(0);

  useEffect(() => {
    mounted_ref.current = true;
    return () => {
      mounted_ref.current = false;
    };
  }, []);

  useEffect(() => {
    if (!model_id && models[0]) set_model_id(models[0].model_id);
  }, [model_id, models]);

  useEffect(() => {
    const controller = new AbortController();
    turn_token_ref.current += 1;
    set_session(null);
    set_sessions([]);
    set_stream_items([]);
    set_pending(false);
    set_active_run_id(null);
    set_stage(null);
    set_error(null);
    if (!asset_id) return () => controller.abort();
    void load_or_create_session(asset_id, controller.signal);
    return () => controller.abort();
  }, [asset_id]);

  const proposals = useMemo(
    () => session?.proposals ?? [],
    [session?.proposals],
  );
  useEffect(() => {
    on_candidate_markers_change(candidate_markers(proposals));
  }, [on_candidate_markers_change, proposals]);

  const items = useMemo(
    () => [...display_items(session?.events ?? []), ...stream_items],
    [session?.events, stream_items],
  );
  const selected_model = models.find((model) => model.model_id === model_id);
  const vision_unavailable =
    retrieval_mode === "vision" &&
    selected_model !== undefined &&
    !selected_model.input_modalities.includes("image");

  if (!asset_id) {
    return (
      <Empty className="h-full rounded-none border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Bot />
          </EmptyMedia>
          <EmptyTitle>请先选择视频</EmptyTitle>
          <EmptyDescription>Agent 只处理当前播放器中的视频。</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <aside
      className="flex h-full min-h-80 flex-col bg-card"
      data-slot="marker-agent-panel"
      aria-label="标记 Agent"
    >
      <div className="flex flex-col gap-3 border-b p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2 text-sm font-medium">
            <Bot aria-hidden /> 标记 Agent
          </span>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="新建标记 Agent 会话"
              disabled={pending}
              onClick={() => void new_session()}
            >
              <Plus />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="删除当前标记 Agent 会话"
              disabled={pending || !session}
              onClick={() => void remove_session()}
            >
              <Trash2 />
            </Button>
          </div>
        </div>
        <Select
          value={session?.session.session_id}
          onValueChange={(session_id) => void select_session(session_id)}
          disabled={pending || sessions.length === 0}
        >
          <SelectTrigger className="w-full" aria-label="标记 Agent 历史">
            <History data-icon="inline-start" />
            <SelectValue placeholder="选择历史会话" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {sessions.map((item) => (
                <SelectItem
                  key={item.session.session_id}
                  value={item.session.session_id}
                >
                  {item.session.title}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <AiModelSelect
          id="marker-agent-model"
          label="模型"
          models={models}
          value={model_id}
          on_change={set_model_id}
          disabled={pending}
        />
        <Select
          value={retrieval_mode}
          onValueChange={(value) =>
            set_retrieval_mode(value as MarkerRetrievalMode)
          }
          disabled={pending}
        >
          <SelectTrigger className="w-full" aria-label="检索模式">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {Object.entries(RETRIEVAL_MODE_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        {vision_unavailable ? (
          <Alert variant="destructive">
            <AlertDescription>
              当前模型不支持图像输入，请切换视觉模型。
            </AlertDescription>
          </Alert>
        ) : null}
      </div>
      <MessageScroller className="flex-1">
        {items.length === 0 && proposals.length === 0 ? (
          <Empty className="border-0">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <MessageSquareText />
              </EmptyMedia>
              <EmptyTitle>描述需要查找或整理的片段</EmptyTitle>
              <EmptyDescription>
                Agent 会先检查证据，所有标记变更都要整批确认。
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}
        {items.map((item) =>
          item.type === "message" ? (
            <Message key={item.id} role={item.role}>
              <Bubble role={item.role}>{item.content}</Bubble>
            </Message>
          ) : (
            <AgentToolTrace
              key={item.id}
              trace={{
                call_id: item.id,
                name: item.name,
                arguments: item.arguments,
                result: item.result,
              }}
            />
          ),
        )}
        {proposals.map((proposal) => (
          <MarkerProposalCard
            key={proposal.proposal_id}
            proposal={proposal}
            resolving={resolving_id === proposal.proposal_id}
            on_seek={on_seek}
            on_resolve={(action) => void resolve_proposal(proposal, action)}
          />
        ))}
        {stage ? <ChatMarker>{stage}</ChatMarker> : null}
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
      </MessageScroller>
      <MessageComposer
        value={instruction}
        on_change={set_instruction}
        on_submit={() => void submit()}
        on_cancel={
          active_run_id ? () => void cancel_run(active_run_id) : undefined
        }
        pending={pending}
        disabled={!session || !model_id || vision_unavailable}
        placeholder="例如：找出所有结论并建议范围标记…"
      />
    </aside>
  );

  async function load_or_create_session(asset: string, signal?: AbortSignal) {
    try {
      const loaded = await list_marker_agent_sessions(asset, signal);
      const next_state = loaded[0]
        ? await get_marker_agent_session(loaded[0].session.session_id, signal)
        : await create_marker_agent_session(asset, signal);
      if (!mounted_ref.current) return;
      set_sessions(
        loaded.length > 0
          ? loaded
          : [{ session: next_state.session, asset_id: asset }],
      );
      set_session(next_state);
    } catch (caught) {
      if (!is_abort_error(caught) && mounted_ref.current) {
        set_error(error_message(caught));
      }
    }
  }

  async function new_session() {
    if (!asset_id) return;
    try {
      const created = await create_marker_agent_session(asset_id);
      set_sessions((current) => [created, ...current]);
      set_session(created);
      set_stream_items([]);
    } catch (caught) {
      set_error(error_message(caught));
    }
  }

  async function select_session(session_id: string) {
    try {
      set_session(await get_marker_agent_session(session_id));
      set_stream_items([]);
    } catch (caught) {
      set_error(error_message(caught));
    }
  }

  async function remove_session() {
    if (!session || !asset_id) return;
    try {
      await delete_marker_agent_session(session.session.session_id);
      await load_or_create_session(asset_id);
    } catch (caught) {
      set_error(error_message(caught));
    }
  }

  async function submit() {
    if (!session || !model_id || !instruction.trim()) return;
    const turn_token = turn_token_ref.current + 1;
    turn_token_ref.current = turn_token;
    const content = instruction.trim();
    set_instruction("");
    set_pending(true);
    set_error(null);
    set_stream_items([
      {
        type: "message",
        id: `local-user-${Date.now()}`,
        role: "user",
        content,
      },
    ]);
    try {
      const run = await create_marker_agent_message(
        session.session.session_id,
        { content, ai_model_id: model_id, retrieval_mode },
      );
      if (turn_token_ref.current !== turn_token) return;
      set_active_run_id(run.run_id);
      let assistant_content = "";
      const traces = new Map<string, Extract<DisplayItem, { type: "tool" }>>();
      await stream_agent_run<MarkerProposal>(run.run_id, (event) => {
        if (turn_token_ref.current !== turn_token) return;
        if (event.event === "assistant_chunk") {
          assistant_content += event.data.content;
        } else if (event.event === "assistant_message") {
          assistant_content = event.data.content || assistant_content;
        } else if (event.event === "tool_call") {
          traces.set(event.data.call_id, {
            type: "tool",
            id: event.data.call_id,
            name: event.data.name,
            arguments: event.data.arguments,
          });
        } else if (event.event === "tool_result") {
          const trace = traces.get(event.data.call_id);
          if (trace) trace.result = event.data.result;
        } else if (event.event === "status") {
          set_stage(event.data.message ?? event.data.stage);
        } else if (event.event === "error") {
          set_error(event.data.message ?? "Agent 运行失败");
        }
        set_stream_items([
          {
            type: "message",
            id: `local-user-${run.run_id}`,
            role: "user",
            content,
          },
          ...traces.values(),
          ...(assistant_content
            ? [
                {
                  type: "message" as const,
                  id: `local-assistant-${run.run_id}`,
                  role: "assistant" as const,
                  content: assistant_content,
                },
              ]
            : []),
        ]);
      });
      if (turn_token_ref.current !== turn_token) return;
      const restored = await get_marker_agent_session(
        session.session.session_id,
      );
      set_session(restored);
      set_sessions(await list_marker_agent_sessions(session.asset_id));
      set_stream_items([]);
      set_stage(null);
    } catch (caught) {
      if (turn_token_ref.current === turn_token) {
        set_error(error_message(caught));
      }
    } finally {
      if (turn_token_ref.current === turn_token) {
        set_active_run_id(null);
        set_pending(false);
      }
    }
  }

  async function cancel_run(run_id: string) {
    try {
      set_stage("正在取消 Agent 运行");
      await cancel_agent_run(run_id);
    } catch (caught) {
      set_error(error_message(caught));
    }
  }

  async function resolve_proposal(
    proposal: MarkerProposal,
    action: "accept" | "reject",
  ) {
    set_resolving_id(proposal.proposal_id);
    set_error(null);
    try {
      const resolved = await resolve_marker_proposal(
        proposal.proposal_id,
        action,
      );
      set_session((current) =>
        current
          ? {
              ...current,
              proposals: current.proposals.map((item) =>
                item.proposal_id === resolved.proposal_id ? resolved : item,
              ),
            }
          : current,
      );
      if (action === "accept") await on_markers_changed();
    } catch (caught) {
      set_error(error_message(caught));
      if (session) {
        set_session(await get_marker_agent_session(session.session.session_id));
      }
    } finally {
      set_resolving_id(null);
    }
  }
}

function display_items(events: AgentEvent[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  const traces = new Map<string, Extract<DisplayItem, { type: "tool" }>>();
  for (const event of events) {
    if (event.event_type === "user/message") {
      items.push({
        type: "message",
        id: event.event_id,
        role: "user",
        content: String(event.payload.content ?? ""),
      });
    } else if (event.event_type === "assistant/message") {
      const content = String(event.payload.content ?? "");
      if (content) {
        items.push({
          type: "message",
          id: event.event_id,
          role: "assistant",
          content,
        });
      }
    } else if (event.event_type === "tool/call") {
      const call_id = String(event.payload.call_id ?? event.event_id);
      const trace: Extract<DisplayItem, { type: "tool" }> = {
        type: "tool",
        id: call_id,
        name: String(event.payload.name ?? "tool"),
        arguments: (event.payload.arguments ?? {}) as Record<string, unknown>,
      };
      traces.set(call_id, trace);
      items.push(trace);
    } else if (event.event_type === "tool/result") {
      const trace = traces.get(String(event.payload.call_id));
      if (trace) trace.result = event.payload.result;
    }
  }
  return items;
}

function candidate_markers(proposals: MarkerProposal[]): MediaMarker[] {
  return proposals.flatMap((proposal) =>
    proposal.status === "pending"
      ? proposal.changes.flatMap((change) =>
          change.after ? [change.after] : [],
        )
      : [],
  );
}

export function MarkerProposalCard({
  proposal,
  resolving,
  on_seek,
  on_resolve,
}: {
  proposal: MarkerProposal;
  resolving: boolean;
  on_seek: (seconds: number) => void;
  on_resolve: (action: "accept" | "reject") => void;
}) {
  const groups = group_proposal_changes(proposal.changes);
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>标记变更建议</CardTitle>
        <CardDescription>
          {proposal.changes.length} 项，整批处理
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {groups.map(([operation, changes]) => (
          <section key={operation} className="flex flex-col gap-2">
            <Badge variant="secondary" className="w-fit">
              {operation_label(operation)} · {changes.length}
            </Badge>
            {changes.map((change, index) => (
              <ProposalChange
                key={`${operation}-${index}`}
                change={change}
                on_seek={on_seek}
              />
            ))}
          </section>
        ))}
      </CardContent>
      <CardFooter className="justify-end gap-2">
        {proposal.status === "pending" ? (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={resolving}
              onClick={() => on_resolve("reject")}
            >
              整批拒绝
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={resolving}
              onClick={() => on_resolve("accept")}
            >
              整批接受
            </Button>
          </>
        ) : (
          <Badge variant="outline">
            {proposal_status_label(proposal.status)}
          </Badge>
        )}
      </CardFooter>
    </Card>
  );
}

function group_proposal_changes(
  changes: MarkerProposalChange[],
): [MarkerProposalChange["operation"], MarkerProposalChange[]][] {
  const operations: MarkerProposalChange["operation"][] = [
    "create",
    "update",
    "merge",
    "delete",
  ];
  return operations.flatMap((operation) => {
    const group = changes.filter((change) => change.operation === operation);
    return group.length ? [[operation, group]] : [];
  });
}

function ProposalChange({
  change,
  on_seek,
}: {
  change: MarkerProposalChange;
  on_seek: (seconds: number) => void;
}) {
  const marker = change.after ?? change.before[0];
  return (
    <div className="flex flex-col gap-1 rounded-lg border p-2">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="justify-start"
        onClick={() => marker && on_seek(marker.start_seconds)}
        disabled={!marker}
      >
        <ChevronRight data-icon="inline-start" />
        {marker ? marker_time_label(marker) : "无时间"}
      </Button>
      <strong className="text-sm">{marker?.title || "未命名标记"}</strong>
      {marker?.tags.length ? (
        <span className="text-xs text-muted-foreground">
          {marker.tags.join(" · ")}
        </span>
      ) : null}
      <p className="text-xs text-muted-foreground">{change.reason}</p>
      {change.evidence.map((evidence) => (
        <p key={evidence} className="text-xs text-muted-foreground">
          证据：{evidence}
        </p>
      ))}
    </div>
  );
}

function marker_time_label(marker: MediaMarker): string {
  return marker.end_seconds === null
    ? format_time(marker.start_seconds)
    : `${format_time(marker.start_seconds)}–${format_time(marker.end_seconds)}`;
}

function operation_label(operation: string): string {
  return (
    { create: "新增", update: "修改", merge: "合并", delete: "删除" }[
      operation
    ] ?? operation
  );
}

function proposal_status_label(status: MarkerProposal["status"]): string {
  return {
    pending: "待审批",
    accepted: "已接受",
    rejected: "已拒绝",
    stale: "已过期",
  }[status];
}
