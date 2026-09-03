import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CircleAlert, FolderOpen, Import } from "lucide-react";

import { RESOURCE_QUERY_KEYS } from "@/app/query_cache";
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
import { import_video_directory, select_directory } from "@/shared/api";
import { error_message, is_abort_error } from "@/shared/errors";

type FolderImportDialogProps = {
  open: boolean;
  on_open_change: (open: boolean) => void;
};

type ImportResult = {
  imported: number;
  failed_files: string[];
};

export function FolderImportDialog({
  open,
  on_open_change,
}: FolderImportDialogProps) {
  const query_client = useQueryClient();
  const [directory_path, set_directory_path] = useState("");
  const [include_subfolders, set_include_subfolders] = useState(false);
  const [submitting, set_submitting] = useState(false);
  const [operation_error, set_operation_error] = useState<string | null>(null);
  const [result, set_result] = useState<ImportResult | null>(null);

  function change_open(next_open: boolean) {
    if (!next_open && submitting) return;
    if (!next_open) {
      set_directory_path("");
      set_include_subfolders(false);
      set_operation_error(null);
      set_result(null);
    }
    on_open_change(next_open);
  }

  async function choose_directory() {
    set_operation_error(null);
    try {
      const selected_path = await select_directory();
      if (selected_path) set_directory_path(selected_path);
    } catch (error) {
      if (!is_abort_error(error)) set_operation_error(error_message(error));
    }
  }

  async function import_directory() {
    if (!directory_path) return;
    set_submitting(true);
    set_operation_error(null);
    set_result(null);
    try {
      const imported = await import_video_directory(
        directory_path,
        include_subfolders,
      );
      await Promise.all([
        query_client.invalidateQueries({
          queryKey: RESOURCE_QUERY_KEYS.assets,
        }),
        query_client.invalidateQueries({
          queryKey: RESOURCE_QUERY_KEYS.library_folders,
        }),
      ]);
      set_result({
        imported: imported.assets.length,
        failed_files: imported.failed_files,
      });
    } catch (error) {
      if (!is_abort_error(error)) set_operation_error(error_message(error));
    } finally {
      set_submitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={change_open}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>从文件夹导入视频</DialogTitle>
          <DialogDescription>
            所选文件夹会在视频库中创建为顶层文件夹，原始文件不会被修改。
          </DialogDescription>
        </DialogHeader>

        <FieldGroup>
          <Field data-disabled={submitting}>
            <FieldLabel htmlFor="video_import_directory">来源文件夹</FieldLabel>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                id="video_import_directory"
                className="min-w-0 flex-1"
                value={directory_path}
                placeholder="尚未选择文件夹"
                readOnly
                disabled={submitting}
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => void choose_directory()}
                disabled={submitting}
              >
                <FolderOpen data-icon="inline-start" />
                选择文件夹
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
              disabled={submitting}
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

        {result ? (
          <Alert
            variant={result.failed_files.length > 0 ? "destructive" : "default"}
          >
            {result.failed_files.length > 0 ? (
              <CircleAlert aria-hidden="true" />
            ) : (
              <CheckCircle2 aria-hidden="true" />
            )}
            <AlertTitle>已导入 {result.imported} 个视频</AlertTitle>
            <AlertDescription>
              {result.failed_files.length > 0
                ? `${result.failed_files.length} 个文件失败：${result.failed_files.join("；")}`
                : "文件夹结构已同步到视频库。"}
            </AlertDescription>
          </Alert>
        ) : null}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => change_open(false)}
            disabled={submitting}
          >
            关闭
          </Button>
          <Button
            type="button"
            onClick={() => void import_directory()}
            disabled={!directory_path || submitting}
          >
            {submitting ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <Import data-icon="inline-start" />
            )}
            {submitting ? "正在导入" : "开始导入"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
