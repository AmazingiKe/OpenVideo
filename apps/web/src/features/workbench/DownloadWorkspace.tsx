import { type FormEvent, useEffect, useState } from "react";
import {
  CheckCircle2,
  CircleAlert,
  Download,
  Link2,
  ListChecks,
  Search,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { DownloadActivity } from "@/features/downloads/DownloadActivity";
import { DownloadSelection } from "@/features/downloads/DownloadSelection";
import type { HealthResponse, ProbeResponse } from "@/shared/types";
import type { TaskRecord } from "@/features/workbench/tasks";

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
