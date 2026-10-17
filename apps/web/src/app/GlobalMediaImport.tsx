import { useEffect, useRef, useState } from "react";
import { CircleAlert, FileUp, Images, X } from "lucide-react";

import { use_task_manager } from "@/app/task_manager";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { error_message } from "@/shared/errors";

type ImportNotice = { message: string; error: boolean };

export function GlobalMediaImport() {
  const { enqueue_media_imports, set_task_center_open } = use_task_manager();
  const [drag_active, set_drag_active] = useState(false);
  const [notice, set_notice] = useState<ImportNotice | null>(null);
  const drag_depth = useRef(0);

  useEffect(() => {
    function handle_drag_enter(event: DragEvent) {
      if (!has_file_payload(event)) return;
      event.preventDefault();
      drag_depth.current += 1;
      set_drag_active(true);
    }

    function handle_drag_over(event: DragEvent) {
      if (!has_file_payload(event)) return;
      event.preventDefault();
      event.dataTransfer!.dropEffect = "copy";
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
      try {
        const submission = enqueue_media_imports(
          Array.from(event.dataTransfer!.files),
        );
        if (submission.queued > 0) set_task_center_open(true);
        const details = [
          submission.queued > 0
            ? `已将 ${submission.queued} 个文件加入导入队列，可继续使用其他功能。`
            : "",
          submission.duplicates > 0
            ? `跳过 ${submission.duplicates} 个已在导入的文件。`
            : "",
          submission.unsupported > 0
            ? `跳过 ${submission.unsupported} 个不支持的文件。`
            : "",
        ].filter(Boolean);
        set_notice({
          message:
            details.join(" ") ||
            "没有可导入的文件，请拖入常见的视频或图片格式。",
          error: submission.queued === 0 && submission.duplicates === 0,
        });
      } catch (error) {
        set_notice({ message: error_message(error), error: true });
      }
    }

    function reset_drag() {
      drag_depth.current = 0;
      set_drag_active(false);
    }

    window.addEventListener("blur", reset_drag);
    window.addEventListener("dragend", reset_drag);
    window.addEventListener("dragenter", handle_drag_enter);
    window.addEventListener("dragover", handle_drag_over);
    window.addEventListener("dragleave", handle_drag_leave);
    window.addEventListener("drop", handle_drop);
    return () => {
      window.removeEventListener("blur", reset_drag);
      window.removeEventListener("dragend", reset_drag);
      window.removeEventListener("dragenter", handle_drag_enter);
      window.removeEventListener("dragover", handle_drag_over);
      window.removeEventListener("dragleave", handle_drag_leave);
      window.removeEventListener("drop", handle_drop);
    };
  }, [enqueue_media_imports, set_task_center_open]);

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
              <strong className="text-lg font-semibold">
                松开即可导入媒体
              </strong>
              <span className="text-sm text-muted-foreground">
                支持一次拖入多个视频和图片，文件将复制到当前资料库。
              </span>
            </div>
          </div>
        </div>
      ) : null}

      {notice ? (
        <Alert
          className="fixed right-4 bottom-4 z-50 max-w-sm shadow-lg max-sm:right-2 max-sm:bottom-2 max-sm:left-2 max-sm:max-w-none"
          variant={notice.error ? "destructive" : "default"}
        >
          {notice.error ? <CircleAlert /> : <FileUp />}
          <AlertTitle>
            {notice.error ? "无法导入媒体" : "媒体导入队列"}
          </AlertTitle>
          <AlertDescription>{notice.message}</AlertDescription>
          <Button
            className="absolute top-2 right-2"
            type="button"
            size="icon-xs"
            variant="ghost"
            onClick={() => set_notice(null)}
            aria-label="关闭导入提示"
          >
            <X />
          </Button>
        </Alert>
      ) : null}
    </>
  );
}

function has_file_payload(event: DragEvent): boolean {
  return Boolean(
    event.dataTransfer &&
    Array.from(event.dataTransfer.types).includes("Files"),
  );
}
