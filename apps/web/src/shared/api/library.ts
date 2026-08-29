import type { LibraryDescription, LibraryFolder, MediaAsset } from "../types";
import { api_base_url, ApiError, request_json } from "./client";

export function get_library(
  signal?: AbortSignal,
): Promise<LibraryDescription | null> {
  return request_json("/api/library", { signal });
}

export function create_library(
  path: string,
  signal?: AbortSignal,
): Promise<LibraryDescription> {
  return request_json("/api/library/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
    signal,
  });
}

export function open_library(
  path: string,
  signal?: AbortSignal,
): Promise<LibraryDescription> {
  return request_json("/api/library/open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
    signal,
  });
}

export async function select_directory(
  signal?: AbortSignal,
): Promise<string | null> {
  const selection = await request_json<{ path: string | null }>(
    "/api/directories/select",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal,
    },
  );
  return selection.path;
}

export async function close_library(signal?: AbortSignal): Promise<void> {
  const response = await fetch(`${api_base_url}/api/library`, {
    method: "DELETE",
    signal,
  });
  if (!response.ok)
    throw new ApiError(`请求失败（${response.status}）`, response.status);
}

export function list_assets(
  signal?: AbortSignal,
  options?: {
    folder_id?: string;
    uncategorized?: boolean;
    search?: string;
    sort_by?: "created_at" | "title" | "duration";
    sort_order?: "asc" | "desc";
  },
): Promise<MediaAsset[]> {
  const parameters = new URLSearchParams();
  if (options?.folder_id) parameters.set("folder_id", options.folder_id);
  if (options?.uncategorized) parameters.set("uncategorized", "true");
  if (options?.search) parameters.set("search", options.search);
  if (options?.sort_by) parameters.set("sort_by", options.sort_by);
  if (options?.sort_order) parameters.set("sort_order", options.sort_order);
  const query = parameters.size ? `?${parameters.toString()}` : "";
  return request_json(`/api/media/assets${query}`, { signal });
}

export function list_folders(signal?: AbortSignal): Promise<LibraryFolder[]> {
  return request_json("/api/library/folders", { signal });
}

export function import_local_video(
  file: File,
  signal?: AbortSignal,
): Promise<MediaAsset> {
  const form_data = new FormData();
  form_data.append("file", file, file.name);
  return request_json("/api/media/assets/import", {
    method: "POST",
    body: form_data,
    signal,
  });
}

export function create_folder(
  name: string,
  parent_id: string | null,
  signal?: AbortSignal,
): Promise<LibraryFolder> {
  return request_json("/api/library/folders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, parent_id }),
    signal,
  });
}

export function rename_folder(
  folder_id: string,
  name: string,
  signal?: AbortSignal,
): Promise<LibraryFolder> {
  return request_json(`/api/library/folders/${encodeURIComponent(folder_id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
    signal,
  });
}

export function move_folder(
  folder_id: string,
  parent_id: string | null,
  signal?: AbortSignal,
): Promise<LibraryFolder> {
  return request_json(
    `/api/library/folders/${encodeURIComponent(folder_id)}/parent`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parent_id }),
      signal,
    },
  );
}

export function move_assets(
  asset_ids: string[],
  folder_id: string | null,
  signal?: AbortSignal,
): Promise<MediaAsset[]> {
  return request_json("/api/media/assets/move", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ asset_ids, folder_id }),
    signal,
  });
}

export async function delete_asset(
  asset_id: string,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(
    `${api_base_url}/api/media/assets/${encodeURIComponent(asset_id)}`,
    { method: "DELETE", signal },
  );
  if (!response.ok) {
    throw new ApiError(`请求失败（${response.status}）`, response.status);
  }
}

export async function delete_folder(
  folder_id: string,
  confirmation_name: string | null,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(
    `${api_base_url}/api/library/folders/${encodeURIComponent(folder_id)}`,
    {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation_name }),
      signal,
    },
  );
  if (!response.ok) {
    throw new ApiError(`请求失败（${response.status}）`, response.status);
  }
}
