import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import {
  Bot,
  Brain,
  CheckCircle2,
  CircleX,
  History,
  RotateCcw,
  ShieldCheck,
  Wrench,
} from "lucide-react";

import { AiModelSelect } from "@/components/AiModelSelect";
import {
  Bubble,
  Marker,
  Message,
  MessageComposer,
  MessageScroller,
} from "@/components/chat";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
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
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { format_time } from "@/shared/format";
import { uuid7 } from "@/shared/identifiers";
import { cn } from "@/lib/utils";
import type {
  AgentArtifact,
  AgentCapability,
  AgentDefinitionAvailability,
  AgentEvent,
  AgentRun,
  AgentSession,
  AgentSessionState,
  AiModelSummary,
} from "@/shared/types";

const TERMINAL_RUN_STAGES = new Set<AgentRun["stage"]>([
  "waiting_for_approval",
  "complete",
  "failed",
  "cancelled",
  "interrupted",
]);

const TOOL_LABELS: Record<string, string> = {
  read_markers: "读取现有标记",
  search_evidence: "检索视频证据",
  inspect_frames: "检查关键画面",
  propose_marker_changes: "生成标记变更预览",
  read_summary_document: "读取总结文档",
  propose_summary_edit: "生成总结修改预览",
  correct_transcript: "校对字幕",
};

const CAPABILITY_LABELS: Record<AgentCapability, string> = {
  tools: "工具调用",
  vision: "图片输入",
  long_context: "长上下文",
};

export type AgentRunOption = {
  value: string;
  label: string;
  description: string;
  task_input: Record<string, unknown>;
  required_capabilities?: AgentCapability[];
};

export type AgentPanelProps = {
  agent_id: string;
  asset_id: string | null;
  models: AiModelSummary[];
  context?: Record<string, unknown>;
  task_input?: Record<string, unknown>;
  run_options?: AgentRunOption[];
  title?: string;
  placeholder?: string;
  on_seek?: (seconds: number) => void;
  on_artifact_change?: (artifact: AgentArtifact) => void | Promise<void>;
  className?: string;
};

export function AgentPanel({
  agent_id,
  asset_id,
  models,
  context = {},
  task_input = {},
  run_options = [],
  title,
  placeholder,
  on_seek,
  on_artifact_change,
  className,
}: AgentPanelProps) {
  const [definition, set_definition] =
    useState<AgentDefinitionAvailability | null>(null);
  const [sessions, set_sessions] = useState<AgentSession[]>([]);
  const [state, set_state] = useState<AgentSessionState | null>(null);
  const [model_id, set_model_id] = useState<string | null>(null);
  const [run_option_value, set_run_option_value] = useState(
    run_options[0]?.value ?? "",
  );
  const [draft, set_draft] = useState("");
  const [last_content, set_last_content] = useState("");
  const [active_run, set_active_run] = useState<AgentRun | null>(null);
  const [stream_text, set_stream_text] = useState("");
  const [stream_reasoning, set_stream_reasoning] = useState("");
  const [connection_message, set_connection_message] = useState<string | null>(
    null,
  );
  const [error, set_error] = useState<string | null>(null);
  const connection_ref = useRef<AbortController | null>(null);
  const run_sequence_ref = useRef(new Map<string, number>());
  const restore_panel_event = useEffectEvent(restore_panel);

  const selected_run_option =
    run_options.find((option) => option.value === run_option_value) ??
    run_options[0];
  const compatible_models = useMemo(() => {
    if (!definition) return [];
    let compatible_ids = new Set(definition.compatible_model_ids);
    for (const capability of selected_run_option?.required_capabilities ?? []) {
      const capability_ids = new Set(
        definition.capability_model_ids[capability] ?? [],
      );
      compatible_ids = new Set(
        [...compatible_ids].filter((model_id) => capability_ids.has(model_id)),
      );
    }
    return models.filter((model) => compatible_ids.has(model.model_id));
  }, [definition, models, selected_run_option]);

  useEffect(() => {
    if (run_options.some((option) => option.value === run_option_value)) return;
    set_run_option_value(run_options[0]?.value ?? "");
  }, [run_option_value, run_options]);

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
    set_stream_reasoning("");
    run_sequence_ref.current.clear();
    set_error(null);
    if (!asset_id) return () => controller.abort();
    void restore_panel_event(asset_id, controller.signal);
    return () => {
      controller.abort();
      connection_ref.current?.abort();
    };
  }, [agent_id, asset_id]);

  const events = state?.events ?? [];
  const artifacts = state?.artifacts ?? [];
  const pending =
    active_run !== null && !TERMINAL_RUN_STAGES.has(active_run.stage);
  const panel_title = title ?? definition?.definition.title ?? "Agent";

  if (!asset_id) {
    return (
      <Empty className={className}>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Bot />
          </EmptyMedia>
          <EmptyTitle>请先选择视频</EmptyTitle>
          <EmptyDescription>Agent 只处理当前工作区中的素材。</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <Card
      className={cn("min-h-0 gap-0 py-0", className)}
      data-slot="agent-panel"
    >
      <CardHeader className="min-w-0 shrink-0 gap-3 border-b px-4 py-4">
        <div className="flex min-w-0 items-start justify-between gap-4">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2">
              <Bot />
              {panel_title}
            </CardTitle>
            <CardDescription>
              {definition?.definition.description ?? "正在读取 Agent 配置"}
            </CardDescription>
          </div>
          {active_run ? (
            <AgentRunBadge stage={active_run.stage} />
          ) : (
            <Badge variant="outline">未开始</Badge>
          )}
        </div>
        <FieldGroup
          className="min-w-0 flex-row flex-wrap items-start gap-3"
          aria-label="Agent 设置"
        >
          {run_options.length > 0 ? (
            <Field className="min-w-0 flex-1 basis-40 gap-1.5">
              <FieldLabel htmlFor={`${agent_id}-agent-mode`}>
                工作方式
              </FieldLabel>
              <Select
                value={run_option_value}
                onValueChange={set_run_option_value}
              >
                <SelectTrigger
                  id={`${agent_id}-agent-mode`}
                  className="w-full min-w-0"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {run_options.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          ) : null}
          <div className="min-w-0 flex-1 basis-40">
            <AiModelSelect
              id={`${agent_id}-agent-model`}
              label="模型"
              models={compatible_models}
              value={model_id}
              on_change={set_model_id}
            />
          </div>
        </FieldGroup>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1 basis-40">
            <Select
              value={state?.session.session_id ?? ""}
              onValueChange={(session_id) => void select_session(session_id)}
              disabled={sessions.length === 0}
            >
              <SelectTrigger
                id={`${agent_id}-agent-session`}
                size="sm"
                className="w-full min-w-0"
                aria-label="Agent 历史会话"
              >
                <History />
                <SelectValue placeholder="发送时创建新会话" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {sessions.map((session) => (
                    <SelectItem
                      key={session.session_id}
                      value={session.session_id}
                    >
                      {session.title}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          {selected_run_option ? (
            <p className="min-w-0 flex-1 basis-40 text-xs leading-relaxed text-muted-foreground">
              {selected_run_option.description}
            </p>
          ) : null}
        </div>
        {definition && compatible_models.length === 0 ? (
          <Alert variant="destructive">
            <AlertTitle>没有兼容模型</AlertTitle>
            <AlertDescription>
              {selected_run_option?.required_capabilities?.length
                ? `当前操作要求：${selected_run_option.required_capabilities
                    .map((capability) => CAPABILITY_LABELS[capability])
                    .join("、")}`
                : (definition.unavailable_reason ??
                  "所选 Agent 的能力要求未满足")}
            </AlertDescription>
          </Alert>
        ) : null}
      </CardHeader>
      <CardContent className="min-h-0 flex-1 p-0">
        <MessageScroller className="h-full">
          {events.length === 0 && artifacts.length === 0 ? (
            <Empty className="border-0">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ShieldCheck />
                </EmptyMedia>
                <EmptyTitle>尚未创建会话</EmptyTitle>
                <EmptyDescription>
                  首次发送消息或启动任务时才会创建，会话不会因访问素材而自动产生。
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : null}
          {timeline(events).map((item) => {
            if (item.type === "message") {
              return (
                <Message key={item.id} role={item.role}>
                  {item.reasoning ? (
                    <AgentReasoning content={item.reasoning} />
                  ) : null}
                  {item.content ? (
                    <Bubble role={item.role}>{item.content}</Bubble>
                  ) : null}
                </Message>
              );
            }
            return <AgentToolActivity key={item.id} events={item.events} />;
          })}
          {stream_text || stream_reasoning ? (
            <Message role="assistant">
              {stream_reasoning ? (
                <AgentReasoning content={stream_reasoning} running />
              ) : null}
              {stream_text ? (
                <Bubble role="assistant">{stream_text}</Bubble>
              ) : null}
            </Message>
          ) : null}
          {artifacts.map((artifact) => (
            <AgentArtifactCard
              key={artifact.artifact_id}
              artifact={artifact}
              on_seek={on_seek}
              on_resolve={(action) => void resolve_artifact(artifact, action)}
              on_regenerate={() => void submit(last_content)}
            />
          ))}
          {connection_message ? (
            <div className="flex flex-col items-center gap-2">
              <Marker>{connection_message}</Marker>
              {active_run ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    void follow_run(active_run, state?.events ?? [])
                  }
                >
                  继续接收
                </Button>
              ) : null}
            </div>
          ) : null}
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>Agent 运行失败</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
        </MessageScroller>
      </CardContent>
      <CardFooter className="block p-0">
        {definition?.definition.input_mode === "task" ? (
          <div className="flex items-center justify-end gap-2 border-t p-4">
            {pending && active_run ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => void cancel_run(active_run.run_id)}
              >
                取消任务
              </Button>
            ) : null}
            <Button
              type="button"
              onClick={() => void submit()}
              disabled={pending || !definition.available || !model_id}
            >
              启动任务
            </Button>
          </div>
        ) : (
          <MessageComposer
            value={draft}
            on_change={set_draft}
            on_submit={() => void submit()}
            on_cancel={
              active_run ? () => void cancel_run(active_run.run_id) : undefined
            }
            pending={pending}
            disabled={!definition?.available || !model_id}
            placeholder={placeholder ?? "输入消息；运行时仍可编辑下一条草稿"}
          />
        )}
      </CardFooter>
    </Card>
  );

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
    }
  }

  async function ensure_session(): Promise<AgentSessionState> {
    if (state) return state;
    if (!asset_id) throw new Error("未选择素材");
    const session = await create_agent_session({
      agent_id,
      asset_id,
      context,
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
      set_stream_reasoning("");
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

  async function submit(content_override?: string) {
    const next_content = content_override ?? draft;
    if (
      !model_id ||
      (!next_content.trim() && definition?.definition.input_mode !== "task")
    )
      return;
    const content = next_content.trim();
    set_last_content(content);
    set_draft("");
    set_error(null);
    set_stream_text("");
    set_stream_reasoning("");
    try {
      const current = await ensure_session();
      const run = await create_agent_run(current.session.session_id, {
        request_key: `request-${uuid7().replaceAll("-", "")}`,
        ai_model_id: model_id,
        content,
        task_input: {
          ...task_input,
          ...selected_run_option?.task_input,
        },
      });
      set_active_run(run);
      void follow_run(run, current.events);
    } catch (caught) {
      set_error(error_message(caught));
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
          if (event === "reasoning.delta") {
            set_stream_reasoning(
              (current) => current + String(data.content ?? ""),
            );
          }
          if (event !== "message.delta" && event !== "reasoning.delta") {
            set_state((current) => {
              if (
                !current ||
                current.events.some((item) => item.event_id === data.event_id)
              )
                return current;
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
            set_stream_reasoning("");
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
        set_error(final_run.error_message ?? "Agent 运行失败");
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
  ) {
    try {
      const resolved = await resolve_agent_artifact(
        artifact.artifact_id,
        action,
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
}

export function AgentRunBadge({ stage }: { stage: AgentRun["stage"] }) {
  const label: Record<AgentRun["stage"], string> = {
    pending: "等待运行",
    running: "运行中",
    waiting_for_approval: "等待确认",
    complete: "已完成",
    failed: "失败",
    cancelled: "已取消",
    interrupted: "已中断",
  };
  return (
    <Badge variant={stage === "failed" ? "destructive" : "secondary"}>
      {label[stage]}
    </Badge>
  );
}

type TimelineItem =
  | {
      type: "message";
      id: string;
      role: "user" | "assistant";
      content: string;
      reasoning?: string;
    }
  | { type: "tools"; id: string; events: AgentEvent[] };

function timeline(events: AgentEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const event of events) {
    if (event.event_type === "run.status" && event.payload.input) {
      items.push({
        type: "message",
        id: event.event_id,
        role: "user",
        content: String(event.payload.input),
      });
    } else if (
      event.event_type === "message.completed" &&
      (event.payload.content || event.payload.reasoning_content)
    ) {
      items.push({
        type: "message",
        id: event.event_id,
        role: "assistant",
        content: String(event.payload.content ?? ""),
        reasoning: event.payload.reasoning_content
          ? String(event.payload.reasoning_content)
          : undefined,
      });
    } else if (event.event_type === "tool.status") {
      const previous = items.at(-1);
      if (previous?.type === "tools") {
        const call_id = String(event.payload.call_id ?? event.event_id);
        const previous_index = previous.events.findIndex(
          (item) => String(item.payload.call_id ?? item.event_id) === call_id,
        );
        if (previous_index >= 0) previous.events[previous_index] = event;
        else previous.events.push(event);
      } else {
        items.push({ type: "tools", id: event.event_id, events: [event] });
      }
    }
  }
  return items;
}

export function AgentReasoning({
  content,
  running = false,
}: {
  content: string;
  running?: boolean;
}) {
  return (
    <Accordion type="single" collapsible>
      <AccordionItem value="reasoning">
        <AccordionTrigger>
          <Brain />
          {running ? "正在思考" : "思考过程"}
        </AccordionTrigger>
        <AccordionContent>
          <p className="whitespace-pre-wrap text-muted-foreground">{content}</p>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}

export function AgentToolActivity({ events }: { events: AgentEvent[] }) {
  const failed_count = events.filter(
    (event) => event.payload.stage === "failed",
  ).length;
  const running_count = events.filter(
    (event) => event.payload.stage === "started",
  ).length;
  const first_tool_name = tool_label(events[0]);
  const activity_summary =
    events.length === 1
      ? first_tool_name
      : `${first_tool_name}等 ${events.length} 项`;
  return (
    <Accordion type="single" collapsible>
      <AccordionItem value="tool-activity">
        <AccordionTrigger className="py-2">
          <Wrench />
          <span className="min-w-0 flex-1 truncate">
            工具活动 · {activity_summary}
          </span>
          <Badge variant={failed_count > 0 ? "destructive" : "outline"}>
            {failed_count > 0
              ? `${failed_count} 项失败`
              : running_count > 0
                ? "调用中"
                : "已完成"}
          </Badge>
        </AccordionTrigger>
        <AccordionContent>
          <ul className="flex flex-col" aria-label="工具调用详情">
            {events.map((event) => (
              <AgentToolCall
                key={String(event.payload.call_id ?? event.event_id)}
                event={event}
              />
            ))}
          </ul>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}

function AgentToolCall({ event }: { event: AgentEvent }) {
  const failed = event.payload.stage === "failed";
  const running = event.payload.stage === "started";
  const result = event.payload.result;
  return (
    <li className="flex min-w-0 items-start gap-2 border-b py-2 last:border-b-0">
      {running ? (
        <Wrench className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      ) : failed ? (
        <CircleX className="mt-0.5 size-4 shrink-0 text-destructive" />
      ) : (
        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium">
            {tool_label(event)}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {failed ? "失败" : running ? "调用中" : "完成"}
          </span>
        </div>
        {result !== undefined ? (
          <details className="mt-1">
            <summary className="cursor-pointer text-xs text-muted-foreground">
              查看返回数据
            </summary>
            <pre className="mt-2 max-h-56 overflow-auto rounded-md bg-muted p-3 text-xs">
              {JSON.stringify(result, null, 2)}
            </pre>
          </details>
        ) : null}
      </div>
    </li>
  );
}

function tool_label(event: AgentEvent | undefined): string {
  const name = String(event?.payload.name ?? "tool");
  return TOOL_LABELS[name] ?? name;
}

export function AgentArtifactCard({
  artifact,
  on_seek,
  on_resolve,
  on_regenerate,
}: {
  artifact: AgentArtifact;
  on_seek?: (seconds: number) => void;
  on_resolve: (action: "approve" | "reject") => void;
  on_regenerate?: () => void;
}) {
  const pending = artifact.status === "pending";
  return (
    <Card aria-label="Agent 审批结果">
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle>变更预览</CardTitle>
            <CardDescription>
              {artifact_description(artifact.result_type)}
            </CardDescription>
          </div>
          <Badge
            variant={artifact.status === "stale" ? "destructive" : "outline"}
          >
            {artifact_status_label(artifact.status)}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <ArtifactPayload artifact={artifact} on_seek={on_seek} />
        {artifact.status === "stale" ? (
          <Alert variant="destructive">
            <RotateCcw />
            <AlertTitle>预览已过期</AlertTitle>
            <AlertDescription>
              原始数据已变化，请重新运行 Agent 生成新预览。
            </AlertDescription>
            {on_regenerate ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={on_regenerate}
              >
                重新生成
              </Button>
            ) : null}
          </Alert>
        ) : null}
      </CardContent>
      {pending ? (
        <CardFooter className="justify-end gap-2">
          <Button variant="outline" onClick={() => on_resolve("reject")}>
            整批拒绝
          </Button>
          <Button onClick={() => on_resolve("approve")}>整批接受</Button>
        </CardFooter>
      ) : null}
    </Card>
  );
}

function ArtifactPayload({
  artifact,
  on_seek,
}: {
  artifact: AgentArtifact;
  on_seek?: (seconds: number) => void;
}) {
  const changes = Array.isArray(artifact.payload.changes)
    ? (artifact.payload.changes as Record<string, unknown>[])
    : [];
  if (changes.length > 0) {
    return (
      <ol className="flex flex-col gap-2">
        {changes.map((change, index) => {
          const after =
            typeof change.after === "object" && change.after !== null
              ? (change.after as Record<string, unknown>)
              : null;
          const start = Number(
            change.start_seconds ?? after?.start_seconds ?? Number.NaN,
          );
          return (
            <li
              key={`${artifact.artifact_id}-${index}`}
              className="rounded-md border p-3"
            >
              <p className="text-sm font-medium">
                {String(change.operation ?? `第 ${index + 1} 项`)}
              </p>
              {change.before !== undefined || change.after !== undefined ? (
                <pre className="mt-2 overflow-auto text-xs text-muted-foreground">
                  {JSON.stringify(
                    { before: change.before, after: change.after },
                    null,
                    2,
                  )}
                </pre>
              ) : null}
              {Number.isFinite(start) && on_seek ? (
                <Button
                  variant="link"
                  className="px-0"
                  onClick={() => on_seek(start)}
                >
                  跳转到 {format_time(start)}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ol>
    );
  }
  if (typeof artifact.payload.diff === "string") {
    return (
      <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs">
        {artifact.payload.diff}
      </pre>
    );
  }
  return (
    <details>
      <summary className="cursor-pointer text-sm text-muted-foreground">
        查看变更详情
      </summary>
      <pre className="mt-2 overflow-auto rounded-md bg-muted p-3 text-xs">
        {JSON.stringify(artifact.payload, null, 2)}
      </pre>
    </details>
  );
}

function artifact_description(result_type: string): string {
  return (
    {
      marker_changes: "标记操作将作为一个原子批次提交。",
      summary_edit: "总结正文与子文档建议将在确认后提交。",
      transcript_correction: "字幕文字会更新，时间边界保持不变。",
    }[result_type] ?? "确认后才会修改业务数据。"
  );
}

function artifact_status_label(status: AgentArtifact["status"]): string {
  return {
    pending: "待确认",
    approved: "已接受",
    rejected: "已拒绝",
    stale: "已过期",
  }[status];
}
