import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { use_library_identity } from "@/app/library";
import { RESOURCE_QUERY_KEYS } from "@/app/query_cache";
import type { TaskRecord } from "@/features/workbench/tasks";
import { import_local_media, import_video_directory } from "@/shared/api";
import { error_message, is_abort_error } from "@/shared/errors";
import { uuid7 } from "@/shared/identifiers";
import type { MediaAsset } from "@/shared/types";

const MAX_CONCURRENT_MEDIA_IMPORTS = 2;
const BYTES_PER_MEGABYTE = 1024 * 1024;
const MAX_DISPLAYED_IMPORT_FAILURES = 5;
const SUPPORTED_MEDIA_FILE_EXTENSIONS = new Set([
  ".avi",
  ".bmp",
  ".gif",
  ".jpeg",
  ".jpg",
  ".m4v",
  ".mkv",
  ".mov",
  ".mp4",
  ".png",
  ".webm",
  ".webp",
]);
const TERMINAL_IMPORT_STAGES = new Set(["complete", "failed", "cancelled"]);

type ImportSource =
  | { kind: "file"; file: File }
  | { kind: "directory"; path: string; include_subfolders: boolean };

type ImportEntry = {
  source: ImportSource;
  library_id: string;
  fingerprint: string;
  task: TaskRecord;
  controller: AbortController | null;
};

export type MediaImportSubmission = {
  queued: number;
  duplicates: number;
  unsupported: number;
};

export function use_media_import_tasks(
  record_task: (task: TaskRecord) => void,
) {
  const library_id = use_library_identity();
  const query_client = useQueryClient();
  const entries = useRef(new Map<string, ImportEntry>());
  const queue = useRef<string[]>([]);
  const active_count = useRef(0);
  const disposed = useRef(false);
  const generation = useRef(0);
  const process_queue_ref = useRef<(() => void) | null>(null);

  const publish = useCallback(
    (entry: ImportEntry, changes: Partial<TaskRecord>) => {
      if (disposed.current || entries.current.get(entry.task.task_id) !== entry)
        return;
      entry.task = { ...entry.task, ...changes };
      record_task(entry.task);
    },
    [record_task],
  );

  const refresh_imported_assets = useCallback(() => {
    void Promise.all([
      query_client.invalidateQueries({ queryKey: RESOURCE_QUERY_KEYS.assets }),
      query_client.invalidateQueries({
        queryKey: RESOURCE_QUERY_KEYS.library_folders,
      }),
    ]).catch(() => undefined);
  }, [query_client]);

  const process_queue = useCallback(() => {
    while (
      !disposed.current &&
      active_count.current < MAX_CONCURRENT_MEDIA_IMPORTS &&
      queue.current.length > 0
    ) {
      const task_id = queue.current.shift()!;
      const entry = entries.current.get(task_id);
      if (!entry || entry.task.stage !== "queued") continue;
      const current_generation = generation.current;
      const controller = new AbortController();
      entry.controller = controller;
      active_count.current += 1;
      const source = entry.source;
      publish(entry, {
        stage: source.kind === "file" ? "uploading" : "processing",
        message:
          source.kind === "file"
            ? "正在上传文件，可继续使用其他功能"
            : "正在扫描并导入文件夹，可切换页面，已完成素材会保留",
        progress_known: false,
      });
      const import_request =
        source.kind === "directory"
          ? import_video_directory(
              source.path,
              source.include_subfolders,
              entry.library_id,
              controller.signal,
            )
          : import_local_media(source.file, {
              library_id: entry.library_id,
              signal: controller.signal,
              on_progress: (loaded_bytes, total_bytes) => {
                if (controller.signal.aborted) return;
                const uploaded = total_bytes > 0 && loaded_bytes >= total_bytes;
                publish(entry, {
                  stage: uploaded ? "processing" : "uploading",
                  message: uploaded
                    ? "上传完成，正在校验并加入资料库"
                    : total_bytes > 0
                      ? `已上传 ${(loaded_bytes / BYTES_PER_MEGABYTE).toFixed(1)} / ${(total_bytes / BYTES_PER_MEGABYTE).toFixed(1)} MB`
                      : "正在上传文件，大小暂不可估计",
                  progress_known: !uploaded && total_bytes > 0,
                  progress_percent:
                    total_bytes > 0
                      ? Math.min(100, (loaded_bytes / total_bytes) * 100)
                      : 0,
                });
              },
            }).then((asset) => ({
              assets: [asset],
              failed_files: [] as string[],
            }));
      void import_request
        .then((result) => {
          controller.signal.throwIfAborted();
          if (disposed.current || generation.current !== current_generation)
            return;
          if (result.assets.length > 0) {
            const imported_ids = new Set(
              result.assets.map((asset) => asset.asset_id),
            );
            query_client.setQueryData<MediaAsset[]>(
              RESOURCE_QUERY_KEYS.assets,
              (current) => [
                ...result.assets,
                ...(current ?? []).filter(
                  (asset) => !imported_ids.has(asset.asset_id),
                ),
              ],
            );
          }
          const has_failures = result.failed_files.length > 0;
          const failure_details = result.failed_files
            .slice(0, MAX_DISPLAYED_IMPORT_FAILURES)
            .join("；");
          const hidden_failure_count =
            result.failed_files.length - MAX_DISPLAYED_IMPORT_FAILURES;
          publish(entry, {
            stage: has_failures ? "failed" : "complete",
            message:
              source.kind === "file"
                ? "已加入资料库"
                : has_failures
                  ? `已导入 ${result.assets.length} 个视频，${result.failed_files.length} 个失败；请仅重新导入失败文件，避免重复复制`
                  : `已导入 ${result.assets.length} 个视频，文件夹结构已同步`,
            error_message: has_failures
              ? `${failure_details}${hidden_failure_count > 0 ? `；另有 ${hidden_failure_count} 个失败文件` : ""}`
              : null,
            progress_percent: 100,
            progress_known: true,
            cancel_available: false,
            retry_available: false,
            delete_available: true,
          });
          refresh_imported_assets();
        })
        .catch((error: unknown) => {
          const cancelled = controller.signal.aborted || is_abort_error(error);
          publish(entry, {
            stage: cancelled ? "cancelled" : "failed",
            message: cancelled
              ? "导入请求已停止，已入库素材会保留"
              : source.kind === "file"
                ? "导入失败，可重试或删除任务"
                : "目录导入中断，已入库素材保留；请核对现有内容后仅导入剩余文件",
            error_message: cancelled ? null : error_message(error),
            cancel_available: false,
            retry_available: source.kind === "file",
            delete_available: true,
          });
          if (
            (cancelled || source.kind === "directory") &&
            !disposed.current &&
            generation.current === current_generation
          )
            refresh_imported_assets();
        })
        .finally(() => {
          if (disposed.current || generation.current !== current_generation)
            return;
          if (entry.controller === controller) entry.controller = null;
          active_count.current -= 1;
          process_queue_ref.current?.();
        });
    }
  }, [publish, query_client, refresh_imported_assets]);

  useEffect(() => {
    process_queue_ref.current = process_queue;
  }, [process_queue]);

  useEffect(() => {
    disposed.current = false;
    const current_entries = entries.current;
    const current_queue = queue.current;
    return () => {
      disposed.current = true;
      generation.current += 1;
      current_queue.length = 0;
      current_entries.forEach((entry) => entry.controller?.abort());
      current_entries.clear();
      active_count.current = 0;
    };
  }, [library_id]);

  const enqueue_media_imports = useCallback(
    (files: File[]): MediaImportSubmission => {
      if (!library_id) throw new Error("请先打开资料库再导入媒体");
      const submission = { queued: 0, duplicates: 0, unsupported: 0 };
      for (const file of files) {
        const extension_index = file.name.lastIndexOf(".");
        const extension =
          extension_index >= 0
            ? file.name.slice(extension_index).toLowerCase()
            : "";
        if (!SUPPORTED_MEDIA_FILE_EXTENSIONS.has(extension)) {
          submission.unsupported += 1;
          continue;
        }
        const fingerprint = JSON.stringify([
          file.name,
          file.size,
          file.lastModified,
          file.type,
          file.webkitRelativePath,
        ]);
        if (
          [...entries.current.values()].some(
            (entry) =>
              entry.fingerprint === fingerprint &&
              !TERMINAL_IMPORT_STAGES.has(entry.task.stage),
          )
        ) {
          submission.duplicates += 1;
          continue;
        }
        const task: TaskRecord = {
          task_id: `import-${uuid7().replaceAll("-", "")}`,
          task_type: "import",
          name: file.name,
          stage: "queued",
          message: "已加入导入队列",
          progress_percent: 0,
          progress_known: false,
          error_message: null,
          created_at: new Date().toISOString(),
          cancel_available: true,
        };
        const entry: ImportEntry = {
          source: { kind: "file", file },
          library_id,
          fingerprint,
          task,
          controller: null,
        };
        entries.current.set(task.task_id, entry);
        queue.current.push(task.task_id);
        record_task(task);
        submission.queued += 1;
      }
      process_queue();
      return submission;
    },
    [library_id, process_queue, record_task],
  );

  const enqueue_directory_import = useCallback(
    (path: string, include_subfolders: boolean): boolean => {
      if (!library_id) throw new Error("请先打开资料库再导入媒体");
      const source_path = path.trim();
      if (!source_path) throw new Error("请选择要导入的文件夹");
      const fingerprint = JSON.stringify([
        "directory",
        source_path.replace(/[\\/]+$/, "") || source_path,
      ]);
      if (
        [...entries.current.values()].some(
          (entry) =>
            entry.fingerprint === fingerprint &&
            !TERMINAL_IMPORT_STAGES.has(entry.task.stage),
        )
      )
        return false;
      const name =
        source_path
          .replace(/[\\/]+$/, "")
          .split(/[\\/]/)
          .at(-1) || source_path;
      const task: TaskRecord = {
        task_id: `import-${uuid7().replaceAll("-", "")}`,
        task_type: "import",
        name: `${name} · 文件夹导入`,
        stage: "queued",
        message: "已加入文件夹导入队列",
        progress_percent: 0,
        progress_known: false,
        error_message: null,
        created_at: new Date().toISOString(),
        cancel_available: true,
      };
      entries.current.set(task.task_id, {
        source: { kind: "directory", path: source_path, include_subfolders },
        library_id,
        fingerprint,
        task,
        controller: null,
      });
      queue.current.push(task.task_id);
      record_task(task);
      process_queue();
      return true;
    },
    [library_id, process_queue, record_task],
  );

  const cancel_media_import = useCallback(
    (task_id: string): boolean => {
      const entry = entries.current.get(task_id);
      if (!entry) return false;
      if (TERMINAL_IMPORT_STAGES.has(entry.task.stage)) return true;
      if (entry.controller) {
        publish(entry, {
          stage: "cancelling",
          message: "正在停止导入请求，已入库素材会保留",
          cancel_available: false,
        });
        entry.controller.abort();
      } else {
        publish(entry, {
          stage: "cancelled",
          message: "已从导入队列移除",
          cancel_available: false,
          retry_available: entry.source.kind === "file",
          delete_available: true,
        });
      }
      return true;
    },
    [publish],
  );

  const retry_media_import = useCallback(
    (task_id: string): boolean => {
      const entry = entries.current.get(task_id);
      if (!entry) return false;
      if (entry.task.stage !== "failed" && entry.task.stage !== "cancelled")
        return true;
      if (entry.source.kind === "directory")
        throw new Error(
          "目录导入不支持整批重试，请核对已入库内容后仅重新导入剩余文件",
        );
      const already_active = [...entries.current.values()].some(
        (other) =>
          other !== entry &&
          other.fingerprint === entry.fingerprint &&
          !TERMINAL_IMPORT_STAGES.has(other.task.stage),
      );
      if (already_active) throw new Error("此文件已在导入队列中");
      publish(entry, {
        stage: "queued",
        message: "已重新加入导入队列",
        error_message: null,
        progress_percent: 0,
        progress_known: false,
        cancel_available: true,
        retry_available: false,
        delete_available: false,
      });
      queue.current.push(task_id);
      process_queue();
      return true;
    },
    [process_queue, publish],
  );

  const delete_media_import = useCallback((task_id: string): boolean => {
    const entry = entries.current.get(task_id);
    if (!entry) return false;
    if (!TERMINAL_IMPORT_STAGES.has(entry.task.stage))
      throw new Error("请先停止导入再删除任务");
    entries.current.delete(task_id);
    return true;
  }, []);

  return {
    enqueue_media_imports,
    enqueue_directory_import,
    cancel_media_import,
    retry_media_import,
    delete_media_import,
  };
}
