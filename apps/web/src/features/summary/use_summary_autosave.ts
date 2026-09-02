import { useCallback, useEffect, useRef, useState } from "react";

import { update_summary_document } from "@/shared/api";
import type { SummaryDocument, SummarySaveMetadata } from "@/shared/types";
import {
  create_summary_draft_id,
  delete_other_summary_drafts,
  delete_summary_draft,
  load_latest_summary_draft,
  save_summary_draft,
  summary_draft_content_digest,
  type SummaryDraft,
} from "./summary_draft_storage";
import {
  create_summary_save_metadata,
  SUMMARY_CLIENT_ID,
} from "./summary_save_metadata";

const AUTO_SAVE_DELAY_MS = 500;
const MANUAL_SAVE_NOTICE_MS = 2_000;
const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

export type SummaryAutosaveStatus =
  | "saved"
  | "pending"
  | "saving"
  | "local_only"
  | "failed"
  | "recovered"
  | "confirmed";

type SaveRequest = {
  document_id: string;
  title: string;
  markdown: string;
  content_version: number;
  metadata: SummarySaveMetadata;
};

type UseSummaryAutosaveOptions = {
  asset_id: string | null;
  document: SummaryDocument | null;
  on_document_saved: (document: SummaryDocument) => void;
  on_recovery_target: (document_id: string) => boolean;
  on_local_draft_error?: (message: string) => void;
};

export function use_summary_autosave({
  asset_id,
  document,
  on_document_saved,
  on_recovery_target,
  on_local_draft_error,
}: UseSummaryAutosaveOptions) {
  const [title, set_title] = useState("");
  const [markdown, set_markdown] = useState("");
  const [dirty, set_dirty] = useState(false);
  const [status, set_status] = useState<SummaryAutosaveStatus>("saved");
  const active_document_ref = useRef<SummaryDocument | null>(null);
  const title_ref = useRef("");
  const markdown_ref = useRef("");
  const dirty_ref = useRef(false);
  const content_version_ref = useRef(0);
  const confirmed_version_ref = useRef(0);
  const draft_id_ref = useRef(create_summary_draft_id());
  const draft_write_ref = useRef<Promise<void>>(Promise.resolve());
  const save_request_ref = useRef<SaveRequest | null>(null);
  const save_promise_ref = useRef<Promise<boolean> | null>(null);
  const retry_attempt_ref = useRef(0);
  const recovered_draft_ref = useRef<SummaryDraft | null>(null);
  const recovery_asset_ref = useRef<string | null>(null);
  const manual_notice_timeout_ref = useRef<number | null>(null);
  const on_document_saved_ref = useRef(on_document_saved);
  const on_recovery_target_ref = useRef(on_recovery_target);
  const on_local_draft_error_ref = useRef(on_local_draft_error);

  on_document_saved_ref.current = on_document_saved;
  on_recovery_target_ref.current = on_recovery_target;
  on_local_draft_error_ref.current = on_local_draft_error;

  const update_dirty = useCallback((next_dirty: boolean) => {
    dirty_ref.current = next_dirty;
    set_dirty(next_dirty);
  }, []);

  const enqueue_draft_write = useCallback((draft: SummaryDraft) => {
    draft_write_ref.current = draft_write_ref.current
      .catch(() => undefined)
      .then(() => save_summary_draft(draft))
      .catch(() => {
        set_status("failed");
        on_local_draft_error_ref.current?.(
          "本机草稿写入失败，请先复制当前内容后再关闭页面。",
        );
      });
  }, []);

  const persist_current_draft = useCallback(() => {
    const active_document = active_document_ref.current;
    if (!active_document) return;
    const current_title = title_ref.current;
    const current_markdown = markdown_ref.current;
    enqueue_draft_write({
      draft_id: draft_id_ref.current,
      asset_id: active_document.asset_id,
      document_id: active_document.document_id,
      client_id: SUMMARY_CLIENT_ID,
      title: current_title,
      markdown: current_markdown,
      updated_at: Date.now(),
      content_digest: summary_draft_content_digest(
        current_title,
        current_markdown,
      ),
      confirmed_sequence: confirmed_version_ref.current,
    });
  }, [enqueue_draft_write]);

  const apply_recovered_draft = useCallback(
    (draft: SummaryDraft, active_document: SummaryDocument) => {
      if (draft.document_id !== active_document.document_id) return;
      recovered_draft_ref.current = null;
      draft_id_ref.current = draft.draft_id;
      title_ref.current = draft.title;
      markdown_ref.current = draft.markdown;
      content_version_ref.current = 1;
      confirmed_version_ref.current = 0;
      set_title(draft.title);
      set_markdown(draft.markdown);
      update_dirty(true);
      set_status("recovered");
      void delete_other_summary_drafts(draft.asset_id, draft.draft_id);
    },
    [update_dirty],
  );

  useEffect(() => {
    if (!asset_id || !document || recovery_asset_ref.current === asset_id)
      return;
    recovery_asset_ref.current = asset_id;
    let cancelled = false;
    void load_latest_summary_draft(asset_id)
      .then((draft) => {
        if (cancelled || !draft) return;
        recovered_draft_ref.current = draft;
        if (draft.document_id === active_document_ref.current?.document_id) {
          apply_recovered_draft(draft, active_document_ref.current);
          return;
        }
        if (!on_recovery_target_ref.current(draft.document_id)) {
          recovered_draft_ref.current = null;
          void delete_summary_draft(draft.draft_id);
        }
      })
      .catch(() => {
        on_local_draft_error_ref.current?.(
          "本机草稿读取失败，已使用服务器内容。",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [apply_recovered_draft, asset_id, document]);

  useEffect(() => {
    if (!document) {
      active_document_ref.current = null;
      title_ref.current = "";
      markdown_ref.current = "";
      set_title("");
      set_markdown("");
      update_dirty(false);
      set_status("saved");
      return;
    }
    const document_changed =
      active_document_ref.current?.document_id !== document.document_id;
    if (document_changed) {
      active_document_ref.current = document;
      draft_id_ref.current = create_summary_draft_id();
      save_request_ref.current = null;
      content_version_ref.current = 0;
      confirmed_version_ref.current = 0;
      title_ref.current = document.title;
      markdown_ref.current = document.markdown;
      set_title(document.title);
      set_markdown(document.markdown);
      update_dirty(false);
      set_status("saved");
      const recovered = recovered_draft_ref.current;
      if (recovered?.document_id === document.document_id) {
        apply_recovered_draft(recovered, document);
      }
      return;
    }
    active_document_ref.current = document;
    if (!dirty_ref.current) {
      title_ref.current = document.title;
      markdown_ref.current = document.markdown;
      set_title(document.title);
      set_markdown(document.markdown);
    }
  }, [apply_recovered_draft, document, update_dirty]);

  const flush = useCallback(
    async (manual = false): Promise<boolean> => {
      if (save_promise_ref.current) return save_promise_ref.current;
      if (!dirty_ref.current) {
        if (manual)
          show_manual_confirmation(set_status, manual_notice_timeout_ref);
        return true;
      }

      const drain = async (): Promise<boolean> => {
        await draft_write_ref.current;
        while (confirmed_version_ref.current < content_version_ref.current) {
          const active_document = active_document_ref.current;
          if (!active_document) return false;
          const request =
            save_request_ref.current ??
            create_save_request(
              active_document,
              title_ref.current,
              markdown_ref.current,
              content_version_ref.current,
            );
          save_request_ref.current = request;
          set_status("saving");
          try {
            const updated = await update_summary_document(
              request.document_id,
              { title: request.title, markdown: request.markdown },
              request.metadata,
            );
            on_document_saved_ref.current(updated);
            const response_matches =
              updated.title === request.title &&
              updated.markdown === normalize_markdown(request.markdown);
            save_request_ref.current = null;
            if (!response_matches) {
              continue;
            }
            confirmed_version_ref.current = Math.max(
              confirmed_version_ref.current,
              request.content_version,
            );
            retry_attempt_ref.current = 0;
            const unchanged =
              content_version_ref.current === request.content_version &&
              active_document_ref.current?.document_id === request.document_id;
            if (unchanged) {
              active_document_ref.current = updated;
              title_ref.current = updated.title;
              markdown_ref.current = updated.markdown;
              set_title(updated.title);
              set_markdown(updated.markdown);
              update_dirty(false);
              draft_write_ref.current = draft_write_ref.current
                .catch(() => undefined)
                .then(() => delete_summary_draft(draft_id_ref.current));
            }
          } catch {
            retry_attempt_ref.current = Math.min(
              retry_attempt_ref.current + 1,
              RETRY_DELAYS_MS.length - 1,
            );
            set_status(
              typeof navigator !== "undefined" && !navigator.onLine
                ? "local_only"
                : "failed",
            );
            return false;
          }
        }
        if (manual) {
          show_manual_confirmation(set_status, manual_notice_timeout_ref);
        } else {
          set_status("saved");
        }
        return true;
      };

      const promise = drain().finally(() => {
        if (save_promise_ref.current === promise)
          save_promise_ref.current = null;
      });
      save_promise_ref.current = promise;
      return promise;
    },
    [update_dirty],
  );

  const change_title = useCallback(
    (next_title: string) => {
      title_ref.current = next_title;
      set_title(next_title);
      content_version_ref.current += 1;
      update_dirty(true);
      set_status("pending");
      persist_current_draft();
    },
    [persist_current_draft, update_dirty],
  );

  const change_markdown = useCallback(
    (next_markdown: string) => {
      markdown_ref.current = next_markdown;
      set_markdown(next_markdown);
      content_version_ref.current += 1;
      update_dirty(true);
      set_status("pending");
      persist_current_draft();
    },
    [persist_current_draft, update_dirty],
  );

  useEffect(() => {
    if (!dirty) return;
    const failed = status === "failed" || status === "local_only";
    const delay = failed
      ? RETRY_DELAYS_MS[retry_attempt_ref.current]
      : AUTO_SAVE_DELAY_MS;
    const timeout = window.setTimeout(() => void flush(), delay);
    return () => window.clearTimeout(timeout);
  }, [dirty, flush, markdown, status, title]);

  useEffect(() => {
    const manual_notice_timeout = manual_notice_timeout_ref;
    const handle_keydown = (event: KeyboardEvent) => {
      if (
        !(event.ctrlKey || event.metaKey) ||
        event.key.toLowerCase() !== "s"
      ) {
        return;
      }
      event.preventDefault();
      void flush(true);
    };
    const handle_online = () => void flush();
    window.addEventListener("keydown", handle_keydown);
    window.addEventListener("online", handle_online);
    return () => {
      window.removeEventListener("keydown", handle_keydown);
      window.removeEventListener("online", handle_online);
      if (manual_notice_timeout.current !== null) {
        window.clearTimeout(manual_notice_timeout.current);
      }
    };
  }, [flush]);

  const retry = useCallback(() => void flush(), [flush]);
  const has_unsaved_changes = useCallback(() => dirty_ref.current, []);

  return {
    title,
    markdown,
    dirty,
    status,
    change_title,
    change_markdown,
    flush,
    retry,
    has_unsaved_changes,
  };
}

function create_save_request(
  document: SummaryDocument,
  title: string,
  markdown: string,
  content_version: number,
): SaveRequest {
  return {
    document_id: document.document_id,
    title: title.trim() || document.title,
    markdown,
    content_version,
    metadata: create_summary_save_metadata(),
  };
}

function normalize_markdown(markdown: string): string {
  const trimmed = markdown.trimEnd();
  return trimmed ? `${trimmed}\n` : "";
}

function show_manual_confirmation(
  set_status: (status: SummaryAutosaveStatus) => void,
  timeout_ref: { current: number | null },
) {
  if (timeout_ref.current !== null) window.clearTimeout(timeout_ref.current);
  set_status("confirmed");
  timeout_ref.current = window.setTimeout(() => {
    set_status("saved");
    timeout_ref.current = null;
  }, MANUAL_SAVE_NOTICE_MS);
}
