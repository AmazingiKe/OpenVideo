const MILLISECONDS_PER_SECOND = 1_000;
const SECONDS_PER_MINUTE = 60;
export const TIMELINE_SECONDS_PER_HOUR = 3_600;

/** 时间线读数使用真实毫秒；先量化再拆段，保证进位一致。 */
export function format_timeline_time(
  seconds: number,
  { milliseconds = true, hours = true } = {},
): string {
  const safe_seconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const total_milliseconds = milliseconds
    ? Math.round(safe_seconds * MILLISECONDS_PER_SECOND)
    : Math.floor(safe_seconds) * MILLISECONDS_PER_SECOND;
  const total_seconds = Math.floor(
    total_milliseconds / MILLISECONDS_PER_SECOND,
  );
  const hour = Math.floor(total_seconds / TIMELINE_SECONDS_PER_HOUR);
  const minute =
    Math.floor(total_seconds / SECONDS_PER_MINUTE) % SECONDS_PER_MINUTE;
  const second = total_seconds % SECONDS_PER_MINUTE;
  const segments = [minute, second];
  if (hours) segments.unshift(hour);
  const clock = segments.map((part) => String(part).padStart(2, "0")).join(":");
  const fraction = String(
    total_milliseconds % MILLISECONDS_PER_SECOND,
  ).padStart(3, "0");
  return milliseconds ? `${clock}.${fraction}` : clock;
}
