import { type FormEvent, useState } from "react";

import {
  create_folder,
  delete_asset,
  delete_folder,
  move_assets,
  move_folder,
  rename_folder,
} from "@/shared/api";
import { error_message } from "@/shared/errors";
import type { LibraryFolder, MediaAsset } from "@/shared/types";
import type { FolderEditor, MoveTarget } from "./LibraryBrowserDialogs";
import { has_descendants } from "./library_browser_geometry";

type LibraryBrowserMutationOptions = {
  assets: MediaAsset[];
  clear_selection: () => void;
  current_folder_id: string | null;
  folders: LibraryFolder[];
  refresh_library: () => Promise<void>;
  set_current_folder_id: (folder_id: string | null) => void;
  set_operation_error: (message: string | null) => void;
};

export function use_library_browser_mutations({
  assets,
  clear_selection,
  current_folder_id,
  folders,
  refresh_library,
  set_current_folder_id,
  set_operation_error,
}: LibraryBrowserMutationOptions) {
  const [folder_editor, set_folder_editor] = useState<FolderEditor | null>(
    null,
  );
  const [folder_name, set_folder_name] = useState("");
  const [move_target, set_move_target] = useState<MoveTarget>(null);
  const [asset_ids_to_delete, set_asset_ids_to_delete] = useState<string[]>([]);
  const [folder_to_delete, set_folder_to_delete] =
    useState<LibraryFolder | null>(null);
  const [folder_confirmation, set_folder_confirmation] = useState("");
  const [submitting, set_submitting] = useState(false);

  const delete_assets = assets.filter((asset) =>
    asset_ids_to_delete.includes(asset.asset_id),
  );
  const folder_requires_confirmation = Boolean(
    folder_to_delete &&
    (folder_to_delete.recursive_asset_count > 0 ||
      has_descendants(folder_to_delete, folders)),
  );

  function open_folder_editor(editor: FolderEditor) {
    set_folder_editor(editor);
    set_folder_name(editor.folder?.name ?? "");
    set_operation_error(null);
  }

  async function submit_folder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!folder_editor || !folder_name.trim()) return;
    set_submitting(true);
    set_operation_error(null);
    try {
      if (folder_editor.mode === "create") {
        const created = await create_folder(
          folder_name.trim(),
          folder_editor.parent_id,
        );
        set_current_folder_id(created.folder_id);
      } else if (folder_editor.folder) {
        await rename_folder(folder_editor.folder.folder_id, folder_name.trim());
      }
      set_folder_editor(null);
      await refresh_library();
    } catch (error) {
      set_operation_error(error_message(error));
    } finally {
      set_submitting(false);
    }
  }

  function open_assets_move(asset_ids: string[]) {
    const moving_assets = assets.filter((asset) =>
      asset_ids.includes(asset.asset_id),
    );
    const source_folder_ids = new Set(
      moving_assets.map((asset) => asset.folder_id ?? null),
    );
    set_move_target({
      kind: "assets",
      asset_ids,
      initial_folder_id:
        source_folder_ids.size === 1
          ? (source_folder_ids.values().next().value ?? null)
          : null,
    });
    set_operation_error(null);
  }

  async function submit_move(folder_id: string | null) {
    if (!move_target) return;
    set_submitting(true);
    set_operation_error(null);
    try {
      if (move_target.kind === "assets") {
        await move_assets(move_target.asset_ids, folder_id);
        clear_selection();
      } else {
        await move_folder(move_target.folder.folder_id, folder_id);
      }
      set_move_target(null);
      await refresh_library();
    } catch (error) {
      set_operation_error(error_message(error));
    } finally {
      set_submitting(false);
    }
  }

  async function move_assets_to_folder(asset_ids: string[], folder_id: string) {
    set_submitting(true);
    set_operation_error(null);
    try {
      await move_assets(asset_ids, folder_id);
      clear_selection();
      await refresh_library();
    } catch (error) {
      set_operation_error(error_message(error));
    } finally {
      set_submitting(false);
    }
  }

  async function confirm_asset_delete() {
    if (asset_ids_to_delete.length === 0) return;
    set_submitting(true);
    set_operation_error(null);
    try {
      await Promise.all(
        asset_ids_to_delete.map((asset_id) => delete_asset(asset_id)),
      );
      set_asset_ids_to_delete([]);
      clear_selection();
      await refresh_library();
    } catch (error) {
      set_operation_error(error_message(error));
    } finally {
      set_submitting(false);
    }
  }

  async function confirm_folder_delete() {
    if (!folder_to_delete) return;
    set_submitting(true);
    set_operation_error(null);
    try {
      await delete_folder(
        folder_to_delete.folder_id,
        folder_requires_confirmation ? folder_confirmation : null,
      );
      const current_folder_deleted =
        current_folder_id === folder_to_delete.folder_id;
      const current_folder_descends_from_deleted = folders.some(
        (folder) =>
          folder.folder_id === current_folder_id &&
          folder.materialized_path.startsWith(
            folder_to_delete.materialized_path,
          ),
      );
      if (current_folder_deleted || current_folder_descends_from_deleted) {
        set_current_folder_id(null);
      }
      set_folder_to_delete(null);
      set_folder_confirmation("");
      clear_selection();
      await refresh_library();
    } catch (error) {
      set_operation_error(error_message(error));
    } finally {
      set_submitting(false);
    }
  }

  return {
    asset_ids_to_delete,
    confirm_asset_delete,
    confirm_folder_delete,
    delete_assets,
    folder_confirmation,
    folder_editor,
    folder_name,
    folder_requires_confirmation,
    folder_to_delete,
    move_assets_to_folder,
    move_target,
    open_assets_move,
    open_folder_editor,
    set_asset_ids_to_delete,
    set_folder_confirmation,
    set_folder_editor,
    set_folder_name,
    set_folder_to_delete,
    set_move_target,
    submit_folder,
    submit_move,
    submitting,
  };
}
