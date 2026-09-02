export function format_precise_media_time(seconds: number): string {
  const total_milliseconds = Math.max(0, Math.round(seconds * 1_000));
  const milliseconds = total_milliseconds % 1_000;
  const total_seconds = Math.floor(total_milliseconds / 1_000);
  const display_seconds = total_seconds % 60;
  const total_minutes = Math.floor(total_seconds / 60);
  const minutes = total_minutes % 60;
  const hours = Math.floor(total_minutes / 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(display_seconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
}
