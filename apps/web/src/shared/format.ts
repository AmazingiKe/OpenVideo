export function format_duration(duration_seconds: number | null): string {
  if (duration_seconds === null || !Number.isFinite(duration_seconds)) return "时长未知";
  const total_seconds = Math.max(0, Math.floor(duration_seconds));
  return format_clock(total_seconds);
}

export function format_clock(total_seconds: number): string {
  const hours = Math.floor(total_seconds / 3600);
  const minutes = Math.floor((total_seconds % 3600) / 60);
  const seconds = total_seconds % 60;
  return hours > 0
    ? [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":")
    : [minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
}

export function format_time(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "00:00";
  return format_clock(Math.floor(seconds));
}
