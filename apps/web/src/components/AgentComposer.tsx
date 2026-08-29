import { Pin, Send, Square } from "lucide-react";
import { useId, type DragEvent, type FormEvent } from "react";

import { AgentContextAttachments } from "@/components/AgentContextAttachments";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { AgentRetrievalScope, AgentThinkingMode } from "@/shared/types";
import type { AgentContextAttachmentDraft } from "./agent_context";

const CONTEXT_ATTACHMENT_MIME = "application/x-openvideo-agent-context";

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

  function submit(event: FormEvent) {
    event.preventDefault();
    if (value.trim() && !disabled && !submitting) on_submit();
  }

  function drop_attachment(event: DragEvent<HTMLFormElement>) {
    if (!on_attachment_drop) return;
    const encoded = event.dataTransfer.getData(CONTEXT_ATTACHMENT_MIME);
    if (!encoded) return;
    event.preventDefault();
    const attachment = parse_context_attachment(encoded);
    if (attachment) on_attachment_drop(attachment);
  }

  return (
    <form
      className="flex flex-col gap-3 border-t bg-surface-background-soft p-3"
      onSubmit={submit}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes(CONTEXT_ATTACHMENT_MIME)) {
          event.preventDefault();
        }
      }}
      onDrop={drop_attachment}
    >
      {attachments.length > 0 ? (
        <AgentContextAttachments
          attachments={attachments}
          on_remove={on_remove_attachment}
          label="当前消息的上下文附件"
        />
      ) : null}
      <FieldGroup className="gap-2">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <Field className="w-auto flex-row items-center gap-1">
            <FieldLabel className="sr-only" id={`${control_id}-thinking-mode`}>
              思考模式
            </FieldLabel>
            <ToggleGroup
              type="single"
              size="sm"
              spacing={1}
              value={thinking_mode}
              onValueChange={(value) => {
                if (is_thinking_mode(value)) on_thinking_mode_change(value);
              }}
              aria-labelledby={`${control_id}-thinking-mode`}
            >
              <ToggleGroupItem
                value="auto"
                disabled={!thinking_modes_enabled}
                title={
                  thinking_modes_enabled
                    ? "由快速模型判断是否升级"
                    : "模型角色路由尚未接通"
                }
              >
                自动
              </ToggleGroupItem>
              <ToggleGroupItem
                value="fast"
                disabled={!thinking_modes_enabled}
                title={
                  thinking_modes_enabled
                    ? "强制使用快速文本模型"
                    : "模型角色路由尚未接通"
                }
              >
                快速
              </ToggleGroupItem>
              <ToggleGroupItem
                value="complex"
                disabled={!thinking_modes_enabled}
                title={
                  thinking_modes_enabled
                    ? "强制使用复杂文本模型"
                    : "模型角色路由尚未接通"
                }
              >
                复杂思考
              </ToggleGroupItem>
            </ToggleGroup>
          </Field>
          <Field className="w-auto flex-row items-center gap-1">
            <FieldLabel
              className="sr-only"
              id={`${control_id}-retrieval-scope`}
            >
              检索范围
            </FieldLabel>
            <ToggleGroup
              type="single"
              size="sm"
              spacing={1}
              value={retrieval_scope}
              onValueChange={(value) => {
                if (is_retrieval_scope(value)) {
                  on_retrieval_scope_change(value);
                }
              }}
              aria-labelledby={`${control_id}-retrieval-scope`}
            >
              <ToggleGroupItem value="current_asset">当前视频</ToggleGroupItem>
              <ToggleGroupItem
                value="library"
                disabled={!library_scope_enabled}
                title={
                  library_scope_enabled
                    ? "仅当前消息检索已分析资料库"
                    : "跨资料库检索尚未接通"
                }
              >
                资料库
              </ToggleGroupItem>
            </ToggleGroup>
            <Toggle
              size="sm"
              pressed={scope_pinned}
              onPressedChange={on_scope_pinned_change}
              disabled={!library_scope_enabled || retrieval_scope !== "library"}
              aria-label="将资料库范围固定到当前对话"
              title="固定到当前对话"
            >
              <Pin />
            </Toggle>
          </Field>
        </div>
        {!thinking_modes_enabled || !library_scope_enabled ? (
          <p className="text-xs text-muted-foreground">
            {capability_note(thinking_modes_enabled, library_scope_enabled)}
          </p>
        ) : null}
        <Field className="flex-row items-end gap-2">
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
            className="max-h-32 min-h-16 resize-none"
          />
          <Button
            type={pending && on_cancel ? "button" : "submit"}
            size="icon"
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
              <Send />
            )}
          </Button>
        </Field>
      </FieldGroup>
    </form>
  );
}

function parse_context_attachment(
  encoded: string,
): AgentContextAttachmentDraft | null {
  try {
    const value = JSON.parse(encoded) as Record<string, unknown>;
    if (
      typeof value.draft_id !== "string" ||
      !is_attachment_kind(value.kind) ||
      typeof value.asset_id !== "string" ||
      typeof value.label !== "string"
    ) {
      return null;
    }
    return {
      draft_id: value.draft_id,
      kind: value.kind,
      asset_id: value.asset_id,
      label: value.label,
      reference_id:
        typeof value.reference_id === "string" ? value.reference_id : undefined,
      version_id:
        typeof value.version_id === "string" ? value.version_id : undefined,
      start_seconds:
        typeof value.start_seconds === "number"
          ? value.start_seconds
          : undefined,
      end_seconds:
        typeof value.end_seconds === "number" ? value.end_seconds : undefined,
      snapshot_text:
        typeof value.snapshot_text === "string"
          ? value.snapshot_text
          : undefined,
      selection_start:
        typeof value.selection_start === "number"
          ? value.selection_start
          : undefined,
      selection_end:
        typeof value.selection_end === "number"
          ? value.selection_end
          : undefined,
    };
  } catch {
    return null;
  }
}

function is_attachment_kind(
  value: unknown,
): value is AgentContextAttachmentDraft["kind"] {
  return (
    value === "summary_selection" ||
    value === "transcript_selection" ||
    value === "time_range"
  );
}

function is_thinking_mode(value: string): value is AgentThinkingMode {
  return value === "auto" || value === "fast" || value === "complex";
}

function is_retrieval_scope(value: string): value is AgentRetrievalScope {
  return value === "current_asset" || value === "library";
}

function capability_note(
  thinking_modes_enabled: boolean,
  library_scope_enabled: boolean,
) {
  if (!thinking_modes_enabled && !library_scope_enabled) {
    return "当前服务仅支持自动模式和当前视频；更多能力接通后解锁。";
  }
  return thinking_modes_enabled
    ? "跨资料库检索尚未接通。"
    : "快速与复杂模型路由尚未接通。";
}
