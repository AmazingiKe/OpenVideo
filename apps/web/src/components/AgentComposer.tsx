import {
  ArrowUp,
  ChevronDown,
  Pin,
  Plus,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  Zap,
} from "lucide-react";
import { useId, useState, type DragEvent, type FormEvent } from "react";

import { AgentContextAttachments } from "@/components/AgentContextAttachments";
import { AiModelSelect } from "@/components/AiModelSelect";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { Slider } from "@/components/ui/slider";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { Toggle } from "@/components/ui/toggle";
import { cn } from "@/lib/utils";
import type {
  AgentPermissionMode,
  AgentRetrievalScope,
  AgentThinkingMode,
  AiModelSummary,
} from "@/shared/types";
import {
  AGENT_CONTEXT_ATTACHMENT_MIME,
  read_context_attachment_drag_data,
  type AgentContextAttachmentDraft,
} from "./agent_context";

const THINKING_MODE_OPTIONS = [
  { value: "fast", label: "低" },
  { value: "auto", label: "自动" },
  { value: "complex", label: "高" },
] as const satisfies ReadonlyArray<{
  value: AgentThinkingMode;
  label: string;
}>;

const RETRIEVAL_SCOPE_OPTIONS = [
  { value: "current_asset", label: "当前视频" },
  { value: "library", label: "资料库" },
] as const satisfies ReadonlyArray<{
  value: AgentRetrievalScope;
  label: string;
}>;

const PERMISSION_MODE_OPTIONS = [
  {
    value: "request_approval",
    label: "始终询问",
    description: "写入、删除或外部工具操作都会先请求批准。",
  },
  {
    value: "smart_approval",
    label: "仅风险询问",
    description: "正常读取直接执行，只在检测到风险操作时询问。",
  },
  {
    value: "full_access",
    label: "完全访问",
    description: "已启用的工具不再逐次询问，请仅在可信环境中使用。",
  },
] as const satisfies ReadonlyArray<{
  value: AgentPermissionMode;
  label: string;
  description: string;
}>;

export function AgentComposer({
  value,
  on_change,
  on_submit,
  on_cancel,
  disabled = false,
  pending = false,
  preparing_attachments = false,
  placeholder = "描述希望如何处理当前内容…",
  models,
  model_id,
  on_model_change,
  thinking_mode,
  on_thinking_mode_change,
  thinking_modes_enabled,
  retrieval_scope,
  on_retrieval_scope_change,
  library_scope_enabled,
  scope_pinned,
  on_scope_pinned_change,
  permission_mode = "smart_approval",
  on_permission_mode_change,
  permission_mode_saving = false,
  permission_mode_error = null,
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
  models: AiModelSummary[];
  model_id: string | null;
  on_model_change: (model_id: string | null) => void;
  thinking_mode: AgentThinkingMode;
  on_thinking_mode_change: (mode: AgentThinkingMode) => void;
  thinking_modes_enabled: boolean;
  retrieval_scope: AgentRetrievalScope;
  on_retrieval_scope_change: (scope: AgentRetrievalScope) => void;
  library_scope_enabled: boolean;
  scope_pinned: boolean;
  on_scope_pinned_change: (pinned: boolean) => void;
  permission_mode?: AgentPermissionMode;
  on_permission_mode_change?: (permission_mode: AgentPermissionMode) => void;
  permission_mode_saving?: boolean;
  permission_mode_error?: string | null;
  attachments: AgentContextAttachmentDraft[];
  on_remove_attachment: (draft_id: string) => void;
  on_attachment_drop?: (attachment: AgentContextAttachmentDraft) => void;
}) {
  const submitting = pending || preparing_attachments;
  const control_id = useId();
  const [context_drop_active, set_context_drop_active] = useState(false);
  const selected_permission_option =
    find_permission_mode_option(permission_mode);

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
        <div className="flex min-w-0 items-center gap-1 px-1 pt-1">
          <Badge variant="secondary">
            {retrieval_scope === "library" ? "资料库" : "当前视频"}
          </Badge>
          <Badge
            variant={
              permission_mode === "full_access" ? "destructive" : "outline"
            }
            aria-label={`权限状态：${selected_permission_option.label}`}
          >
            {selected_permission_option.label}
          </Badge>
        </div>
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
                permission_mode={permission_mode}
                on_permission_mode_change={on_permission_mode_change}
                permission_mode_saving={permission_mode_saving}
                permission_mode_error={permission_mode_error}
              />
            </div>
            <div className="flex min-w-0 items-center justify-end gap-1">
              <ModelThinkingControl
                control_id={control_id}
                models={models}
                model_id={model_id}
                on_model_change={on_model_change}
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
  permission_mode,
  on_permission_mode_change,
  permission_mode_saving,
  permission_mode_error,
}: {
  control_id: string;
  retrieval_scope: AgentRetrievalScope;
  on_retrieval_scope_change: (scope: AgentRetrievalScope) => void;
  library_scope_enabled: boolean;
  scope_pinned: boolean;
  on_scope_pinned_change: (pinned: boolean) => void;
  permission_mode: AgentPermissionMode;
  on_permission_mode_change?: (permission_mode: AgentPermissionMode) => void;
  permission_mode_saving: boolean;
  permission_mode_error: string | null;
}) {
  const selected_index = RETRIEVAL_SCOPE_OPTIONS.findIndex(
    (option) => option.value === retrieval_scope,
  );
  const selected_option = RETRIEVAL_SCOPE_OPTIONS[selected_index];
  const selected_permission_option =
    find_permission_mode_option(permission_mode);
  const selected_permission_index = PERMISSION_MODE_OPTIONS.indexOf(
    selected_permission_option,
  );
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="rounded-full"
          aria-label={`检索与权限：${selected_option.label}，${selected_permission_option.label}`}
          title="检索与权限"
        >
          <SlidersHorizontal />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-72 gap-4 rounded-3xl p-4"
        aria-label="检索与权限"
      >
        <PopoverHeader>
          <PopoverTitle className="sr-only">检索与权限</PopoverTitle>
          <div className="flex min-w-0 items-center gap-2">
            <ShieldCheck
              className="size-4 shrink-0 text-primary"
              aria-hidden="true"
            />
            <span className="font-medium">检索与权限</span>
          </div>
          <PopoverDescription>
            {library_scope_enabled
              ? "控制助手可以检索的内容范围与执行操作的授权方式。"
              : "资料库检索尚未接通；仍可调整操作授权方式。"}
          </PopoverDescription>
        </PopoverHeader>
        <Field className="gap-2">
          <div className="flex items-center justify-between gap-2">
            <FieldLabel htmlFor={`${control_id}-retrieval-scope`}>
              检索范围
            </FieldLabel>
            <span className="text-sm text-primary" aria-live="polite">
              {selected_option.label}
            </span>
          </div>
          <Slider
            id={`${control_id}-retrieval-scope`}
            min={0}
            max={RETRIEVAL_SCOPE_OPTIONS.length - 1}
            step={1}
            variant="strength"
            value={[selected_index]}
            onValueChange={([next_index]) => {
              const next_option = RETRIEVAL_SCOPE_OPTIONS[next_index];
              if (next_option) on_retrieval_scope_change(next_option.value);
            }}
            disabled={!library_scope_enabled}
            aria-label="检索范围"
            aria-valuetext={selected_option.label}
            aria-describedby={
              library_scope_enabled
                ? undefined
                : `${control_id}-retrieval-scope-unavailable`
            }
          />
          <div
            className="grid grid-cols-2 text-xs text-muted-foreground"
            aria-hidden="true"
          >
            {RETRIEVAL_SCOPE_OPTIONS.map((option, index) => (
              <span
                key={option.value}
                className={cn(
                  index === RETRIEVAL_SCOPE_OPTIONS.length - 1 && "text-right",
                )}
              >
                {option.label}
              </span>
            ))}
          </div>
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
        {!library_scope_enabled ? (
          <PopoverDescription id={`${control_id}-retrieval-scope-unavailable`}>
            启用资料库检索后即可调整检索范围。
          </PopoverDescription>
        ) : null}
        <Separator />
        <Field className="gap-2">
          <div className="flex items-center justify-between gap-2">
            <FieldLabel htmlFor={`${control_id}-permission-mode`}>
              权限控制
            </FieldLabel>
            <span className="text-sm text-primary" aria-live="polite">
              {selected_permission_option.label}
            </span>
          </div>
          <Slider
            id={`${control_id}-permission-mode`}
            min={0}
            max={PERMISSION_MODE_OPTIONS.length - 1}
            step={1}
            variant="strength"
            value={[selected_permission_index]}
            onValueChange={([next_index]) => {
              const next_option = PERMISSION_MODE_OPTIONS[next_index];
              if (next_option) on_permission_mode_change?.(next_option.value);
            }}
            disabled={!on_permission_mode_change || permission_mode_saving}
            aria-label="权限控制"
            aria-valuetext={selected_permission_option.label}
            aria-describedby={`${control_id}-permission-mode-description`}
          />
          <div
            className="grid grid-cols-3 text-xs text-muted-foreground"
            aria-hidden="true"
          >
            {PERMISSION_MODE_OPTIONS.map((option, index) => (
              <span
                key={option.value}
                className={cn(
                  index === 1 && "text-center",
                  index === PERMISSION_MODE_OPTIONS.length - 1 && "text-right",
                )}
              >
                {option.label}
              </span>
            ))}
          </div>
          <FieldDescription
            id={`${control_id}-permission-mode-description`}
            className={cn(
              permission_mode === "full_access" && "text-destructive",
            )}
          >
            {selected_permission_option.description}
          </FieldDescription>
        </Field>
        {permission_mode_error ? (
          <PopoverDescription className="text-destructive" role="alert">
            {permission_mode_error}
          </PopoverDescription>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function find_permission_mode_option(permission_mode: AgentPermissionMode) {
  return (
    PERMISSION_MODE_OPTIONS.find(
      (option) => option.value === permission_mode,
    ) ?? PERMISSION_MODE_OPTIONS[1]
  );
}

function ModelThinkingControl({
  control_id,
  models,
  model_id,
  on_model_change,
  thinking_mode,
  on_thinking_mode_change,
  thinking_modes_enabled,
}: {
  control_id: string;
  models: AiModelSummary[];
  model_id: string | null;
  on_model_change: (model_id: string | null) => void;
  thinking_mode: AgentThinkingMode;
  on_thinking_mode_change: (mode: AgentThinkingMode) => void;
  thinking_modes_enabled: boolean;
}) {
  const selected_index = THINKING_MODE_OPTIONS.findIndex(
    (option) => option.value === thinking_mode,
  );
  const selected_option = THINKING_MODE_OPTIONS[selected_index];
  const selected_model_name =
    models.find((model) => model.model_id === model_id)?.name ?? "没有可用模型";
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="max-w-40 rounded-full"
          aria-label={`模型与思考强度：${selected_model_name}，${selected_option.label}`}
        >
          <Zap data-icon="inline-start" />
          <span className="truncate">{selected_model_name}</span>
          <span className="shrink-0 text-muted-foreground">
            {selected_option.label}
          </span>
          <ChevronDown data-icon="inline-end" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        className="w-72 gap-4 rounded-3xl p-4"
        aria-label="模型与思考强度"
      >
        <PopoverHeader>
          <PopoverTitle className="sr-only">模型与思考强度</PopoverTitle>
        </PopoverHeader>
        <AiModelSelect
          id={`${control_id}-execution-model`}
          label="执行模型"
          models={models}
          value={model_id}
          on_change={on_model_change}
        />
        <Separator />
        <Field className="gap-2">
          <div className="flex items-center justify-between gap-2">
            <FieldLabel id={`${control_id}-thinking-mode`}>思考强度</FieldLabel>
            <span className="text-sm text-primary" aria-live="polite">
              {selected_option.label}
            </span>
          </div>
          <Slider
            min={0}
            max={THINKING_MODE_OPTIONS.length - 1}
            step={1}
            variant="strength"
            value={[selected_index]}
            onValueChange={([next_index]) => {
              const next_option = THINKING_MODE_OPTIONS[next_index];
              if (next_option) on_thinking_mode_change(next_option.value);
            }}
            disabled={!thinking_modes_enabled}
            aria-label="思考强度"
            aria-valuetext={selected_option.label}
            aria-describedby={
              thinking_modes_enabled
                ? undefined
                : `${control_id}-thinking-mode-unavailable`
            }
          />
          <div
            className="grid grid-cols-3 text-xs text-muted-foreground"
            aria-hidden="true"
          >
            {THINKING_MODE_OPTIONS.map((option, index) => (
              <span
                key={option.value}
                className={cn(
                  index === 1 && "text-center",
                  index === THINKING_MODE_OPTIONS.length - 1 && "text-right",
                )}
              >
                {option.label}
              </span>
            ))}
          </div>
        </Field>
        {!thinking_modes_enabled ? (
          <PopoverDescription id={`${control_id}-thinking-mode-unavailable`}>
            模型角色路由尚未接通，仅支持自动模式。
          </PopoverDescription>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
