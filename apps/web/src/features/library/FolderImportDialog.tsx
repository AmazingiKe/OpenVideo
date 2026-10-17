import { useEffect, useRef, useState } from "react";
import { CircleAlert, FolderOpen, Import } from "lucide-react";

import { use_task_manager } from "@/app/task_manager";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { select_directory } from "@/shared/api";
import { error_message, is_abort_error } from "@/shared/errors";

type FolderImportDialogProps = {
  open: boolean;
  on_open_change: (open: boolean) => void;
};

export function FolderImportDialog({
  open,
  on_open_change,
}: FolderImportDialogProps) {
  const { enqueue_directory_import, set_task_center_open } = use_task_manager();
  const [directory_path, set_directory_path] = useState("");
  const [include_subfolders, set_include_subfolders] = useState(false);
  const [choosing_directory, set_choosing_directory] = useState(false);
  const [operation_error, set_operation_error] = useState<string | null>(null);
  const picker_request_ref = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) {
      set_directory_path("");
      set_include_subfolders(false);
      set_choosing_directory(false);
      set_operation_error(null);
    }
    return () => {
      picker_request_ref.current?.abort();
      picker_request_ref.current = null;
    };
  }, [open]);

  function change_open(next_open: boolean) {
    if (!next_open) {
      picker_request_ref.current?.abort();
      picker_request_ref.current = null;
      set_choosing_directory(false);
    }
    on_open_change(next_open);
  }

  async function choose_directory() {
    if (picker_request_ref.current) return;
    const controller = new AbortController();
    picker_request_ref.current = controller;
    set_choosing_directory(true);
    set_operation_error(null);
    try {
      const selected_path = await select_directory(controller.signal);
      controller.signal.throwIfAborted();
      if (selected_path) set_directory_path(selected_path);
    } catch (error) {
      if (!controller.signal.aborted && !is_abort_error(error))
        set_operation_error(error_message(error));
    } finally {
      if (picker_request_ref.current === controller) {
        picker_request_ref.current = null;
        set_choosing_directory(false);
      }
    }
  }

  function import_directory() {
    if (!directory_path || choosing_directory) return;
    set_operation_error(null);
    try {
      enqueue_directory_import(directory_path, include_subfolders);
      set_task_center_open(true);
      change_open(false);
    } catch (error) {
      set_operation_error(error_message(error));
    }
  }

  return (
    <Dialog open={open} onOpenChange={change_open}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>从文件夹导入视频</DialogTitle>
          <DialogDescription>
            加入后台队列后即可继续使用其他功能，进度和停止操作见任务中心。文件夹结构会保留，原始文件不会被修改。
          </DialogDescription>
        </DialogHeader>

        <FieldGroup>
          <Field data-disabled={choosing_directory}>
            <FieldLabel htmlFor="video_import_directory">来源文件夹</FieldLabel>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                id="video_import_directory"
                className="min-w-0 flex-1"
                value={directory_path}
                placeholder="尚未选择文件夹"
                readOnly
                disabled={choosing_directory}
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => void choose_directory()}
                disabled={choosing_directory}
              >
                {choosing_directory ? (
                  <Spinner aria-hidden="true" data-icon="inline-start" />
                ) : (
                  <FolderOpen data-icon="inline-start" />
                )}
                {choosing_directory ? "正在选择…" : "选择文件夹"}
              </Button>
            </div>
          </Field>

          <Field className="flex-row items-start gap-3 rounded-xl border bg-surface-subtle p-3">
            <Checkbox
              id="include_video_subfolders"
              checked={include_subfolders}
              onCheckedChange={(checked) =>
                set_include_subfolders(checked === true)
              }
              disabled={choosing_directory}
            />
            <div className="flex flex-col gap-1">
              <FieldLabel htmlFor="include_video_subfolders">
                包含子文件夹
              </FieldLabel>
              <FieldDescription>
                开启后递归导入，并在视频库中保留完整的相对文件夹结构。
              </FieldDescription>
            </div>
          </Field>
        </FieldGroup>

        {operation_error ? (
          <Alert variant="destructive">
            <CircleAlert aria-hidden="true" />
            <AlertTitle>无法导入此文件夹</AlertTitle>
            <AlertDescription>{operation_error}</AlertDescription>
          </Alert>
        ) : null}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => change_open(false)}
          >
            关闭
          </Button>
          <Button
            type="button"
            onClick={import_directory}
            disabled={!directory_path || choosing_directory}
          >
            <Import data-icon="inline-start" />
            开始导入
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
