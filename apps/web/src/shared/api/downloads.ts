import type {
  DownloadAccount,
  DownloadAccountLoginSession,
  DownloadCookieBrowser,
  DownloadDestination,
  DownloadJob,
  ProbeResponse,
  SourcePlatform,
} from "../types";
import { api_base_url, ApiError, request_json } from "./client";

export function get_download_accounts(
  signal?: AbortSignal,
): Promise<DownloadAccount[]> {
  return request_json("/api/download-accounts", { signal });
}

export function create_download_account_login_session(
  platform: SourcePlatform,
  signal?: AbortSignal,
): Promise<DownloadAccountLoginSession> {
  return request_json(`/api/download-accounts/${platform}/login-sessions`, {
    method: "POST",
    signal,
  });
}

export function get_download_account_login_session(
  login_id: string,
  signal?: AbortSignal,
): Promise<DownloadAccountLoginSession> {
  return request_json(
    `/api/download-account-login-sessions/${encodeURIComponent(login_id)}`,
    { signal },
  );
}

export async function delete_download_account_login_session(
  login_id: string,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(
    `${api_base_url}/api/download-account-login-sessions/${encodeURIComponent(login_id)}`,
    { method: "DELETE", signal },
  );
  if (!response.ok)
    throw new ApiError(`请求失败（${response.status}）`, response.status);
}

export function save_download_account(
  platform: SourcePlatform,
  cookie: string,
  signal?: AbortSignal,
): Promise<DownloadAccount> {
  return request_json(`/api/download-accounts/${platform}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cookie }),
    signal,
  });
}

export function import_download_account_from_browser(
  platform: SourcePlatform,
  browser: DownloadCookieBrowser,
  source_url?: string,
  signal?: AbortSignal,
): Promise<DownloadAccount> {
  return request_json(`/api/download-accounts/${platform}/import-browser`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ browser, source_url: source_url || null }),
    signal,
  });
}

export function test_download_account(
  platform: SourcePlatform,
  source_url?: string,
  signal?: AbortSignal,
): Promise<DownloadAccount> {
  return request_json(`/api/download-accounts/${platform}/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source_url: source_url || null }),
    signal,
  });
}

export async function delete_download_account(
  platform: SourcePlatform,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(
    `${api_base_url}/api/download-accounts/${platform}`,
    {
      method: "DELETE",
      signal,
    },
  );
  if (!response.ok)
    throw new ApiError(`请求失败（${response.status}）`, response.status);
}

export function probe_source(
  source_url: string,
  signal?: AbortSignal,
): Promise<ProbeResponse> {
  return request_json("/api/downloads/probe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source_url }),
    signal,
  });
}

export function create_download(
  source_urls: string[],
  signal?: AbortSignal,
  destination: DownloadDestination = {
    video_quality: "best",
    folder_id: null,
    automatic_folder_name: null,
    assign_folder: false,
  },
): Promise<DownloadJob[]> {
  return request_json("/api/downloads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source_urls, ...destination }),
    signal,
  });
}

export function list_downloads(
  limit: number,
  signal?: AbortSignal,
): Promise<DownloadJob[]> {
  const parameters = new URLSearchParams({ limit: limit.toString() });
  return request_json(`/api/downloads?${parameters}`, { signal });
}

export function get_download(
  job_id: string,
  signal?: AbortSignal,
): Promise<DownloadJob> {
  return request_json(`/api/downloads/${encodeURIComponent(job_id)}`, {
    signal,
  });
}

export function request_download_retry(
  job_id: string,
  signal?: AbortSignal,
): Promise<DownloadJob> {
  return request_json(`/api/downloads/${encodeURIComponent(job_id)}/retry`, {
    method: "POST",
    signal,
  });
}
