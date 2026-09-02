import { uuid7 } from "@/shared/identifiers";

const DATABASE_NAME = "openvideo-summary-drafts";
const DATABASE_VERSION = 1;
const STORE_NAME = "drafts";
const ASSET_INDEX_NAME = "asset_id";
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const SECOND_HASH_SEED = 0x9e3779b9;
const SECOND_HASH_PRIME = 0x85ebca6b;

export type SummaryDraft = {
  draft_id: string;
  asset_id: string;
  document_id: string;
  client_id: string;
  title: string;
  markdown: string;
  updated_at: number;
  content_digest: string;
  confirmed_sequence: number;
};

let database_promise: Promise<IDBDatabase | null> | null = null;

export function create_summary_draft_id(): string {
  return `summary-draft-${uuid7().replaceAll("-", "")}`;
}

export function summary_draft_content_digest(
  title: string,
  markdown: string,
): string {
  const content = `${title}\u0000${markdown}`;
  let first = FNV_OFFSET_BASIS;
  let second = SECOND_HASH_SEED;
  for (let index = 0; index < content.length; index += 1) {
    const code = content.charCodeAt(index);
    first = Math.imul(first ^ code, FNV_PRIME) >>> 0;
    second = Math.imul(second ^ code, SECOND_HASH_PRIME) >>> 0;
  }
  const value =
    first.toString(16).padStart(8, "0") + second.toString(16).padStart(8, "0");
  return value.repeat(4);
}

export async function save_summary_draft(draft: SummaryDraft): Promise<void> {
  const database = await open_database();
  if (!database) return;
  await transaction_complete(database, "readwrite", (store) => {
    store.put(draft);
  });
}

export async function delete_summary_draft(draft_id: string): Promise<void> {
  const database = await open_database();
  if (!database) return;
  await transaction_complete(database, "readwrite", (store) => {
    store.delete(draft_id);
  });
}

export async function load_latest_summary_draft(
  asset_id: string,
): Promise<SummaryDraft | null> {
  const drafts = await load_asset_drafts(asset_id);
  const valid: SummaryDraft[] = [];
  for (const draft of drafts) {
    if (
      is_summary_draft(draft) &&
      draft.content_digest ===
        summary_draft_content_digest(draft.title, draft.markdown)
    ) {
      valid.push(draft);
    } else if (is_draft_identifier(draft)) {
      await delete_summary_draft(draft.draft_id);
    }
  }
  return (
    valid.sort((left, right) => right.updated_at - left.updated_at)[0] ?? null
  );
}

export async function delete_other_summary_drafts(
  asset_id: string,
  keep_draft_id: string,
): Promise<void> {
  const drafts = await load_asset_drafts(asset_id);
  await Promise.all(
    drafts
      .filter(
        (draft): draft is SummaryDraft =>
          is_summary_draft(draft) && draft.draft_id !== keep_draft_id,
      )
      .map((draft) => delete_summary_draft(draft.draft_id)),
  );
}

async function load_asset_drafts(asset_id: string): Promise<unknown[]> {
  const database = await open_database();
  if (!database) return [];
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction
      .objectStore(STORE_NAME)
      .index(ASSET_INDEX_NAME)
      .getAll(IDBKeyRange.only(asset_id));
    request.onsuccess = () => resolve(request.result as unknown[]);
    request.onerror = () =>
      reject(request.error ?? new Error("读取本地草稿失败"));
  });
}

function open_database(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  if (database_promise) return database_promise;
  database_promise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      const store = database.objectStoreNames.contains(STORE_NAME)
        ? request.transaction!.objectStore(STORE_NAME)
        : database.createObjectStore(STORE_NAME, { keyPath: "draft_id" });
      if (!store.indexNames.contains(ASSET_INDEX_NAME)) {
        store.createIndex(ASSET_INDEX_NAME, "asset_id");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      database_promise = null;
      reject(request.error ?? new Error("打开本地草稿数据库失败"));
    };
  });
  return database_promise;
}

function transaction_complete(
  database: IDBDatabase,
  mode: IDBTransactionMode,
  mutate: (store: IDBObjectStore) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    mutate(transaction.objectStore(STORE_NAME));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("写入本地草稿失败"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("本地草稿事务已中止"));
  });
}

function is_draft_identifier(value: unknown): value is { draft_id: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "draft_id" in value &&
    typeof value.draft_id === "string"
  );
}

function is_summary_draft(value: unknown): value is SummaryDraft {
  if (!is_draft_identifier(value)) return false;
  const draft = value as Record<string, unknown>;
  return (
    typeof draft.asset_id === "string" &&
    typeof draft.document_id === "string" &&
    typeof draft.client_id === "string" &&
    typeof draft.title === "string" &&
    typeof draft.markdown === "string" &&
    typeof draft.updated_at === "number" &&
    typeof draft.content_digest === "string" &&
    typeof draft.confirmed_sequence === "number"
  );
}
