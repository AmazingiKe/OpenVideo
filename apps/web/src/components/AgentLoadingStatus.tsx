import { useEffect, useState } from "react";

import { Loader } from "@/components/ui/loader";
import { cn } from "@/lib/utils";

const ELAPSED_TIME_UPDATE_INTERVAL_MS = 1_000;

export function AgentLoadingStatus({
  label,
  started_at,
  className,
}: {
  label: string;
  started_at?: number;
  className?: string;
}) {
  const [elapsed_seconds, set_elapsed_seconds] = useState(0);

  useEffect(() => {
    const resolved_started_at = started_at ?? Date.now();

    function update_elapsed_time() {
      set_elapsed_seconds(elapsed_time_seconds(resolved_started_at));
    }

    update_elapsed_time();
    const interval_id = window.setInterval(
      update_elapsed_time,
      ELAPSED_TIME_UPDATE_INTERVAL_MS,
    );
    return () => window.clearInterval(interval_id);
  }, [started_at]);

  return (
    <span
      className={cn("inline-flex items-center gap-2", className)}
      role="status"
      aria-label={label}
    >
      <span className="inline-flex items-center gap-2" aria-hidden="true">
        <Loader variant="typing" size="md" />
        <Loader variant="text-blink" size="sm" text={label} />
        <time
          className="font-mono text-xs text-muted-foreground tabular-nums"
          dateTime={`PT${elapsed_seconds}S`}
        >
          {format_elapsed_time(elapsed_seconds)}
        </time>
      </span>
    </span>
  );
}

function elapsed_time_seconds(started_at: number): number {
  return Math.max(0, Math.floor((Date.now() - started_at) / 1_000));
}

export function format_elapsed_time(elapsed_seconds: number): string {
  const hours = Math.floor(elapsed_seconds / 3_600);
  const minutes = Math.floor((elapsed_seconds % 3_600) / 60);
  const seconds = elapsed_seconds % 60;
  const minute_seconds = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${minute_seconds}`
    : minute_seconds;
}
