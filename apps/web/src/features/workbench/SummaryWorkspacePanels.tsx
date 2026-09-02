import { Component, lazy, Suspense, type ReactNode } from "react";
import {
  CircleX,
  Code2,
  Download,
  Eye,
  FileText,
  Save,
  type LucideIcon,
} from "lucide-react";

import type { MarkdownSelection } from "@/components/MarkdownEditor";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { SummaryDocument } from "@/shared/types";

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

export type SaveStatus =
  | "saved"
  | "pending"
  | "saving"
  | "local_only"
  | "failed"
  | "recovered"
  | "confirmed";

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
    pending: "待同步",
    saving: "保存中",
    local_only: "已保存在本机，暂未同步",
    failed: "保存失败",
    recovered: "已恢复未保存内容",
    confirmed: "系统已保存",
  };
  if (status === "failed") {
    return (
      <div className="flex items-center gap-1" role="status">
        <span className="text-sm text-destructive">保存失败，正在重试</span>
        <Button type="button" variant="ghost" size="sm" onClick={on_retry}>
          立即重试
        </Button>
      </div>
    );
  }
  if (status === "saved" || status === "pending") return null;
  return (
    <Badge variant="secondary" role="status">
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

export function SummaryEmpty({
  title,
  description,
  icon: Icon = FileText,
  action,
}: {
  title: string;
  description: string;
  icon?: LucideIcon;
  action?: ReactNode;
}) {
  return (
    <div className="flex h-full items-center justify-center p-4">
      <Empty className="max-w-md border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Icon aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription>{description}</EmptyDescription>
        </EmptyHeader>
        {action}
      </Empty>
    </div>
  );
}
