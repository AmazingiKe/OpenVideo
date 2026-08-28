import { Bot, History, ShieldCheck } from "lucide-react";

import { AiModelSelect } from "@/components/AiModelSelect";
import {
  Bubble,
  Marker,
  Message,
  MessageComposer,
  MessageScroller,
} from "@/components/chat";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { cn } from "@/lib/utils";
import type {
  AgentArtifact,
  AgentCapability,
  AiModelSummary,
} from "@/shared/types";
import {
  AgentArtifactCard,
  AgentReasoning,
  AgentRunBadge,
  AgentToolActivity,
  build_agent_timeline,
} from "./AgentPanelContent";
import { use_agent_panel, type AgentRunOption } from "./use_agent_panel";

const CAPABILITY_LABELS: Record<AgentCapability, string> = {
  tools: "工具调用",
  vision: "图片输入",
  long_context: "长上下文",
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
  const {
    active_run,
    artifacts,
    cancel_run,
    compatible_models,
    connection_message,
    definition,
    draft,
    error,
    events,
    follow_run,
    last_content,
    model_id,
    pending,
    resolve_artifact,
    run_option_value,
    selected_run_option,
    select_session,
    sessions,
    set_draft,
    set_model_id,
    set_run_option_value,
    state,
    stream_reasoning,
    stream_text,
    submit,
  } = use_agent_panel({
    agent_id,
    asset_id,
    context,
    models,
    on_artifact_change,
    run_options,
    task_input,
  });

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
          {build_agent_timeline(events).map((item) => {
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
}
