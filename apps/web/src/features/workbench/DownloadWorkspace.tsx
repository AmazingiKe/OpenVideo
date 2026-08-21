import { type FormEvent, useEffect, useState } from "react";
import {
  CheckCircle2,
  CircleAlert,
  Download,
  FileClock,
  Link2,
  ListChecks,
  ListVideo,
  Search,
  ServerCog,
  TerminalSquare,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";

import { format_duration } from "../../shared/format";
import type { HealthResponse, ProbeResponse } from "../../shared/types";
import { TASK_STAGE_LABELS, type TaskRecord } from "./tasks";

type DownloadWorkspaceProps = {
  health: HealthResponse | null;
  task_records: TaskRecord[];
  source_url: string;
  probe_result: ProbeResponse | null;
  selected_urls: Set<string>;
  current_source_video_id: string | null;
  is_submitting: boolean;
  error: string | null;
  on_source_url_change: (value: string) => void;
  on_submit_probe: (event: FormEvent<HTMLFormElement>) => void;
  on_toggle_url: (url: string) => void;
  on_replace_selection: (urls: string[]) => void;
  on_start_download: () => void;
};

const SUPPORTED_PLATFORMS = ["Bilibili", "抖音", "YouTube"];

export function DownloadWorkspace({
  health,
  task_records,
  source_url,
  probe_result,
  selected_urls,
  current_source_video_id,
  is_submitting,
  error,
  on_source_url_change,
  on_submit_probe,
  on_toggle_url,
  on_replace_selection,
  on_start_download,
}: DownloadWorkspaceProps) {
  const download_tasks = task_records.filter(
    (task) => task.task_type === "download",
  );
  const dependencies_ready = Boolean(
    health?.dependencies.yt_dlp && health.dependencies.ffmpeg,
  );
  const [entry_filter, set_entry_filter] = useState("");

  useEffect(() => set_entry_filter(""), [probe_result]);

  const normalized_filter = entry_filter.trim().toLocaleLowerCase();
  const visible_entries =
    probe_result?.entries.filter(
      (entry) =>
        !normalized_filter ||
        (entry.title ?? entry.source_video_id)
          .toLocaleLowerCase()
          .includes(normalized_filter),
    ) ?? [];
  const current_entry =
    probe_result?.entries.find(
      (entry) => entry.source_video_id === current_source_video_id,
    ) ?? null;

  return (
    <section
      className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 py-8 md:px-8 md:py-10"
      aria-labelledby="download_workspace_title"
    >
      <DownloadHeader health={health} dependencies_ready={dependencies_ready} />

      <Card className="border-primary/20 bg-card/90 shadow-xl shadow-black/10">
        <CardHeader className="border-b">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Link2 aria-hidden="true" />
            </div>
            <div>
              <CardTitle role="heading" aria-level={2}>
                添加视频链接
              </CardTitle>
              <CardDescription>
                粘贴单个视频或播放列表地址，我们会先读取可下载内容。
              </CardDescription>
            </div>
          </div>
          <CardAction>
            <Badge variant="secondary">步骤 1</Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <form onSubmit={on_submit_probe}>
            <FieldGroup>
              <Field data-disabled={is_submitting || !dependencies_ready}>
                <FieldLabel htmlFor="source_url">视频或播放列表地址</FieldLabel>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <div className="relative min-w-0 flex-1">
                    <Link2
                      className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <Input
                      id="source_url"
                      className="h-10 pl-9"
                      type="url"
                      value={source_url}
                      onChange={(event) =>
                        on_source_url_change(event.target.value)
                      }
                      placeholder="https://www.bilibili.com/video/..."
                      disabled={is_submitting}
                      aria-invalid={Boolean(error)}
                    />
                  </div>
                  <Button
                    className="h-10 px-5"
                    type="submit"
                    disabled={is_submitting || !dependencies_ready}
                  >
                    {is_submitting ? (
                      <Spinner data-icon="inline-start" />
                    ) : (
                      <Search data-icon="inline-start" />
                    )}
                    {is_submitting ? "正在检测" : "检测链接"}
                  </Button>
                </div>
                <FieldDescription>
                  支持公开可访问的单集、合集与播放列表链接。
                </FieldDescription>
              </Field>
            </FieldGroup>
            {error ? (
              <Alert className="mt-4" variant="destructive">
                <CircleAlert aria-hidden="true" />
                <AlertTitle>无法处理此链接</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
          </form>

          <div className="flex flex-col gap-4 border-t pt-6 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-6">
            <div>
              <p className="text-sm font-medium">支持的平台</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {SUPPORTED_PLATFORMS.map((platform) => (
                  <Badge key={platform} variant="outline">
                    {platform}
                  </Badge>
                ))}
              </div>
            </div>
            <Separator />
            <ol className="flex flex-col gap-3 text-sm text-muted-foreground">
              <DownloadStep icon={Link2} label="粘贴并检测链接" />
              <DownloadStep icon={ListChecks} label="确认要下载的视频" />
              <DownloadStep icon={Download} label="后台下载并处理" />
            </ol>
          </div>
        </CardContent>
      </Card>

      {probe_result ? (
        <DownloadSelection
          probe_result={probe_result}
          visible_entries={visible_entries}
          selected_urls={selected_urls}
          current_source_video_id={current_source_video_id}
          current_entry_url={current_entry?.url ?? null}
          entry_filter={entry_filter}
          is_submitting={is_submitting}
          on_entry_filter_change={set_entry_filter}
          on_toggle_url={on_toggle_url}
          on_replace_selection={on_replace_selection}
          on_start_download={on_start_download}
        />
      ) : null}

      <DownloadActivity tasks={download_tasks} />
    </section>
  );
}

function DownloadHeader({
  health,
  dependencies_ready,
}: {
  health: HealthResponse | null;
  dependencies_ready: boolean;
}) {
  const status_label = !health
    ? "检查环境中"
    : dependencies_ready
      ? "下载服务正常"
      : "下载服务未就绪";

  return (
    <header className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
      <div className="max-w-2xl">
        <div className="mb-3 flex items-center gap-2 text-sm font-medium text-primary">
          <Download className="size-4" aria-hidden="true" />
          视频下载
        </div>
        <h1
          id="download_workspace_title"
          className="text-2xl font-semibold tracking-tight sm:text-3xl"
        >
          下载在线视频，稍后集中处理
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground sm:text-base">
          解析视频或播放列表，选择内容后加入后台任务队列。
        </p>
      </div>
      <Badge
        className="w-fit"
        variant={dependencies_ready ? "secondary" : "outline"}
      >
        {health ? (
          <CheckCircle2 data-icon="inline-start" />
        ) : (
          <Spinner data-icon="inline-start" />
        )}
        {status_label}
      </Badge>
    </header>
  );
}

function DownloadStep({
  icon: StepIcon,
  label,
}: {
  icon: typeof Link2;
  label: string;
}) {
  return (
    <li className="flex items-center gap-3">
      <span className="flex size-7 items-center justify-center rounded-md bg-muted text-foreground">
        <StepIcon className="size-3.5" aria-hidden="true" />
      </span>
      {label}
    </li>
  );
}

type DownloadSelectionProps = {
  probe_result: ProbeResponse;
  visible_entries: ProbeResponse["entries"];
  selected_urls: Set<string>;
  current_source_video_id: string | null;
  current_entry_url: string | null;
  entry_filter: string;
  is_submitting: boolean;
  on_entry_filter_change: (value: string) => void;
  on_toggle_url: (url: string) => void;
  on_replace_selection: (urls: string[]) => void;
  on_start_download: () => void;
};

function DownloadSelection({
  probe_result,
  visible_entries,
  selected_urls,
  current_source_video_id,
  current_entry_url,
  entry_filter,
  is_submitting,
  on_entry_filter_change,
  on_toggle_url,
  on_replace_selection,
  on_start_download,
}: DownloadSelectionProps) {
  return (
    <Card>
      <CardHeader className="border-b">
        <div className="flex items-start gap-3">
          <div className="flex size-9 items-center justify-center rounded-lg bg-muted text-foreground">
            <ListVideo aria-hidden="true" />
          </div>
          <div>
            <CardTitle role="heading" aria-level={2}>
              {probe_result.title ?? "检测结果"}
            </CardTitle>
            <CardDescription>
              共 {probe_result.entries.length} 个视频，选择后加入下载队列。
            </CardDescription>
          </div>
        </div>
        <CardAction>
          <Badge>{selected_urls.size} 个已选</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col justify-between gap-3 md:flex-row md:items-center">
          <div className="flex flex-wrap gap-2" aria-label="选集操作">
            {current_entry_url ? (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => on_replace_selection([current_entry_url])}
                disabled={is_submitting}
              >
                <CheckCircle2 data-icon="inline-start" />
                当前视频
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() =>
                on_replace_selection(
                  probe_result.entries.map((entry) => entry.url),
                )
              }
              disabled={is_submitting}
            >
              全选
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => on_replace_selection([])}
              disabled={is_submitting || selected_urls.size === 0}
            >
              清空
            </Button>
          </div>
          <div className="relative w-full md:w-64">
            <Search
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              className="pl-9"
              type="search"
              value={entry_filter}
              onChange={(event) => on_entry_filter_change(event.target.value)}
              placeholder="筛选标题"
              aria-label="筛选视频标题"
              disabled={is_submitting}
            />
          </div>
        </div>

        <ul
          className="max-h-96 overflow-auto rounded-lg border"
          aria-label="可下载视频列表"
        >
          {visible_entries.map((entry) => {
            const entry_number = probe_result.entries.indexOf(entry) + 1;
            const is_current =
              entry.source_video_id === current_source_video_id;
            const checkbox_id = `download_entry_${entry.source_video_id}`;

            return (
              <li
                key={entry.source_video_id}
                className="border-b last:border-b-0 has-data-checked:bg-primary/5"
              >
                <label
                  className="grid min-h-14 cursor-pointer grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2 transition-colors hover:bg-muted/50"
                  htmlFor={checkbox_id}
                >
                  <Checkbox
                    id={checkbox_id}
                    checked={selected_urls.has(entry.url)}
                    onCheckedChange={() => on_toggle_url(entry.url)}
                    disabled={is_submitting}
                  />
                  <span className="font-mono text-xs text-muted-foreground">
                    {String(entry_number).padStart(2, "0")}
                  </span>
                  <span className="flex min-w-0 items-center gap-2">
                    <strong className="truncate text-sm font-medium">
                      {entry.title ?? entry.source_video_id}
                    </strong>
                    {is_current ? (
                      <Badge className="shrink-0" variant="outline">
                        当前
                      </Badge>
                    ) : null}
                  </span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {format_duration(entry.duration_seconds)}
                  </span>
                </label>
              </li>
            );
          })}
          {visible_entries.length === 0 ? (
            <li>
              <Empty className="min-h-40 border-0">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Search aria-hidden="true" />
                  </EmptyMedia>
                  <EmptyTitle>没有匹配的视频</EmptyTitle>
                  <EmptyDescription>换一个关键词试试。</EmptyDescription>
                </EmptyHeader>
              </Empty>
            </li>
          ) : null}
        </ul>
      </CardContent>
      <CardFooter className="justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          下载将在后台继续，可随时切换到其他工作区。
        </p>
        <Button
          className="shrink-0"
          type="button"
          onClick={on_start_download}
          disabled={is_submitting || selected_urls.size === 0}
        >
          <Download data-icon="inline-start" />
          下载 {selected_urls.size} 个视频
        </Button>
      </CardFooter>
    </Card>
  );
}

function DownloadActivity({ tasks }: { tasks: TaskRecord[] }) {
  return (
    <section className="flex flex-col gap-4" aria-labelledby="activity_title">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 id="activity_title" className="text-lg font-semibold">
            下载活动
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            查看后台任务的实时进度与处理记录。
          </p>
        </div>
        <Badge variant="outline">{tasks.length} 项任务</Badge>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card size="sm">
          <CardHeader>
            <div className="flex items-center gap-2">
              <FileClock
                className="size-4 text-muted-foreground"
                aria-hidden="true"
              />
              <CardTitle role="heading" aria-level={3}>
                任务队列
              </CardTitle>
            </div>
            <CardDescription>当前与最近完成的下载任务。</CardDescription>
          </CardHeader>
          <CardContent>
            {tasks.length === 0 ? (
              <DownloadEmpty
                icon={Download}
                title="队列还是空的"
                description="检测链接并选择视频后，任务会显示在这里。"
              />
            ) : (
              <ul className="flex flex-col gap-3">
                {tasks.map((task) => (
                  <DownloadTask key={task.task_id} task={task} />
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <div className="flex items-center gap-2">
              <TerminalSquare
                className="size-4 text-muted-foreground"
                aria-hidden="true"
              />
              <CardTitle role="heading" aria-level={3}>
                运行日志
              </CardTitle>
            </div>
            <CardDescription>处理阶段、提示与错误信息。</CardDescription>
          </CardHeader>
          <CardContent>
            {tasks.length === 0 ? (
              <DownloadEmpty
                icon={ServerCog}
                title="暂无运行记录"
                description="任务开始后，这里会同步显示处理阶段。"
              />
            ) : (
              <ul className="overflow-hidden rounded-lg border">
                {tasks.map((task) => (
                  <li
                    key={task.task_id}
                    className="grid gap-1 border-b px-3 py-2.5 last:border-b-0 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-3"
                  >
                    <span className="text-xs font-medium">
                      {TASK_STAGE_LABELS[task.stage] ?? task.stage}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {task.error_message ?? task.message}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

function DownloadEmpty({
  icon: EmptyIcon,
  title,
  description,
}: {
  icon: typeof Download;
  title: string;
  description: string;
}) {
  return (
    <Empty className="min-h-40 border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <EmptyIcon aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function DownloadTask({ task }: { task: TaskRecord }) {
  const progress = Math.min(Math.max(task.progress_percent, 0), 100);
  const stage_label = TASK_STAGE_LABELS[task.stage] ?? task.stage;
  const is_failed = task.stage === "failed";

  return (
    <li className="flex flex-col gap-2 rounded-lg border bg-muted/20 p-3">
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2">
        <Badge variant={is_failed ? "destructive" : "secondary"}>
          {stage_label}
        </Badge>
        <span className="truncate text-xs text-muted-foreground">
          {task.message}
        </span>
        <span className="text-xs font-medium tabular-nums">
          {progress.toFixed(0)}%
        </span>
      </div>
      <Progress
        value={progress}
        aria-label={`${stage_label} ${progress.toFixed(0)}%`}
      />
      {task.error_message ? (
        <p className="text-xs text-destructive" role="alert">
          {task.error_message}
        </p>
      ) : null}
    </li>
  );
}
