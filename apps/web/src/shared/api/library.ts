import type { LibraryDescription, LibraryFolder, MediaAsset } from "../types";
import { api_base_url, ApiError, request_json, response_error } from "./client";

export function get_library(
  signal?: AbortSignal,
): Promise<LibraryDescription | null> {
  return request_json("/api/library", { signal });
}

export function activate_library(
  path: string,
  signal?: AbortSignal,
): Promise<LibraryDescription> {
  return request_json("/api/library/activate", {
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

export function list_recent_assets(
  limit: number,
  signal?: AbortSignal,
): Promise<MediaAsset[]> {
  const parameters = new URLSearchParams({ limit: String(limit) });
  return request_json(`/api/media/recent?${parameters.toString()}`, { signal });
}

export function import_local_media(
  file: File,
  options: {
    library_id: string;
    signal?: AbortSignal;
    on_progress?: (loaded_bytes: number, total_bytes: number) => void;
  },
): Promise<MediaAsset> {
  return new Promise((resolve, reject) => {
    const { signal, on_progress } = options;
    signal?.throwIfAborted();
    const request = new XMLHttpRequest();
    let settled = false;
    function finish(error?: unknown, asset?: MediaAsset) {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      request.onload = null;
      request.onerror = null;
      request.onabort = null;
      request.upload.onprogress = null;
      request.upload.onload = null;
      if (error) reject(error);
      else resolve(asset!);
    }
    function abort() {
      request.abort();
      finish(new DOMException("导入请求已停止", "AbortError"));
    }
    request.open("POST", `${api_base_url}/api/media/assets/import`);
    request.upload.onprogress = (event) =>
      on_progress?.(event.loaded, event.lengthComputable ? event.total : 0);
    request.upload.onload = () => on_progress?.(file.size, file.size);
    request.onload = async () => {
      try {
        const response = new Response(request.responseText, {
          status: request.status,
          headers: { "Content-Type": "application/json" },
        });
        if (!response.ok) throw await response_error(response);
        finish(undefined, (await response.json()) as MediaAsset);
      } catch (error) {
        finish(error);
      }
    };
    request.onerror = () => finish(new Error("上传连接中断，请检查网络后重试"));
    request.onabort = () =>
      finish(new DOMException("导入请求已停止", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    const form_data = new FormData();
    form_data.append("library_id", options.library_id);
    form_data.append("file", file, file.name);
    try {
      request.send(form_data);
    } catch (error) {
      finish(error);
    }
  });
}

export type DirectoryImportResult = {
  assets: MediaAsset[];
  failed_files: string[];
};

export function import_video_directory(
  path: string,
  include_subfolders: boolean,
  library_id: string,
  signal?: AbortSignal,
): Promise<DirectoryImportResult> {
  return request_json("/api/media/assets/import-directory", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, include_subfolders, library_id }),
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
