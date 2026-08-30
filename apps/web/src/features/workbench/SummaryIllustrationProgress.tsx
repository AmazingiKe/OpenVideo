import {
  Check,
  ChevronDown,
  ImageIcon,
  LoaderCircle,
  Minus,
} from "lucide-react";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import type {
  SummaryIllustrationJob,
  SummaryIllustrationSlot,
} from "@/shared/types";

type SummaryIllustrationProgressProps = {
  job: SummaryIllustrationJob;
  now?: number;
};

export function SummaryIllustrationProgress({
  job,
  now,
}: SummaryIllustrationProgressProps) {
  const active = !["complete", "failed"].includes(job.stage);
  const [clock, set_clock] = useState(() => Date.parse(job.updated_at));
  useEffect(() => {
    if (!active || now !== undefined) return;
    const interval = window.setInterval(() => set_clock(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [active, now]);
  const resolved_now = now ?? clock;
  const elapsed_seconds = Math.max(
    0,
    Math.round(
      ((active ? resolved_now : Date.parse(job.updated_at)) -
        Date.parse(job.created_at)) /
        1_000,
    ),
  );
  const slots = job.slots.length > 0 ? job.slots : null;

  return (
    <aside
      className="shrink-0 border-b bg-surface-subtle px-2 py-2 sm:px-4"
      aria-label="自动配图状态"
      aria-live="polite"
    >
      <details className="group rounded-lg border bg-card">
        <summary className="flex cursor-pointer list-none items-center gap-2 p-2 focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary-muted text-primary">
            {active ? (
              <LoaderCircle
                data-icon="inline-start"
                className="animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : job.stage === "complete" ? (
              <Check data-icon="inline-start" aria-hidden="true" />
            ) : (
              <Minus data-icon="inline-start" aria-hidden="true" />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">自动配图</span>
              <Badge variant="secondary">后台</Badge>
              <span className="text-xs text-muted-foreground">
                {elapsed_seconds} 秒
              </span>
            </span>
            <span className="block truncate text-xs text-muted-foreground">
              {job.message}
            </span>
          </span>
          <ChevronDown
            className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none"
            aria-hidden="true"
          />
        </summary>
        <div className="grid gap-4 border-t p-4">
          <Progress
            value={job.progress_percent}
            aria-label={`自动配图进度 ${Math.round(job.progress_percent)}%`}
          />
          {slots ? (
            <div className="grid gap-2 lg:grid-cols-2">
              {slots.map((slot) => (
                <IllustrationSlotStatus key={slot.slot_id} slot={slot} />
              ))}
            </div>
          ) : active ? (
            <div
              className="grid grid-cols-2 gap-2"
              aria-label="正在规划配图位置"
            >
              <Skeleton className="aspect-video" />
              <Skeleton className="aspect-video" />
            </div>
          ) : null}
          {job.error_message ? (
            <p className="text-xs text-muted-foreground">
              正文已保留。详情：{job.error_message}
            </p>
          ) : null}
        </div>
      </details>
    </aside>
  );
}

function IllustrationSlotStatus({ slot }: { slot: SummaryIllustrationSlot }) {
  const active = ["pending", "locating", "validating"].includes(slot.status);
  return (
    <div className="flex min-w-0 gap-2 rounded-lg border p-2">
      <div className="flex aspect-video w-24 shrink-0 items-center justify-center overflow-hidden rounded-md bg-surface-muted sm:w-32">
        {active ? (
          <Skeleton className="size-full rounded-none" />
        ) : slot.status === "inserted" ? (
          <Check className="size-5 text-primary" aria-hidden="true" />
        ) : (
          <ImageIcon
            className="size-5 text-muted-foreground"
            aria-hidden="true"
          />
        )}
      </div>
      <div className="min-w-0 self-center">
        <p className="truncate text-sm font-medium">{slot.caption}</p>
        <p className="line-clamp-2 text-xs text-muted-foreground">
          {slot.message}
        </p>
        {slot.selected_time !== null ? (
          <p className="text-xs text-muted-foreground">
            {format_timestamp(slot.selected_time)}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function format_timestamp(seconds: number): string {
  const whole_seconds = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(whole_seconds / 60);
  const remainder = whole_seconds % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}
