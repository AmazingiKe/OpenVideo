import {
  AudioLines,
  Bot,
  Database,
  Download,
  ListTodo,
  RotateCcw,
} from "lucide-react";
import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { TASK_STAGE_LABELS, type TaskRecord } from "@/features/workbench/tasks";

const VISIBLE_TASK_LIMIT = 12;
const TERMINAL_TASK_STAGES = new Set([
  "complete",
  "failed",
  "cancelled",
  "interrupted",
]);

type TaskCenterProps = {
  tasks: TaskRecord[];
  on_resume: (run_id: string) => Promise<void>;
};

const TASK_TYPES = {
  download: { label: "下载", icon: Download },
  transcription: { label: "转录", icon: AudioLines },
  agent: { label: "助手", icon: Bot },
  index: { label: "索引", icon: Database },
} as const;

export function TaskCenter({ tasks, on_resume }: TaskCenterProps) {
  const [resuming_run_id, set_resuming_run_id] = useState<string | null>(null);
  const [resume_error, set_resume_error] = useState<string | null>(null);
  const visible_tasks = useMemo(
    () => tasks.slice(0, VISIBLE_TASK_LIMIT),
    [tasks],
  );
  const active_task_count = tasks.filter(
    (task) => !TERMINAL_TASK_STAGES.has(task.stage),
  ).length;

  async function resume_task(run_id: string) {
    set_resuming_run_id(run_id);
    set_resume_error(null);
    try {
      await on_resume(run_id);
    } catch (error) {
      set_resume_error(
        error instanceof Error ? error.message : "任务恢复失败，请稍后重试",
      );
    } finally {
      set_resuming_run_id(null);
    }
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={
            active_task_count > 0
              ? `任务中心，${active_task_count} 个进行中`
              : "任务中心"
          }
        >
          <ListTodo aria-hidden="true" />
          {active_task_count > 0 ? (
            <Badge
              className="absolute -top-1 -right-1 size-4 p-0 text-xs"
              aria-hidden="true"
            >
              {Math.min(active_task_count, 9)}
              {active_task_count > 9 ? "+" : null}
            </Badge>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-80 max-w-[var(--radix-popover-content-available-width)]"
      >
        <PopoverHeader className="px-1">
          <PopoverTitle>任务中心</PopoverTitle>
          <PopoverDescription>
            下载、转录与助手任务会在离开页面后继续运行。
          </PopoverDescription>
        </PopoverHeader>
        {resume_error ? (
          <p
            className="rounded-lg bg-error-surface px-2 py-1.5 text-xs text-destructive"
            role="alert"
          >
            {resume_error}
          </p>
        ) : null}
        {visible_tasks.length === 0 ? (
          <p className="rounded-lg bg-surface-subtle px-3 py-6 text-center text-sm text-muted-foreground">
            暂无任务
          </p>
        ) : (
          <ol className="max-h-96 space-y-1 overflow-y-auto" aria-live="polite">
            {visible_tasks.map((task) => (
              <TaskCenterItem
                key={task.task_id}
                task={task}
                is_resuming={resuming_run_id === task.task_id}
                on_resume={resume_task}
              />
            ))}
          </ol>
        )}
      </PopoverContent>
    </Popover>
  );
}

function TaskCenterItem({
  task,
  is_resuming,
  on_resume,
}: {
  task: TaskRecord;
  is_resuming: boolean;
  on_resume: (run_id: string) => Promise<void>;
}) {
  const task_type = TASK_TYPES[task.task_type];
  const TaskIcon = task_type.icon;
  const is_terminal = TERMINAL_TASK_STAGES.has(task.stage);
  const stage_label = TASK_STAGE_LABELS[task.stage] ?? task.stage;

  return (
    <li className="rounded-lg border bg-surface-subtle p-2.5">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <TaskIcon className="size-3.5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{task.name}</p>
              <p className="text-xs text-muted-foreground">
                {task_type.label} · {task.message}
              </p>
            </div>
            <Badge variant={stage_badge_variant(task.stage)}>
              {stage_label}
            </Badge>
          </div>
          {!is_terminal && task.progress_known !== false ? (
            <Progress
              value={task.progress_percent}
              aria-label={`${task.name}进度`}
            />
          ) : null}
          {task.error_message ? (
            <p className="text-xs text-destructive">{task.error_message}</p>
          ) : null}
          {task.task_type === "agent" && task.resume_available ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={is_resuming}
              onClick={() => void on_resume(task.task_id)}
            >
              <RotateCcw aria-hidden="true" />
              {is_resuming ? "恢复中" : "继续"}
            </Button>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function stage_badge_variant(
  stage: string,
): "default" | "secondary" | "destructive" | "outline" {
  if (stage === "failed") return "destructive";
  if (stage === "complete") return "secondary";
  if (stage === "cancelled" || stage === "interrupted") return "outline";
  return "default";
}
