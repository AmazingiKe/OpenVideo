import {
  ArrowUp,
  ChevronDown,
  Pin,
  Plus,
  ShieldCheck,
  Sparkles,
  Square,
} from "lucide-react";
import { useId, useState, type DragEvent, type FormEvent } from "react";

import { AgentContextAttachments } from "@/components/AgentContextAttachments";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import type { AgentRetrievalScope, AgentThinkingMode } from "@/shared/types";
import {
  AGENT_CONTEXT_ATTACHMENT_MIME,
  read_context_attachment_drag_data,
  type AgentContextAttachmentDraft,
} from "./agent_context";

const THINKING_MODE_LABELS: Record<AgentThinkingMode, string> = {
  auto: "自动模式",
  fast: "快速模式",
  complex: "复杂思考",
};

const RETRIEVAL_SCOPE_LABELS: Record<AgentRetrievalScope, string> = {
  current_asset: "当前视频",
  library: "资料库",
};

export function AgentComposer({
  value,
  on_change,
  on_submit,
  on_cancel,
  disabled = false,
  pending = false,
  preparing_attachments = false,
  placeholder = "描述希望如何处理当前内容…",
  thinking_mode,
  on_thinking_mode_change,
  thinking_modes_enabled,
  retrieval_scope,
  on_retrieval_scope_change,
  library_scope_enabled,
  scope_pinned,
  on_scope_pinned_change,
  attachments,
  on_remove_attachment,
  on_attachment_drop,
}: {
  value: string;
  on_change: (value: string) => void;
  on_submit: () => void;
  on_cancel?: () => void;
  disabled?: boolean;
  pending?: boolean;
  preparing_attachments?: boolean;
  placeholder?: string;
  thinking_mode: AgentThinkingMode;
  on_thinking_mode_change: (mode: AgentThinkingMode) => void;
  thinking_modes_enabled: boolean;
  retrieval_scope: AgentRetrievalScope;
  on_retrieval_scope_change: (scope: AgentRetrievalScope) => void;
  library_scope_enabled: boolean;
  scope_pinned: boolean;
  on_scope_pinned_change: (pinned: boolean) => void;
  attachments: AgentContextAttachmentDraft[];
  on_remove_attachment: (draft_id: string) => void;
  on_attachment_drop?: (attachment: AgentContextAttachmentDraft) => void;
}) {
  const submitting = pending || preparing_attachments;
  const control_id = useId();
  const [context_drop_active, set_context_drop_active] = useState(false);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (value.trim() && !disabled && !submitting) on_submit();
  }

  function drop_attachment(event: DragEvent<HTMLFormElement>) {
    if (!on_attachment_drop) return;
    const attachment = read_context_attachment_drag_data(event.dataTransfer);
    set_context_drop_active(false);
    if (!attachment) return;
    event.preventDefault();
    on_attachment_drop(attachment);
  }

  return (
    <form
      className="bg-background p-3"
      data-slot="agent-composer"
      data-context-drop-active={context_drop_active}
      onSubmit={submit}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes(AGENT_CONTEXT_ATTACHMENT_MIME)) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          set_context_drop_active(true);
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          set_context_drop_active(false);
        }
      }}
      onDrop={drop_attachment}
    >
      <div
        className={cn(
          "flex flex-col gap-2 rounded-3xl border bg-card p-2 transition-[border-color,box-shadow] focus-within:border-focus focus-within:ring-3 focus-within:ring-focus-ring",
          context_drop_active && "border-focus ring-3 ring-focus-ring",
        )}
        data-slot="agent-composer-surface"
      >
        {context_drop_active ? (
          <p
            className="px-2 pt-2 text-center text-xs font-medium text-focus"
            role="status"
          >
            松开即可添加为可见上下文
          </p>
        ) : null}
        {attachments.length > 0 ? (
          <div className="px-2 pt-2">
            <AgentContextAttachments
              attachments={attachments}
              on_remove={on_remove_attachment}
              label="当前消息的上下文附件"
            />
          </div>
        ) : null}
        <FieldGroup className="gap-2">
          <Field data-disabled={disabled || undefined}>
            <FieldLabel className="sr-only" htmlFor={`${control_id}-composer`}>
              助手指令
            </FieldLabel>
            <Textarea
              id={`${control_id}-composer`}
              value={value}
              onChange={(event) => on_change(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  if (value.trim() && !disabled && !submitting) on_submit();
                }
              }}
              placeholder={placeholder}
              rows={2}
              disabled={disabled}
              variant="ghost"
              className="max-h-40 min-h-20 resize-none"
            />
          </Field>
          <div className="flex min-w-0 items-center justify-between gap-2 px-1 pb-1">
            <div className="flex min-w-0 items-center gap-1">
              <ContextAttachmentHelp attachment_count={attachments.length} />
              <RetrievalScopeControl
                control_id={control_id}
                retrieval_scope={retrieval_scope}
                on_retrieval_scope_change={on_retrieval_scope_change}
                library_scope_enabled={library_scope_enabled}
                scope_pinned={scope_pinned}
                on_scope_pinned_change={on_scope_pinned_change}
              />
            </div>
            <div className="flex min-w-0 items-center justify-end gap-1">
              <ThinkingModeControl
                control_id={control_id}
                thinking_mode={thinking_mode}
                on_thinking_mode_change={on_thinking_mode_change}
                thinking_modes_enabled={thinking_modes_enabled}
              />
              <Button
                type={pending && on_cancel ? "button" : "submit"}
                size="icon-lg"
                className="rounded-full"
                disabled={
                  disabled ||
                  preparing_attachments ||
                  (pending ? !on_cancel : !value.trim())
                }
                aria-label={pending && on_cancel ? "停止助手" : "发送指令"}
                onClick={pending && on_cancel ? on_cancel : undefined}
              >
                {submitting ? (
                  pending && on_cancel ? (
                    <Square />
                  ) : (
                    <Spinner />
                  )
                ) : (
                  <ArrowUp />
                )}
              </Button>
            </div>
          </div>
        </FieldGroup>
      </div>
    </form>
  );
}

function ContextAttachmentHelp({
  attachment_count,
}: {
  attachment_count: number;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="rounded-full"
          aria-label="添加上下文"
        >
          <Plus />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-64"
        aria-label="添加上下文"
      >
        <PopoverHeader>
          <PopoverTitle>添加上下文</PopoverTitle>
          <PopoverDescription>
            从时间线或文档工具栏拖入此输入框，作为本次消息可见的上下文。
          </PopoverDescription>
        </PopoverHeader>
        {attachment_count > 0 ? (
          <p className="text-xs text-muted-foreground">
            已添加 {attachment_count} 项上下文
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function RetrievalScopeControl({
  control_id,
  retrieval_scope,
  on_retrieval_scope_change,
  library_scope_enabled,
  scope_pinned,
  on_scope_pinned_change,
}: {
  control_id: string;
  retrieval_scope: AgentRetrievalScope;
  on_retrieval_scope_change: (scope: AgentRetrievalScope) => void;
  library_scope_enabled: boolean;
  scope_pinned: boolean;
  on_scope_pinned_change: (pinned: boolean) => void;
}) {
  const label = RETRIEVAL_SCOPE_LABELS[retrieval_scope];
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`检索范围：${label}`}
        >
          <ShieldCheck data-icon="inline-start" />
          <span className="truncate">{label}</span>
          <ChevronDown data-icon="inline-end" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        aria-label="检索范围"
      >
        <PopoverHeader>
          <PopoverTitle>检索范围</PopoverTitle>
          <PopoverDescription>
            {library_scope_enabled
              ? "选择助手可以检索的内容范围。"
              : "跨资料库检索尚未接通，仅支持当前视频。"}
          </PopoverDescription>
        </PopoverHeader>
        <Field>
          <FieldLabel className="sr-only" id={`${control_id}-retrieval-scope`}>
            检索范围
          </FieldLabel>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            spacing={1}
            value={retrieval_scope}
            className="w-full"
            onValueChange={(value) => {
              if (is_retrieval_scope(value)) {
                on_retrieval_scope_change(value);
              }
            }}
            aria-labelledby={`${control_id}-retrieval-scope`}
          >
            <ToggleGroupItem className="flex-1" value="current_asset">
              当前视频
            </ToggleGroupItem>
            <ToggleGroupItem
              className="flex-1"
              value="library"
              disabled={!library_scope_enabled}
            >
              资料库
            </ToggleGroupItem>
          </ToggleGroup>
        </Field>
        <Field className="flex-row items-center justify-between gap-2">
          <FieldLabel htmlFor={`${control_id}-scope-pinned`}>
            固定到当前对话
          </FieldLabel>
          <Toggle
            id={`${control_id}-scope-pinned`}
            size="sm"
            pressed={scope_pinned}
            onPressedChange={on_scope_pinned_change}
            disabled={!library_scope_enabled || retrieval_scope !== "library"}
            aria-label="将资料库范围固定到当前对话"
          >
            <Pin />
          </Toggle>
        </Field>
      </PopoverContent>
    </Popover>
  );
}

function ThinkingModeControl({
  control_id,
  thinking_mode,
  on_thinking_mode_change,
  thinking_modes_enabled,
}: {
  control_id: string;
  thinking_mode: AgentThinkingMode;
  on_thinking_mode_change: (mode: AgentThinkingMode) => void;
  thinking_modes_enabled: boolean;
}) {
  const label = THINKING_MODE_LABELS[thinking_mode];
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`思考模式：${label}`}
        >
          <Sparkles data-icon="inline-start" />
          <span className="truncate">{label}</span>
          <ChevronDown data-icon="inline-end" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        aria-label="思考模式"
      >
        <PopoverHeader>
          <PopoverTitle>思考模式</PopoverTitle>
          <PopoverDescription>
            {thinking_modes_enabled
              ? "选择此次消息的模型路由方式。"
              : "模型角色路由尚未接通，仅支持自动模式。"}
          </PopoverDescription>
        </PopoverHeader>
        <Field>
          <FieldLabel className="sr-only" id={`${control_id}-thinking-mode`}>
            思考模式
          </FieldLabel>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            spacing={1}
            value={thinking_mode}
            className="w-full"
            onValueChange={(value) => {
              if (is_thinking_mode(value)) on_thinking_mode_change(value);
            }}
            aria-labelledby={`${control_id}-thinking-mode`}
          >
            <ToggleGroupItem className="flex-1" value="auto">
              自动
            </ToggleGroupItem>
            <ToggleGroupItem
              className="flex-1"
              value="fast"
              disabled={!thinking_modes_enabled}
            >
              快速
            </ToggleGroupItem>
            <ToggleGroupItem
              className="flex-1"
              value="complex"
              disabled={!thinking_modes_enabled}
            >
              复杂思考
            </ToggleGroupItem>
          </ToggleGroup>
        </Field>
      </PopoverContent>
    </Popover>
  );
}

function is_thinking_mode(value: string): value is AgentThinkingMode {
  return value === "auto" || value === "fast" || value === "complex";
}

function is_retrieval_scope(value: string): value is AgentRetrievalScope {
  return value === "current_asset" || value === "library";
}
