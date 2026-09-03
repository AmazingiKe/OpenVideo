import { useCallback, useEffect, useRef, useState } from "react";
import { CircleAlert, FileUp, Images, LoaderCircle, X } from "lucide-react";

import { use_asset_catalog } from "@/app/asset_catalog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { import_local_media } from "@/shared/api";
import { error_message } from "@/shared/errors";

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

type ImportStatus =
  | { stage: "idle" }
  | { stage: "importing"; completed: number; total: number }
  | { stage: "complete"; imported: number; skipped: number }
  | { stage: "failed"; message: string };

export function GlobalMediaImport() {
  const { refresh_assets } = use_asset_catalog();
  const [drag_active, set_drag_active] = useState(false);
  const [status, set_status] = useState<ImportStatus>({ stage: "idle" });
  const drag_depth = useRef(0);
  const importing = status.stage === "importing";

  const import_files = useCallback(
    async (files: File[]) => {
      const supported_files = files.filter(is_supported_media);
      const skipped = files.length - supported_files.length;
      if (supported_files.length === 0) {
        set_status({
          stage: "failed",
          message: "没有可导入的文件。请拖入常见的视频或图片格式。",
        });
        return;
      }

      set_status({
        stage: "importing",
        completed: 0,
        total: supported_files.length,
      });
      const failures: string[] = [];
      let imported = 0;
      for (const [index, file] of supported_files.entries()) {
        try {
          await import_local_media(file);
          imported += 1;
        } catch (error) {
          failures.push(`${file.name}：${error_message(error)}`);
        }
        set_status({
          stage: "importing",
          completed: index + 1,
          total: supported_files.length,
        });
      }
      if (imported > 0) {
        try {
          await refresh_assets();
        } catch (error) {
          failures.push(`刷新视频库失败：${error_message(error)}`);
        }
      }
      if (failures.length > 0) {
        const partial_result = imported > 0 ? `已导入 ${imported} 个文件。` : "";
        set_status({
          stage: "failed",
          message: `${partial_result}${failures.join("；")}`,
        });
        return;
      }
      set_status({ stage: "complete", imported, skipped });
    },
    [refresh_assets],
  );

  useEffect(() => {
    function handle_drag_enter(event: DragEvent) {
      if (!has_file_payload(event)) return;
      event.preventDefault();
      drag_depth.current += 1;
      if (!importing) set_drag_active(true);
    }

    function handle_drag_over(event: DragEvent) {
      if (!has_file_payload(event)) return;
      event.preventDefault();
      event.dataTransfer!.dropEffect = importing ? "none" : "copy";
    }

    function handle_drag_leave(event: DragEvent) {
      if (!has_file_payload(event)) return;
      event.preventDefault();
      drag_depth.current = Math.max(0, drag_depth.current - 1);
      if (drag_depth.current === 0) set_drag_active(false);
    }

    function handle_drop(event: DragEvent) {
      if (!has_file_payload(event)) return;
      event.preventDefault();
      drag_depth.current = 0;
      set_drag_active(false);
      if (importing) return;
      void import_files(Array.from(event.dataTransfer!.files));
    }

    window.addEventListener("dragenter", handle_drag_enter);
    window.addEventListener("dragover", handle_drag_over);
    window.addEventListener("dragleave", handle_drag_leave);
    window.addEventListener("drop", handle_drop);
    return () => {
      window.removeEventListener("dragenter", handle_drag_enter);
      window.removeEventListener("dragover", handle_drag_over);
      window.removeEventListener("dragleave", handle_drag_leave);
      window.removeEventListener("drop", handle_drop);
    };
  }, [import_files, importing]);

  return (
    <>
      {drag_active ? (
        <div
          className="pointer-events-none fixed inset-0 z-50 grid place-items-center bg-overlay p-8 backdrop-blur-xs"
          role="presentation"
        >
          <div className="flex max-w-lg flex-col items-center gap-4 rounded-xl border bg-popover p-8 text-center text-popover-foreground shadow-lg ring-2 ring-focus-ring">
            <span className="grid size-12 place-items-center rounded-xl bg-primary-muted text-primary">
              <Images aria-hidden="true" />
            </span>
            <div className="flex flex-col gap-2">
              <strong className="text-lg font-semibold">松开即可导入媒体</strong>
              <span className="text-sm text-muted-foreground">
                支持一次拖入多个视频和图片，文件将复制到当前资料库。
              </span>
            </div>
          </div>
        </div>
      ) : null}

      {status.stage !== "idle" ? (
        <Alert
          className="fixed right-4 bottom-4 z-50 max-w-sm shadow-lg"
          variant={status.stage === "failed" ? "destructive" : "default"}
        >
          {status.stage === "importing" ? (
            <LoaderCircle className="animate-spin motion-reduce:animate-none" />
          ) : status.stage === "failed" ? (
            <CircleAlert />
          ) : (
            <FileUp />
          )}
          <AlertTitle>{status_title(status)}</AlertTitle>
          <AlertDescription>{status_description(status)}</AlertDescription>
          {status.stage !== "importing" ? (
            <Button
              className="absolute top-2 right-2"
              type="button"
              size="icon-xs"
              variant="ghost"
              onClick={() => set_status({ stage: "idle" })}
              aria-label="关闭导入提示"
            >
              <X />
            </Button>
          ) : null}
        </Alert>
      ) : null}
    </>
  );
}

function status_title(status: ImportStatus): string {
  if (status.stage === "importing") return "正在导入媒体";
  if (status.stage === "complete") return "媒体已导入";
  if (status.stage === "failed") return "部分媒体未能导入";
  return "";
}

function status_description(status: ImportStatus): string {
  if (status.stage === "importing") {
    return `正在处理 ${status.completed}/${status.total} 个文件，请保持应用打开。`;
  }
  if (status.stage === "complete") {
    const skipped = status.skipped > 0 ? `，跳过 ${status.skipped} 个不支持的文件` : "";
    return `已将 ${status.imported} 个文件加入视频库${skipped}。`;
  }
  return status.stage === "failed" ? status.message : "";
}

function has_file_payload(event: DragEvent): boolean {
  return Boolean(
    event.dataTransfer && Array.from(event.dataTransfer.types).includes("Files"),
  );
}

function is_supported_media(file: File): boolean {
  const extension_index = file.name.lastIndexOf(".");
  const extension =
    extension_index >= 0 ? file.name.slice(extension_index).toLowerCase() : "";
  return SUPPORTED_MEDIA_FILE_EXTENSIONS.has(extension);
}
