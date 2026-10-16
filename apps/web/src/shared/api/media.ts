import type {
  SubtitleDisplaySettings,
  SubtitleExportResult,
  SubtitleFileFormat,
  ThumbnailStoryboard,
} from "../types";
import { api_base_url, request_json, request_response } from "./client";

const DOWNLOAD_URL_RELEASE_DELAY_MILLISECONDS = 1_000;

export async function download_subtitle_file(
  asset_id: string,
  format: SubtitleFileFormat,
  signal?: AbortSignal,
): Promise<void> {
  const response = await request_response(
    `/api/media/assets/${encodeURIComponent(asset_id)}/subtitle-file?format=${format}`,
    { signal },
  );
  const file = await response.blob();
  signal?.throwIfAborted();
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const encoded_name = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const plain_name = disposition.match(/filename="([^"]+)"/i)?.[1];
  let file_name = plain_name ?? `${asset_id}.${format}`;
  if (encoded_name) {
    try {
      file_name = decodeURIComponent(encoded_name);
    } catch {
      // 非法文件名编码不影响字幕下载，继续使用备用名称。
    }
  }
  const download_url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = download_url;
  link.download = file_name.replace(/[/\\]/g, "_");
  try {
    document.body.append(link);
    link.click();
  } finally {
    link.remove();
    // 浏览器开始读取附件后再释放地址，避免下载与回收同时发生。
    setTimeout(
      () => URL.revokeObjectURL(download_url),
      DOWNLOAD_URL_RELEASE_DELAY_MILLISECONDS,
    );
  }
}

export function media_url(path: string): string;
export function media_url(path: string | null | undefined): string | undefined;
export function media_url(path: string | null | undefined): string | undefined {
  return path ? `${api_base_url}${path}` : undefined;
}

export function update_subtitle_settings(
  asset_id: string,
  settings: SubtitleDisplaySettings,
  signal?: AbortSignal,
): Promise<SubtitleDisplaySettings> {
  return request_json(
    `/api/media/assets/${encodeURIComponent(asset_id)}/subtitle-settings`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
      signal,
    },
  );
}

export function create_subtitle_export(
  asset_id: string,
  signal?: AbortSignal,
): Promise<SubtitleExportResult> {
  return request_json(
    `/api/media/assets/${encodeURIComponent(asset_id)}/subtitle-exports`,
    { method: "POST", signal },
  );
}

export function ensure_thumbnail_storyboard(
  asset_id: string,
  signal?: AbortSignal,
): Promise<ThumbnailStoryboard> {
  return request_json(
    `/api/media/assets/${encodeURIComponent(asset_id)}/thumbnail-storyboard`,
    { method: "POST", signal },
  );
}
