import { Bot, Database, MessageCirclePlus, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { use_optional_task_manager } from "@/app/task_manager";
import { AgentComposer } from "@/components/AgentComposer";
import { AgentContextAttachments } from "@/components/AgentContextAttachments";
import { AgentMarkdown } from "@/components/AgentMarkdown";
import { AiModelSelect } from "@/components/AiModelSelect";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Marker, MarkerContent } from "@/components/ui/marker";
import { Message, MessageContent } from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import type {
  AgentArtifact,
  AgentCapability,
  AgentEvidenceReference,
  AgentIndexStatus,
  AgentPermissionMode,
  AgentThinkingMode,
  AiModelSummary,
} from "@/shared/types";
import {
  AgentAnswerEvidence,
  AgentIndexStatusDetails,
  AgentRunMetricsDisclosure,
} from "./AgentAnswerDetails";
import {
  AgentArtifactCard,
  AgentRunBadge,
  AgentToolActivity,
  build_agent_timeline,
} from "./AgentPanelContent";
import type { AgentContextAttachmentDraft } from "./agent_context";
import { use_agent_panel } from "./use_agent_panel";

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
  context_attachments?: AgentContextAttachmentDraft[];
  default_thinking_mode?: AgentThinkingMode;
  thinking_modes_enabled?: boolean;
  library_scope_enabled?: boolean;
  permission_mode?: AgentPermissionMode;
  on_permission_mode_change?: (permission_mode: AgentPermissionMode) => void;
  permission_mode_saving?: boolean;
  permission_mode_error?: string | null;
  index_status?: AgentIndexStatus;
  title?: string;
  context_label?: string;
  placeholder?: string;
  on_seek?: (
    seconds: number,
    end_seconds?: number | null,
    evidence?: AgentEvidenceReference,
  ) => void;
  current_time?: number;
  on_artifact_change?: (artifact: AgentArtifact) => void | Promise<void>;
  className?: string;
};

export function AgentPanel({
  agent_id,
  asset_id,
  models,
  context = {},
  task_input = {},
  context_attachments = [],
  default_thinking_mode = "auto",
  thinking_modes_enabled = false,
  library_scope_enabled = false,
  permission_mode = "smart_approval",
  on_permission_mode_change,
  permission_mode_saving = false,
  permission_mode_error = null,
  index_status,
  title,
  context_label,
  placeholder,
  on_seek,
  current_time,
  on_artifact_change,
  className,
}: AgentPanelProps) {
  const task_manager = use_optional_task_manager();
  const visible_index_status =
    index_status ??
    (task_manager?.index_status?.asset_id === asset_id
      ? task_manager.index_status
      : undefined);
  const [evidence_return_seconds, set_evidence_return_seconds] = useState<
    number | null
  >(null);
  useEffect(() => set_evidence_return_seconds(null), [asset_id]);
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
    preparing_attachments,
    resolve_artifact,
    retrieval_scope,
    restoring,
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
    submit,
    thinking_mode,
  } = use_agent_panel({
    agent_id,
    asset_id,
    context,
    models,
    on_artifact_change,
    task_input,
    default_thinking_mode,
  });

  const [dismissed_attachment_ids, set_dismissed_attachment_ids] = useState(
    () => new Set<string>(),
  );
  const [dropped_attachments, set_dropped_attachments] = useState<
    AgentContextAttachmentDraft[]
  >([]);
  useEffect(() => {
    set_dismissed_attachment_ids(new Set());
    set_dropped_attachments([]);
  }, [scope_key]);
  const visible_attachments = useMemo(
    () =>
      [...context_attachments, ...dropped_attachments].filter(
        (attachment) => !dismissed_attachment_ids.has(attachment.draft_id),
      ),
    [context_attachments, dismissed_attachment_ids, dropped_attachments],
  );

  const panel_title = title ?? "助手";
  const task_input_mode = definition?.definition.input_mode === "task";

  async function submit_current(content_override?: string) {
    const submitted = await submit(content_override, visible_attachments);
    if (submitted) {
      set_dismissed_attachment_ids(
        new Set(visible_attachments.map((attachment) => attachment.draft_id)),
      );
      set_dropped_attachments([]);
    }
  }

  if (!asset_id) {
    return (
      <Empty className={className}>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Bot />
          </EmptyMedia>
          <EmptyTitle>请先选择视频</EmptyTitle>
          <EmptyDescription>助手只处理当前工作区中的素材。</EmptyDescription>
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
        <div className="flex min-w-0 items-center justify-between gap-2">
          <Select
            value={state?.session.session_id ?? ""}
            onValueChange={(session_id) => void select_session(session_id)}
          >
            <SelectTrigger
              size="sm"
              variant="ghost"
              className="max-w-full min-w-0"
              aria-label={`${panel_title}历史对话${context_label ? `，${context_label}` : ""}`}
            >
              <SelectValue placeholder="新建对话" />
            </SelectTrigger>
            <SelectContent position="popper" align="start">
              <SelectGroup>
                {sessions.length ? (
                  sessions.map((session) => (
                    <SelectItem
                      key={session.session_id}
                      value={session.session_id}
                    >
                      {session.title}
                    </SelectItem>
                  ))
                ) : (
                  <SelectLabel>暂无历史对话</SelectLabel>
                )}
              </SelectGroup>
            </SelectContent>
          </Select>
          <div className="flex shrink-0 items-center gap-1">
            {active_run ? (
              <AgentRunBadge stage={active_run.stage} />
            ) : (
              <Badge variant="outline">未开始</Badge>
            )}
            {visible_index_status ? (
              <AgentIndexStatusControl status={visible_index_status} />
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="新建对话"
              title={pending ? "任务运行中，暂时无法新建对话" : "新建对话"}
              disabled={pending || restoring}
              onClick={() => {
                start_new_conversation();
                set_dismissed_attachment_ids(new Set());
                set_dropped_attachments([]);
              }}
            >
              <MessageCirclePlus />
            </Button>
          </div>
        </div>
        {task_input_mode ? (
          <AiModelSelect
            id={`${agent_id}-agent-model`}
            label="执行模型"
            models={compatible_models}
            value={model_id}
            on_change={set_model_id}
          />
        ) : null}
        <Badge className="w-fit" variant="secondary">
          {retrieval_scope === "library" ? "资料库范围" : "当前视频"}
        </Badge>
        {definition && compatible_models.length === 0 ? (
          <Alert variant="destructive">
            <AlertTitle>没有兼容模型</AlertTitle>
            <AlertDescription>
              {definition.definition.required_capabilities.length
                ? `助手要求：${definition.definition.required_capabilities
                    .map((capability) => CAPABILITY_LABELS[capability])
                    .join("、")}`
                : (definition.unavailable_reason ??
                  "助手当前缺少完成该操作的模型能力")}
            </AlertDescription>
          </Alert>
        ) : null}
      </CardHeader>
      <CardContent className="min-h-0 flex-1 p-0">
        <MessageScrollerProvider autoScroll>
          <MessageScroller>
            <MessageScrollerViewport
              role="log"
              aria-label="助手对话消息"
              aria-live="polite"
              tabIndex={0}
            >
              <MessageScrollerContent className="gap-4 p-4">
                {restoring ? (
                  <MessageScrollerItem messageId="restoring-session">
                    <Marker>
                      <MarkerContent className="shimmer">
                        正在加载助手会话…
                      </MarkerContent>
                    </Marker>
                  </MessageScrollerItem>
                ) : null}
                {!restoring &&
                !error &&
                events.length === 0 &&
                artifacts.length === 0 ? (
                  <MessageScrollerItem messageId="empty-session">
                    <Empty className="border-0">
                      <EmptyHeader>
                        <EmptyMedia variant="icon">
                          <ShieldCheck />
                        </EmptyMedia>
                        <EmptyTitle>尚未创建会话</EmptyTitle>
                        <EmptyDescription>
                          首次发送消息或启动任务时才会创建，会话会与当前工作对象绑定。
                        </EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  </MessageScrollerItem>
                ) : null}
                {build_agent_timeline(events, state?.runs).map((item) => (
                  <MessageScrollerItem
                    key={item.id}
                    messageId={item.id}
                    scrollAnchor={
                      item.type === "message" && item.role === "user"
                    }
                  >
                    {item.type === "message" ? (
                      <Message align={item.role === "user" ? "end" : "start"}>
                        <MessageContent>
                          {item.context_attachments?.length ? (
                            <AgentContextAttachments
                              attachments={item.context_attachments}
                              label="该消息发送时的上下文附件"
                            />
                          ) : null}
                          {item.content ? (
                            <Bubble
                              align={item.role === "user" ? "end" : "start"}
                              variant={
                                item.role === "user" ? "default" : "muted"
                              }
                            >
                              <BubbleContent>
                                {item.role === "assistant" ? (
                                  <AgentMarkdown content={item.content} />
                                ) : (
                                  <p className="whitespace-pre-wrap">
                                    {item.content}
                                  </p>
                                )}
                              </BubbleContent>
                            </Bubble>
                          ) : null}
                          {item.role === "assistant" ? (
                            <>
                              <AgentAnswerEvidence
                                confidence={item.confidence}
                                answer_status={item.answer_status}
                                evidence_bundle={item.evidence_bundle}
                                citation_validation={item.citation_validation}
                                on_seek={
                                  on_seek
                                    ? (seconds, end_seconds, evidence) => {
                                        if (
                                          evidence_return_seconds === null &&
                                          typeof current_time === "number"
                                        ) {
                                          set_evidence_return_seconds(
                                            current_time,
                                          );
                                        }
                                        on_seek(seconds, end_seconds, evidence);
                                      }
                                    : undefined
                                }
                                current_asset_id={asset_id}
                                return_position_seconds={
                                  evidence_return_seconds
                                }
                                on_return={
                                  on_seek && evidence_return_seconds !== null
                                    ? () => {
                                        on_seek(evidence_return_seconds);
                                        set_evidence_return_seconds(null);
                                      }
                                    : undefined
                                }
                              />
                              {item.metrics ? (
                                <AgentRunMetricsDisclosure
                                  metrics={item.metrics}
                                />
                              ) : null}
                            </>
                          ) : null}
                        </MessageContent>
                      </Message>
                    ) : (
                      <AgentToolActivity events={item.events} />
                    )}
                  </MessageScrollerItem>
                ))}
                {stream_text ? (
                  <MessageScrollerItem messageId="streaming-answer">
                    <Message align="start">
                      <MessageContent>
                        <Bubble align="start" variant="muted">
                          <BubbleContent>
                            <AgentMarkdown content={stream_text} />
                          </BubbleContent>
                        </Bubble>
                      </MessageContent>
                    </Message>
                  </MessageScrollerItem>
                ) : null}
                {pending && !stream_text ? (
                  <MessageScrollerItem messageId="pending-answer">
                    <Marker>
                      <MarkerContent className="shimmer">
                        正在处理当前问题…
                      </MarkerContent>
                    </Marker>
                  </MessageScrollerItem>
                ) : null}
                {artifacts.map((artifact) => (
                  <MessageScrollerItem
                    key={artifact.artifact_id}
                    messageId={artifact.artifact_id}
                  >
                    <AgentArtifactCard
                      artifact={artifact}
                      on_seek={on_seek}
                      on_resolve={(action, grant_scope) =>
                        void resolve_artifact(artifact, action, grant_scope)
                      }
                      on_regenerate={() =>
                        void submit(last_content, visible_attachments)
                      }
                    />
                  </MessageScrollerItem>
                ))}
                {connection_message ? (
                  <MessageScrollerItem messageId="connection-message">
                    <div className="flex flex-col items-center gap-2">
                      <Marker variant="separator">
                        <MarkerContent>{connection_message}</MarkerContent>
                      </Marker>
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
                  </MessageScrollerItem>
                ) : null}
                {error ? (
                  <MessageScrollerItem messageId="agent-error">
                    <Alert variant="destructive">
                      <AlertTitle>助手运行失败</AlertTitle>
                      <AlertDescription>{error}</AlertDescription>
                    </Alert>
                  </MessageScrollerItem>
                ) : null}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        </MessageScrollerProvider>
      </CardContent>
      <CardFooter className="block p-0">
        {task_input_mode ? (
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
              onClick={() => void submit_current()}
              disabled={pending || !definition.available || !model_id}
            >
              启动任务
            </Button>
          </div>
        ) : (
          <AgentComposer
            value={draft}
            on_change={set_draft}
            on_submit={() => void submit_current()}
            on_cancel={
              active_run ? () => void cancel_run(active_run.run_id) : undefined
            }
            pending={pending}
            preparing_attachments={preparing_attachments}
            disabled={!definition?.available || !model_id}
            placeholder={placeholder ?? "输入消息；运行时仍可编辑下一条草稿"}
            models={compatible_models}
            model_id={model_id}
            on_model_change={set_model_id}
            thinking_mode={thinking_mode}
            on_thinking_mode_change={set_thinking_mode}
            thinking_modes_enabled={thinking_modes_enabled}
            retrieval_scope={retrieval_scope}
            on_retrieval_scope_change={(scope) => {
              set_retrieval_scope(scope);
              if (scope === "current_asset") set_scope_pinned(false);
            }}
            library_scope_enabled={library_scope_enabled}
            scope_pinned={scope_pinned}
            on_scope_pinned_change={set_scope_pinned}
            permission_mode={permission_mode}
            on_permission_mode_change={on_permission_mode_change}
            permission_mode_saving={permission_mode_saving}
            permission_mode_error={permission_mode_error}
            attachments={visible_attachments}
            on_remove_attachment={(draft_id) =>
              set_dismissed_attachment_ids(
                (current) => new Set([...current, draft_id]),
              )
            }
            on_attachment_drop={(attachment) =>
              set_dropped_attachments((current) => [
                ...current.filter(
                  (item) => item.draft_id !== attachment.draft_id,
                ),
                attachment,
              ])
            }
          />
        )}
      </CardFooter>
    </Card>
  );
}

function AgentIndexStatusControl({ status }: { status: AgentIndexStatus }) {
  const indexing =
    status.state === "initializing" || status.state === "partial";

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`索引状态：${status.stage_label}`}
          aria-invalid={status.state === "failed" || undefined}
          title="查看索引状态"
        >
          {indexing ? <Spinner /> : <Database />}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="end"
        sideOffset={8}
        aria-label="索引状态"
      >
        <PopoverHeader>
          <PopoverTitle>索引状态</PopoverTitle>
          <PopoverDescription>{status.stage_label}</PopoverDescription>
        </PopoverHeader>
        <AgentIndexStatusDetails status={status} />
      </PopoverContent>
    </Popover>
  );
}
