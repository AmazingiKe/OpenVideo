import { Download, FileClock, ServerCog, TerminalSquare } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
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
import { Progress } from "@/components/ui/progress";
import { TASK_STAGE_LABELS, type TaskRecord } from "@/features/workbench/tasks";

export function DownloadActivity({ tasks }: { tasks: TaskRecord[] }) {
  const log_entries = tasks
    .flatMap((task) => task.events.map((event) => ({ task, event })))
    .sort(
      (left, right) =>
        Date.parse(right.event.created_at) - Date.parse(left.event.created_at),
    );
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
        <ActivityCard
          icon={FileClock}
          title="任务队列"
          description="当前与最近完成的下载任务。"
        >
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
        </ActivityCard>
        <ActivityCard
          icon={TerminalSquare}
          title="运行日志"
          description="处理阶段、提示与错误信息。"
        >
          {log_entries.length === 0 ? (
            <DownloadEmpty
              icon={ServerCog}
              title="暂无运行记录"
              description="任务开始后，这里会同步显示处理阶段。"
            />
          ) : (
            <ul className="overflow-hidden rounded-lg border">
              {log_entries.map(({ task, event }) => (
                <li
                  key={event.event_id}
                  className="flex flex-col gap-1 border-b px-3 py-2.5 last:border-b-0"
                >
                  <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                    <span
                      className="line-clamp-2 text-xs font-medium sm:truncate"
                      title={task.name}
                    >
                      {task.name}
                    </span>
                    <time
                      className="text-xs text-muted-foreground tabular-nums sm:shrink-0"
                      dateTime={event.created_at}
                    >
                      {format_task_created_at(event.created_at)}
                    </time>
                  </div>
                  <div className="grid gap-1 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-3">
                    <span className="text-xs font-medium">
                      {TASK_STAGE_LABELS[event.stage] ?? event.stage}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {event.error_message ?? event.message}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </ActivityCard>
      </div>
    </section>
  );
}

function ActivityCard({
  icon: ActivityIcon,
  title,
  description,
  children,
}: {
  icon: typeof Download;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <div className="flex items-center gap-2">
          <ActivityIcon
            className="size-4 text-muted-foreground"
            aria-hidden="true"
          />
          <CardTitle role="heading" aria-level={3}>
            {title}
          </CardTitle>
        </div>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
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
  return (
    <li className="flex flex-col gap-2 rounded-lg border bg-muted/20 p-3">
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2">
        <Badge variant={task.stage === "failed" ? "destructive" : "secondary"}>
          {stage_label}
        </Badge>
        <span className="truncate text-sm font-medium" title={task.name}>
          {task.name}
        </span>
        <span className="text-xs font-medium tabular-nums">
          {progress.toFixed(0)}%
        </span>
      </div>
      <Progress
        value={progress}
        aria-label={`${stage_label} ${progress.toFixed(0)}%`}
      />
      <div className="flex items-center justify-between gap-3">
        <span className="truncate text-xs text-muted-foreground">
          {task.message}
        </span>
        <time
          className="shrink-0 text-xs text-muted-foreground tabular-nums"
          dateTime={task.created_at}
        >
          {format_task_created_at(task.created_at)}
        </time>
      </div>
      {task.error_message ? (
        <p className="text-xs text-destructive" role="alert">
          {task.error_message}
        </p>
      ) : null}
    </li>
  );
}

function format_task_created_at(created_at: string): string {
  const created_date = new Date(created_at);
  const date = [
    created_date.getFullYear(),
    pad_time_component(created_date.getMonth() + 1),
    pad_time_component(created_date.getDate()),
  ].join("-");
  const time = [
    pad_time_component(created_date.getHours()),
    pad_time_component(created_date.getMinutes()),
    pad_time_component(created_date.getSeconds()),
  ].join(":");
  return `${date} ${time}`;
}

function pad_time_component(value: number): string {
  return value.toString().padStart(2, "0");
}
