import type { ApiError } from "@/shared/api";

export function error_message(error: unknown): string {
  if (is_abort_error(error)) return "请求已取消";
  if (is_api_error(error) || error instanceof Error) return error.message;
  return "发生了未知错误";
}

export function is_abort_error(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function is_not_found_error(error: unknown): error is ApiError {
  return is_api_error(error) && error.status === 404;
}

function is_api_error(error: unknown): error is ApiError {
  return error instanceof Error && "status" in error;
}
