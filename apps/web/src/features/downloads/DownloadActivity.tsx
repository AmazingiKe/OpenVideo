import {
  Download,
  FileClock,
  RotateCcw,
  ServerCog,
  TerminalSquare,
} from "lucide-react";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Spinner } from "@/components/ui/spinner";
import { TASK_STAGE_LABELS, type TaskRecord } from "@/features/workbench/tasks";

type DownloadActivityProps = {
  tasks: TaskRecord[];
  retrying_task_id: string | null;
  on_retry: (task_id: string) => void;
};

export function DownloadActivity({
  tasks,
  retrying_task_id,
  on_retry,
}: DownloadActivityProps) {
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
                <DownloadTask
                  key={task.task_id}
                  task={task}
                  is_retrying={retrying_task_id === task.task_id}
                  on_retry={on_retry}
                />
              ))}
            </ul>
          )}
        </ActivityCard>
        <ActivityCard
          icon={TerminalSquare}
          title="运行日志"
          description="每个任务显示最新状态，展开可查看完整步骤。"
        >
          {tasks.length === 0 ? (
            <DownloadEmpty
              icon={ServerCog}
              title="暂无运行记录"
              description="任务开始后，这里会同步显示处理阶段。"
            />
          ) : (
            <Accordion type="multiple">
              {tasks.map((task) => (
                <DownloadLog key={task.task_id} task={task} />
              ))}
            </Accordion>
          )}
        </ActivityCard>
      </div>
    </section>
  );
}

function DownloadLog({ task }: { task: TaskRecord }) {
  const latest_log = latest_task_log(task);
  return (
    <AccordionItem value={task.task_id}>
      <AccordionTrigger>
        <span className="grid min-w-0 flex-1 gap-1">
          <span className="flex min-w-0 items-center justify-between gap-3">
            <span className="truncate text-xs font-medium" title={task.name}>
              {task.name}
            </span>
            <time
              className="shrink-0 text-xs font-normal text-muted-foreground tabular-nums"
              dateTime={latest_log.created_at}
            >
              {format_task_created_at(latest_log.created_at)}
            </time>
          </span>
          <span className="grid min-w-0 gap-1 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-3">
            <span className="text-xs font-medium">
              {TASK_STAGE_LABELS[latest_log.stage] ?? latest_log.stage}
            </span>
            <span className="truncate text-xs font-normal text-muted-foreground">
              {latest_log.error_message ?? latest_log.message}
            </span>
          </span>
        </span>
      </AccordionTrigger>
      <AccordionContent>
        <ol className="flex flex-col gap-2 border-t pt-3">
          {[...task.events].reverse().map((event) => (
            <li
              key={event.event_id}
              className="grid gap-1 sm:grid-cols-[7rem_minmax(0,1fr)_auto] sm:gap-3"
            >
              <span className="text-xs font-medium">
                {TASK_STAGE_LABELS[event.stage] ?? event.stage}
              </span>
              <span className="text-xs text-muted-foreground">
                {event.error_message ?? event.message}
              </span>
              <time
                className="text-xs text-muted-foreground tabular-nums sm:text-right"
                dateTime={event.created_at}
              >
                {format_task_created_at(event.created_at)}
              </time>
            </li>
          ))}
        </ol>
      </AccordionContent>
    </AccordionItem>
  );
}

function latest_task_log(task: TaskRecord) {
  const latest_event = task.events.at(-1);
  return {
    stage: latest_event?.stage ?? task.stage,
    message: latest_event?.message ?? task.message,
    error_message: latest_event?.error_message ?? task.error_message,
    created_at: latest_event?.created_at ?? task.created_at,
  };
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

function DownloadTask({
  task,
  is_retrying,
  on_retry,
}: {
  task: TaskRecord;
  is_retrying: boolean;
  on_retry: (task_id: string) => void;
}) {
  const progress = Math.min(Math.max(task.progress_percent, 0), 100);
  const stage_label = TASK_STAGE_LABELS[task.stage] ?? task.stage;
  const is_failed = task.stage === "failed";
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
      {task.error_message || is_failed ? (
        <div className="flex items-start justify-between gap-3">
          {task.error_message ? (
            <p className="text-xs text-destructive" role="alert">
              {task.error_message}
            </p>
          ) : null}
          {is_failed ? (
            <Button
              className="ml-auto"
              type="button"
              variant="outline"
              size="xs"
              disabled={is_retrying}
              aria-label={`重新下载：${task.name}`}
              onClick={() => on_retry(task.task_id)}
            >
              {is_retrying ? (
                <Spinner data-icon="inline-start" aria-hidden="true" />
              ) : (
                <RotateCcw data-icon="inline-start" aria-hidden="true" />
              )}
              重新下载
            </Button>
          ) : null}
        </div>
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
