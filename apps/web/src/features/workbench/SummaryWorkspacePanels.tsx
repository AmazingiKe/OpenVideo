import { Component, lazy, Suspense, type ReactNode } from "react";
import { CircleX, Code2, Download, Eye, FileText, Save } from "lucide-react";

import { AiModelSelect } from "@/components/AiModelSelect";
import type { MarkdownSelection } from "@/components/MarkdownEditor";
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
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type {
  AiModelSummary,
  MediaAsset,
  SummaryDetail,
  SummaryDocument,
  SummaryPreset,
  Transcript,
} from "@/shared/types";

const MarkdownEditor = lazy(() =>
  import("@/components/MarkdownEditor").then((module) => ({
    default: module.MarkdownEditor,
  })),
);

const MarkdownSourceEditor = lazy(() =>
  import("@/components/MarkdownSourceEditor").then((module) => ({
    default: module.MarkdownSourceEditor,
  })),
);

export type SaveStatus = "saved" | "pending" | "saving" | "failed" | "conflict";

export type DocumentConflict = {
  local_markdown: string;
  local_title: string;
  remote_document: SummaryDocument;
};

export function SummaryGeneration({
  asset,
  transcript,
  models,
  presets,
  model_id,
  on_model_change,
  detail,
  on_detail_change,
  preset_id,
  on_preset_change,
  user_input,
  on_user_input_change,
  output_language,
  on_output_language_change,
  is_generating,
  on_generate,
  compact = false,
}: {
  asset: MediaAsset;
  transcript: Transcript | null;
  models: AiModelSummary[];
  presets: SummaryPreset[];
  model_id: string | null;
  on_model_change: (model_id: string | null) => void;
  detail: SummaryDetail;
  on_detail_change: (detail: SummaryDetail) => void;
  preset_id: string;
  on_preset_change: (preset_id: string) => void;
  user_input: string;
  on_user_input_change: (user_input: string) => void;
  output_language: string;
  on_output_language_change: (language: string) => void;
  is_generating: boolean;
  on_generate: () => void;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "mx-auto flex w-full max-w-3xl items-center",
        compact ? "" : "h-full px-4 py-8",
      )}
    >
      <Card className="w-full">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText aria-hidden="true" /> 生成 Markdown 总结
          </CardTitle>
          <CardDescription>
            为“{asset.title}
            ”创建一份可持续编辑的知识文档。总结只会在你点击生成后开始。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <AiModelSelect
              id="summary-generation-model"
              label="AI 模型"
              models={models}
              value={model_id}
              on_change={on_model_change}
              disabled={is_generating}
              description="总结始终使用完整上下文，不会检索或静默截断。"
            />
            <Field>
              <FieldLabel htmlFor="summary_preset">角色预设</FieldLabel>
              <Select value={preset_id} onValueChange={on_preset_change}>
                <SelectTrigger id="summary_preset" className="w-full">
                  <SelectValue placeholder="选择总结角色" />
                </SelectTrigger>
                <SelectContent>
                  {presets.map((preset) => (
                    <SelectItem key={preset.preset_id} value={preset.preset_id}>
                      {preset.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>
                {presets.find((preset) => preset.preset_id === preset_id)
                  ?.description ?? "角色决定文档组织方式。"}
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="summary_detail">文档详细度</FieldLabel>
              <Select
                value={detail}
                onValueChange={(value) =>
                  on_detail_change(value as SummaryDetail)
                }
              >
                <SelectTrigger id="summary_detail" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="concise">精简</SelectItem>
                    <SelectItem value="standard">标准</SelectItem>
                    <SelectItem value="detailed">详细</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="summary_language">输出语言</FieldLabel>
              <Select
                value={output_language}
                onValueChange={on_output_language_change}
              >
                <SelectTrigger id="summary_language" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="zh-CN">简体中文</SelectItem>
                  <SelectItem value="en">English</SelectItem>
                  <SelectItem value="ja">日本語</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="summary_user_input">本次补充要求</FieldLabel>
              <Textarea
                id="summary_user_input"
                value={user_input}
                onChange={(event) => on_user_input_change(event.target.value)}
                placeholder="例如：保留术语原文，并在每章末尾列出复习问题"
                disabled={is_generating}
              />
            </Field>
          </FieldGroup>
          <div className="mt-6 flex flex-wrap gap-2" aria-label="可用分析内容">
            <Badge variant="secondary">
              转写 {transcript?.segments.length ?? 0} 段
            </Badge>
            <Badge variant="secondary">正式标记与有效事件分析</Badge>
          </div>
        </CardContent>
        <CardFooter>
          <Button
            onClick={on_generate}
            disabled={!transcript || !model_id || !preset_id || is_generating}
          >
            {is_generating ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <FileText data-icon="inline-start" />
            )}
            {is_generating ? "正在生成…" : "生成主文档"}
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}

export function DocumentEditor({
  document,
  title,
  markdown,
  mode,
  save_status,
  on_title_change,
  on_markdown_change,
  on_mode_change,
  on_selection_change,
  on_retry,
  compact_actions,
  context_action,
  export_pending,
  export_relative_path,
  on_export,
  target_heading_id,
  on_active_heading_change,
  on_target_heading_reached,
}: {
  document: SummaryDocument;
  title: string;
  markdown: string;
  mode: "visual" | "source";
  save_status: SaveStatus;
  on_title_change: (title: string) => void;
  on_markdown_change: (markdown: string) => void;
  on_mode_change: (mode: "visual" | "source") => void;
  on_selection_change: (selection: MarkdownSelection | null) => void;
  on_retry: () => void;
  compact_actions: ReactNode;
  context_action?: ReactNode;
  export_pending: boolean;
  export_relative_path: string | null;
  on_export: () => void;
  target_heading_id: string | null;
  on_active_heading_change: (heading_id: string | null) => void;
  on_target_heading_reached: () => void;
}) {
  return (
    <Tabs
      value={mode}
      onValueChange={(value) => on_mode_change(value as "visual" | "source")}
      className="h-full min-h-0 gap-0 bg-background"
      aria-label="文档编辑器"
    >
      <header className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        {compact_actions}
        <Input
          value={title}
          onChange={(event) => on_title_change(event.target.value)}
          aria-label="文档标题"
          className="min-w-40 flex-1 border-transparent bg-transparent font-medium shadow-none focus-visible:border-input"
        />
        <SaveState status={save_status} on_retry={on_retry} />
        {context_action}
        <TabsList aria-label="编辑模式">
          <TabsTrigger value="visual" aria-label="预览模式" title="预览模式">
            <Eye />
          </TabsTrigger>
          <TabsTrigger value="source" aria-label="源码模式" title="源码模式">
            <Code2 />
          </TabsTrigger>
        </TabsList>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={export_pending}
          onClick={on_export}
        >
          {export_pending ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <Download data-icon="inline-start" />
          )}
          {export_pending ? "导出中" : "导出 ZIP"}
        </Button>
        {export_relative_path ? (
          <span
            className="max-w-72 truncate text-xs text-muted-foreground"
            role="status"
            title={export_relative_path}
          >
            已保存：{export_relative_path}
          </span>
        ) : null}
      </header>
      <TabsContent value="visual" className="flex min-h-0 overflow-hidden">
        <MarkdownEditorErrorBoundary
          document_id={document.document_id}
          on_use_source={() => on_mode_change("source")}
        >
          <Suspense
            fallback={
              <div
                className="flex h-full min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground"
                role="status"
              >
                <Spinner />
                正在加载编辑器…
              </div>
            }
          >
            <MarkdownEditor
              document_key={document.document_id}
              markdown={markdown}
              on_change={on_markdown_change}
              on_selection_change={on_selection_change}
              target_heading_id={target_heading_id}
              on_active_heading_change={on_active_heading_change}
              on_target_heading_reached={on_target_heading_reached}
            />
          </Suspense>
        </MarkdownEditorErrorBoundary>
      </TabsContent>
      <TabsContent value="source" className="flex min-h-0 overflow-hidden">
        <Suspense
          fallback={
            <div
              className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"
              role="status"
            >
              <Spinner /> 正在加载源码编辑器…
            </div>
          }
        >
          <MarkdownSourceEditor
            markdown={markdown}
            on_change={on_markdown_change}
            on_selection_change={on_selection_change}
          />
        </Suspense>
      </TabsContent>
    </Tabs>
  );
}

function SaveState({
  status,
  on_retry,
}: {
  status: SaveStatus;
  on_retry: () => void;
}) {
  const labels: Record<SaveStatus, string> = {
    saved: "已保存",
    pending: "等待保存",
    saving: "保存中",
    failed: "保存失败",
    conflict: "版本冲突",
  };
  if (status === "failed") {
    return (
      <Button type="button" variant="ghost" size="sm" onClick={on_retry}>
        重试保存
      </Button>
    );
  }
  return (
    <Badge
      variant={status === "conflict" ? "destructive" : "secondary"}
      role="status"
    >
      {status === "saving" ? (
        <Spinner data-icon="inline-start" />
      ) : (
        <Save data-icon="inline-start" />
      )}
      {labels[status]}
    </Badge>
  );
}

type MarkdownEditorErrorBoundaryProps = {
  document_id: string;
  on_use_source: () => void;
  children: ReactNode;
};

type MarkdownEditorErrorBoundaryState = {
  failed: boolean;
};

class MarkdownEditorErrorBoundary extends Component<
  MarkdownEditorErrorBoundaryProps,
  MarkdownEditorErrorBoundaryState
> {
  state: MarkdownEditorErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): MarkdownEditorErrorBoundaryState {
    return { failed: true };
  }

  componentDidUpdate(previous: MarkdownEditorErrorBoundaryProps) {
    if (this.state.failed && previous.document_id !== this.props.document_id) {
      this.setState({ failed: false });
    }
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="p-4">
        <Alert variant="destructive">
          <CircleX aria-hidden="true" />
          <AlertTitle>可视化编辑器未能打开</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-3">
            <span>文档内容仍然安全，可切换到源码模式继续查看和编辑。</span>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={this.props.on_use_source}
              >
                <Code2 data-icon="inline-start" /> 使用源码模式
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => this.setState({ failed: false })}
              >
                重试可视化编辑器
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      </div>
    );
  }
}

export function NewDocumentDialog({
  open,
  on_open_change,
  title,
  on_title_change,
  on_create,
}: {
  open: boolean;
  on_open_change: (open: boolean) => void;
  title: string;
  on_title_change: (title: string) => void;
  on_create: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={on_open_change}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建子文档</DialogTitle>
          <DialogDescription>
            文档最多支持三级，文件路径由文档 ID 固定生成。
          </DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel htmlFor="new_summary_document_title">标题</FieldLabel>
          <Input
            id="new_summary_document_title"
            value={title}
            onChange={(event) => on_title_change(event.target.value)}
            autoFocus
          />
        </Field>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">取消</Button>
          </DialogClose>
          <Button onClick={on_create} disabled={!title.trim()}>
            创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DeleteDocumentDialog({
  document,
  on_open_change,
  on_confirm,
}: {
  document: SummaryDocument | null;
  on_open_change: (open: boolean) => void;
  on_confirm: () => void;
}) {
  return (
    <Dialog open={document !== null} onOpenChange={on_open_change}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>删除子文档</DialogTitle>
          <DialogDescription>
            “{document?.title}
            ”及其子文档将从当前总结项目中删除，此操作不可撤销。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">取消</Button>
          </DialogClose>
          <Button variant="destructive" onClick={on_confirm}>
            删除
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DocumentConflictDialog({
  conflict,
  on_keep_local,
  on_use_remote,
}: {
  conflict: DocumentConflict | null;
  on_keep_local: () => void;
  on_use_remote: () => void;
}) {
  return (
    <Dialog open={conflict !== null}>
      <DialogContent
        className="max-h-[min(88vh,48rem)] sm:max-w-5xl"
        showCloseButton={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>选择要保留的文档版本</DialogTitle>
          <DialogDescription>
            保存期间检测到其他修改。本地草稿仍在当前窗口中，请对比后选择。
          </DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 gap-3 md:grid-cols-2">
          <ConflictVersion
            label="本地草稿"
            title={conflict?.local_title ?? ""}
            markdown={conflict?.local_markdown ?? ""}
          />
          <ConflictVersion
            label="已保存版本"
            title={conflict?.remote_document.title ?? ""}
            markdown={conflict?.remote_document.markdown ?? ""}
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={on_use_remote}>
            使用已保存版本
          </Button>
          <Button type="button" onClick={on_keep_local}>
            保留本地草稿并覆盖
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConflictVersion({
  label,
  markdown,
  title,
}: {
  label: string;
  markdown: string;
  title: string;
}) {
  return (
    <section className="flex min-h-48 flex-col overflow-hidden rounded-lg border bg-muted/30">
      <header className="border-b px-3 py-2">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <p className="truncate text-sm font-semibold">{title}</p>
      </header>
      <pre className="min-h-0 flex-1 overflow-auto p-3 font-mono text-xs leading-5 break-words whitespace-pre-wrap">
        {markdown || "（空文档）"}
      </pre>
    </section>
  );
}

export function SummaryEmpty({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="flex h-full items-center justify-center p-4">
      <Empty className="max-w-md border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FileText />
          </EmptyMedia>
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription>{description}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  );
}
