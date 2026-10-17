import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RESOURCE_QUERY_KEYS } from "@/app/query_cache";
import { use_media_import_tasks } from "@/app/use_media_import_tasks";
import type { TaskRecord } from "@/features/workbench/tasks";
import { import_local_media } from "@/shared/api";
import type { MediaAsset } from "@/shared/types";

const library_identity = vi.hoisted(() => ({ value: "library-import" }));
vi.mock("@/app/library", () => ({
  use_library_identity: () => library_identity.value,
}));
vi.mock("@/shared/api", () => ({ import_local_media: vi.fn() }));

type PendingImport = {
  file: File;
  options: Parameters<typeof import_local_media>[1];
  resolve: (asset: MediaAsset) => void;
  reject: (error: Error) => void;
};
let requests: PendingImport[];

beforeEach(() => {
  vi.clearAllMocks();
  library_identity.value = "library-import";
  requests = [];
  vi.mocked(import_local_media).mockImplementation(
    (file, options) =>
      new Promise((resolve, reject) => {
        requests.push({ file, options, resolve, reject });
        options.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("已停止", "AbortError")),
          { once: true },
        );
      }),
  );
});

describe("use_media_import_tasks", () => {
  it("accepts more drops while importing, skips active duplicates, and keeps other files moving after one fails", async () => {
    const { result, records, query_client } = render_imports();
    const first = new File(["one"], "课程一.mp4", { lastModified: 100 });
    const second = new File(["two"], "课程二.mp4");
    act(() => {
      result.current.enqueue_media_imports([
        first,
        second,
        new File(["three"], "课程三.mp4"),
      ]);
    });
    expect(requests).toHaveLength(2);
    expect(
      [...records.values()].filter((task) => task.stage === "queued"),
    ).toHaveLength(1);
    let submission!: ReturnType<typeof result.current.enqueue_media_imports>;
    act(() => {
      submission = result.current.enqueue_media_imports([
        first,
        new File(["four"], "课程四.mp4"),
        new File([], "说明.txt"),
      ]);
    });
    expect(submission).toEqual({ queued: 1, duplicates: 1, unsupported: 1 });
    expect(records.size).toBe(4);
    await act(async () => requests[0].reject(new Error("文件损坏")));
    expect(requests).toHaveLength(3);
    expect(
      [...records.values()].find((task) => task.name === first.name),
    ).toMatchObject({
      stage: "failed",
      error_message: "文件损坏",
      retry_available: true,
    });
    const asset = { asset_id: "asset-second", title: "课程二" } as MediaAsset;
    await act(async () => requests[1].resolve(asset));
    expect(query_client.getQueryData(RESOURCE_QUERY_KEYS.assets)).toEqual([
      asset,
    ]);
    expect(requests).toHaveLength(4);
    expect(
      requests.every(
        (request) => request.options.library_id === "library-import",
      ),
    ).toBe(true);
  });

  it("reports upload progress separately from server processing and can stop queued or active files", async () => {
    const { result, records } = render_imports();
    act(() =>
      result.current.enqueue_media_imports([
        new File(["one"], "一.mp4"),
        new File(["two"], "二.mp4"),
        new File(["three"], "三.mp4"),
      ]),
    );
    const first_task = [...records.values()].find(
      (task) => task.name === "一.mp4",
    )!;
    const queued_task = [...records.values()].find(
      (task) => task.name === "三.mp4",
    )!;
    act(() => requests[0].options.on_progress?.(5, 10));
    expect(records.get(first_task.task_id)).toMatchObject({
      stage: "uploading",
      progress_percent: 50,
      progress_known: true,
    });
    act(() => requests[0].options.on_progress?.(10, 10));
    expect(records.get(first_task.task_id)).toMatchObject({
      stage: "processing",
      progress_known: false,
    });
    act(() => result.current.cancel_media_import(queued_task.task_id));
    expect(records.get(queued_task.task_id)).toMatchObject({
      stage: "cancelled",
      retry_available: true,
    });
    await act(async () =>
      result.current.cancel_media_import(first_task.task_id),
    );
    expect(requests[0].options.signal?.aborted).toBe(true);
    expect(records.get(first_task.task_id)).toMatchObject({
      stage: "cancelled",
      error_message: null,
    });
    expect(requests).toHaveLength(2);
    act(() => result.current.retry_media_import(first_task.task_id));
    expect(requests).toHaveLength(3);
    expect(requests[2].file).toBe(requests[0].file);
  });

  it("stops pending uploads and discards the old queue when its library session unmounts", async () => {
    const { result, records, unmount } = render_imports();
    act(() =>
      result.current.enqueue_media_imports([
        new File([], "一.mp4"),
        new File([], "二.mp4"),
        new File([], "三.mp4"),
      ]),
    );
    const record_count = records.size;
    unmount();
    expect(requests.every((request) => request.options.signal?.aborted)).toBe(
      true,
    );
    await act(async () => Promise.resolve());
    expect(requests).toHaveLength(2);
    expect(records.size).toBe(record_count);
  });
});

function render_imports() {
  const records = new Map<string, TaskRecord>();
  const record_task = (task: TaskRecord) => records.set(task.task_id, task);
  const query_client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const hook = renderHook(() => use_media_import_tasks(record_task), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={query_client}>
        {children}
      </QueryClientProvider>
    ),
  });
  return { ...hook, records, query_client };
}
