import {
  AudioLines,
  Bot,
  Database,
  Download,
  ListTodo,
  RotateCcw,
  Pause,
  Play,
  Search,
  Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { TASK_CENTER_TRIGGER_ID } from "@/components/TaskSubmissionFeedback";
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

const TERMINAL_TASK_STAGES = new Set([
  "complete",
  "failed",
  "cancelled",
  "interrupted",
  "paused",
]);
export const TASK_CENTER_CONTENT_ID = "task_center_content";

type TaskCenterProps = {
  tasks: TaskRecord[];
  on_retry: (run_id: string) => Promise<void>;
  open?: boolean;
  on_open_change?: (open: boolean) => void;
  on_pause?: (task_id: string) => Promise<void>;
  on_delete?: (task_id: string) => Promise<void>;
  on_view_result?: (task_id: string) => void;
};

const TASK_TYPES = {
  probe: { label: "解析", icon: Search },
  download: { label: "下载", icon: Download },
  transcription: { label: "转录", icon: AudioLines },
  agent: { label: "助手", icon: Bot },
  index: { label: "索引", icon: Database },
} as const;

export function TaskCenter({
  tasks,
  on_retry,
  open,
  on_open_change,
  on_pause,
  on_delete,
  on_view_result,
}: TaskCenterProps) {
  const [pending_task_ids, set_pending_task_ids] = useState(new Set<string>());
  const [action_error, set_action_error] = useState<string | null>(null);
  const visible_tasks = useMemo(
    () =>
      [...tasks].sort(
        (left, right) =>
          Number(TERMINAL_TASK_STAGES.has(left.stage)) -
          Number(TERMINAL_TASK_STAGES.has(right.stage)),
      ),
    [tasks],
  );
  const active_task_count = tasks.filter(
    (task) => !TERMINAL_TASK_STAGES.has(task.stage),
  ).length;

  async function run_task_action(
    task_id: string,
    action: (task_id: string) => Promise<void>,
  ) {
    set_pending_task_ids((current) => new Set(current).add(task_id));
    set_action_error(null);
    try {
      await action(task_id);
    } catch (error) {
      set_action_error(
        error instanceof Error ? error.message : "任务操作失败，请稍后再试",
      );
    } finally {
      set_pending_task_ids((current) => {
        const next = new Set(current);
        next.delete(task_id);
        return next;
      });
    }
  }

  return (
    <Popover open={open} onOpenChange={on_open_change}>
      <PopoverTrigger asChild>
        <Button
          id={TASK_CENTER_TRIGGER_ID}
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
        id={TASK_CENTER_CONTENT_ID}
        align="end"
        aria-label="任务中心"
        onFocusOutside={(event) => {
          // 下载弹窗退出时会恢复焦点，任务面板只随外部点击或 Escape 收起。
          event.preventDefault();
        }}
        className="flex max-h-[var(--radix-popover-content-available-height)] w-80 max-w-[var(--radix-popover-content-available-width)] flex-col overflow-hidden"
      >
        <PopoverHeader className="shrink-0 px-1">
          <PopoverTitle>任务中心</PopoverTitle>
          <PopoverDescription>
            下载、转录与助手任务会在离开页面后继续运行。
          </PopoverDescription>
        </PopoverHeader>
        {action_error ? (
          <p
            className="rounded-lg bg-error-surface px-2 py-1.5 text-xs text-destructive"
            role="alert"
          >
            {action_error}
          </p>
        ) : null}
        {visible_tasks.length === 0 ? (
          <p className="rounded-lg bg-surface-subtle px-3 py-6 text-center text-sm text-muted-foreground">
            暂无任务
          </p>
        ) : (
          <ol
            className="max-h-96 min-h-0 space-y-1 overflow-y-auto overscroll-contain"
            aria-live="polite"
          >
            {visible_tasks.map((task) => (
              <TaskCenterItem
                key={task.task_id}
                task={task}
                is_pending={pending_task_ids.has(task.task_id)}
                on_retry={(task_id) => run_task_action(task_id, on_retry)}
                on_pause={
                  on_pause
                    ? (task_id) => run_task_action(task_id, on_pause)
                    : undefined
                }
                on_delete={
                  on_delete
                    ? (task_id) => run_task_action(task_id, on_delete)
                    : undefined
                }
                on_view_result={on_view_result}
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
  is_pending,
  on_retry,
  on_pause,
  on_delete,
  on_view_result,
}: {
  task: TaskRecord;
  is_pending: boolean;
  on_retry: (run_id: string) => Promise<void>;
  on_pause?: TaskCenterProps["on_pause"];
  on_delete?: TaskCenterProps["on_delete"];
  on_view_result?: TaskCenterProps["on_view_result"];
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
          <div className="flex flex-wrap gap-2">
            {task.retry_available ? (
              <Button
                type="button"
                variant="outline"
                size="xs"
                disabled={is_pending}
                onClick={() => void on_retry(task.task_id)}
              >
                {task.stage === "paused" ? (
                  <Play aria-hidden="true" />
                ) : (
                  <RotateCcw aria-hidden="true" />
                )}
                {is_pending
                  ? "处理中"
                  : task.stage === "paused"
                    ? "继续下载"
                    : task.task_type === "agent"
                      ? "从头重试"
                      : task.stage === "interrupted"
                        ? "重新连接"
                        : "重新开始"}
              </Button>
            ) : null}
            {task.pause_available && on_pause ? (
              <Button
                type="button"
                variant="outline"
                size="xs"
                disabled={is_pending}
                onClick={() => void on_pause(task.task_id)}
              >
                <Pause aria-hidden="true" />
                暂停下载
              </Button>
            ) : null}
            {task.result_available && on_view_result ? (
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => on_view_result(task.task_id)}
              >
                <Download aria-hidden="true" />
                选择视频
              </Button>
            ) : null}
            {task.delete_available && on_delete ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={is_pending}
                onClick={() => void on_delete(task.task_id)}
              >
                <Trash2 aria-hidden="true" />
                删除任务
              </Button>
            ) : null}
          </div>
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
  if (stage === "cancelled" || stage === "interrupted" || stage === "paused")
    return "outline";
  return "default";
}
