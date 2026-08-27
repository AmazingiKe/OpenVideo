import type { FormEvent } from "react";
import { Trash2 } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { MoveToFolderDialog } from "@/features/library/MoveToFolderDialog";
import type { LibraryFolder, MediaAsset } from "@/shared/types";

export type FolderEditor = {
  mode: "create" | "rename";
  folder: LibraryFolder | null;
  parent_id: string | null;
};

export type MoveTarget =
  | { kind: "assets"; asset_ids: string[]; initial_folder_id: string | null }
  | { kind: "folder"; folder: LibraryFolder }
  | null;

type LibraryBrowserDialogsProps = {
  folder_editor: FolderEditor | null;
  folder_name: string;
  move_target: MoveTarget;
  folders: LibraryFolder[];
  asset_ids_to_delete: string[];
  delete_assets: MediaAsset[];
  folder_to_delete: LibraryFolder | null;
  folder_requires_confirmation: boolean;
  folder_confirmation: string;
  submitting: boolean;
  set_folder_editor: (editor: FolderEditor | null) => void;
  set_folder_name: (name: string) => void;
  set_move_target: (target: MoveTarget) => void;
  set_asset_ids_to_delete: (asset_ids: string[]) => void;
  set_folder_to_delete: (folder: LibraryFolder | null) => void;
  set_folder_confirmation: (name: string) => void;
  submit_folder: (event: FormEvent<HTMLFormElement>) => void;
  submit_move: (folder_id: string | null) => Promise<void>;
  confirm_asset_delete: () => Promise<void>;
  confirm_folder_delete: () => Promise<void>;
};

export function LibraryBrowserDialogs({
  folder_editor,
  folder_name,
  move_target,
  folders,
  asset_ids_to_delete,
  delete_assets,
  folder_to_delete,
  folder_requires_confirmation,
  folder_confirmation,
  submitting,
  set_folder_editor,
  set_folder_name,
  set_move_target,
  set_asset_ids_to_delete,
  set_folder_to_delete,
  set_folder_confirmation,
  submit_folder,
  submit_move,
  confirm_asset_delete,
  confirm_folder_delete,
}: LibraryBrowserDialogsProps) {
  return (
    <>
      <Dialog
        open={folder_editor !== null}
        onOpenChange={(open) => {
          if (!open && !submitting) set_folder_editor(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {folder_editor?.mode === "rename" ? "重命名文件夹" : "新建文件夹"}
            </DialogTitle>
            <DialogDescription>
              文件夹只用于整理视频，不会创建或移动真实目录。
            </DialogDescription>
          </DialogHeader>
          <form className="flex flex-col gap-4" onSubmit={submit_folder}>
            <FieldGroup>
              <Field data-disabled={submitting}>
                <FieldLabel htmlFor="library_folder_name">
                  文件夹名称
                </FieldLabel>
                <Input
                  id="library_folder_name"
                  className="select-text"
                  value={folder_name}
                  onChange={(event) => set_folder_name(event.target.value)}
                  maxLength={100}
                  autoFocus
                  disabled={submitting}
                />
              </Field>
            </FieldGroup>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={submitting}
                onClick={() => set_folder_editor(null)}
              >
                取消
              </Button>
              <Button
                type="submit"
                disabled={submitting || !folder_name.trim()}
              >
                {submitting ? <Spinner data-icon="inline-start" /> : null}
                保存
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <MoveToFolderDialog
        open={move_target !== null}
        title={move_target?.kind === "folder" ? "移动文件夹" : "移动视频"}
        description={
          move_target?.kind === "folder"
            ? "选择新的父文件夹，所有后代会保持原有层级。"
            : `将 ${move_target?.asset_ids.length ?? 0} 个视频归入同一文件夹。`
        }
        folders={folders}
        initial_folder_id={
          move_target?.kind === "folder"
            ? move_target.folder.parent_id
            : (move_target?.initial_folder_id ?? null)
        }
        excluded_folder_ids={
          move_target?.kind === "folder"
            ? new Set(
                folders
                  .filter((folder) =>
                    folder.materialized_path.startsWith(
                      move_target.folder.materialized_path,
                    ),
                  )
                  .map((folder) => folder.folder_id),
              )
            : new Set()
        }
        root_label={move_target?.kind === "folder" ? "根目录" : "未分类"}
        submitting={submitting}
        on_open_change={(open) => {
          if (!open && !submitting) set_move_target(null);
        }}
        on_submit={(folder_id) => void submit_move(folder_id)}
      />

      <AlertDialog
        open={asset_ids_to_delete.length > 0}
        onOpenChange={(open) => {
          if (!open && !submitting) set_asset_ids_to_delete([]);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia>
              <Trash2 />
            </AlertDialogMedia>
            <AlertDialogTitle>
              永久删除 {asset_ids_to_delete.length} 个视频？
            </AlertDialogTitle>
            <AlertDialogDescription>
              {delete_assets.length === 1
                ? `“${delete_assets[0]?.title}”及其转录、标记和分析成果都会永久删除。`
                : "所选视频及其转录、标记和分析成果都会永久删除。"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={submitting}
              onClick={(event) => {
                event.preventDefault();
                void confirm_asset_delete();
              }}
            >
              {submitting ? <Spinner data-icon="inline-start" /> : null}
              永久删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={folder_to_delete !== null}
        onOpenChange={(open) => {
          if (!open && !submitting) set_folder_to_delete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia>
              <Trash2 />
            </AlertDialogMedia>
            <AlertDialogTitle>递归永久删除文件夹？</AlertDialogTitle>
            <AlertDialogDescription>
              将删除 {folder_to_delete?.recursive_asset_count ?? 0}{" "}
              个视频及所有后代文件夹，此操作无法撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {folder_to_delete && folder_requires_confirmation ? (
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="library_folder_delete_confirmation">
                  输入“{folder_to_delete.name}”确认
                </FieldLabel>
                <Input
                  id="library_folder_delete_confirmation"
                  className="select-text"
                  value={folder_confirmation}
                  onChange={(event) =>
                    set_folder_confirmation(event.target.value)
                  }
                  disabled={submitting}
                />
              </Field>
            </FieldGroup>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={
                submitting ||
                Boolean(
                  folder_to_delete &&
                  folder_requires_confirmation &&
                  folder_confirmation !== folder_to_delete.name,
                )
              }
              onClick={(event) => {
                event.preventDefault();
                void confirm_folder_delete();
              }}
            >
              {submitting ? <Spinner data-icon="inline-start" /> : null}
              递归永久删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
