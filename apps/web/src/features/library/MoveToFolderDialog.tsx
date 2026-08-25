import { type FormEvent, useEffect, useState } from "react";
import { FolderInput } from "lucide-react";

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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import type { LibraryFolder } from "@/shared/types";

const ROOT_VALUE = "__root__";

type MoveToFolderDialogProps = {
  open: boolean;
  title: string;
  description: string;
  folders: LibraryFolder[];
  initial_folder_id: string | null;
  excluded_folder_ids?: Set<string>;
  root_label: string;
  submitting: boolean;
  on_open_change: (open: boolean) => void;
  on_submit: (folder_id: string | null) => void;
};

export function MoveToFolderDialog({
  open,
  title,
  description,
  folders,
  initial_folder_id,
  excluded_folder_ids = new Set(),
  root_label,
  submitting,
  on_open_change,
  on_submit,
}: MoveToFolderDialogProps) {
  const [folder_id, set_folder_id] = useState<string | null>(initial_folder_id);

  useEffect(() => set_folder_id(initial_folder_id), [initial_folder_id, open]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    on_submit(folder_id);
  }

  return (
    <Dialog open={open} onOpenChange={on_open_change}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <FieldGroup>
            <Field data-disabled={submitting}>
              <FieldLabel htmlFor="move_to_folder">目标位置</FieldLabel>
              <Select
                value={folder_id ?? ROOT_VALUE}
                onValueChange={(value) =>
                  set_folder_id(value === ROOT_VALUE ? null : value)
                }
                disabled={submitting}
              >
                <SelectTrigger id="move_to_folder" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper">
                  <SelectGroup>
                    <SelectItem value={ROOT_VALUE}>{root_label}</SelectItem>
                    {folders
                      .filter(
                        (folder) => !excluded_folder_ids.has(folder.folder_id),
                      )
                      .map((folder) => (
                        <SelectItem
                          key={folder.folder_id}
                          value={folder.folder_id}
                        >
                          {folder_path_label(folder, folders)}
                        </SelectItem>
                      ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={submitting}
              onClick={() => on_open_change(false)}
            >
              取消
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <FolderInput data-icon="inline-start" />
              )}
              移动
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function folder_path_label(
  folder: LibraryFolder,
  folders: LibraryFolder[],
): string {
  const folder_by_id = new Map(
    folders.map((candidate) => [candidate.folder_id, candidate]),
  );
  const names = [folder.name];
  let parent_id = folder.parent_id;
  while (parent_id) {
    const parent = folder_by_id.get(parent_id);
    if (!parent) break;
    names.unshift(parent.name);
    parent_id = parent.parent_id;
  }
  return names.join(" / ");
}
