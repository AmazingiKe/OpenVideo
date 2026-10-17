import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "./client";
import { import_local_media } from "./library";

class UploadRequest {
  static requests: UploadRequest[] = [];
  status = 201;
  responseText = JSON.stringify({ asset_id: "asset-import", title: "课程" });
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  upload = {
    onprogress: null as ((event: ProgressEvent) => void) | null,
    onload: null as (() => void) | null,
  };
  open = vi.fn();
  send = vi.fn();
  abort = vi.fn(() => this.onabort?.());
  constructor() {
    UploadRequest.requests.push(this);
  }
}

beforeEach(() => {
  UploadRequest.requests = [];
  vi.stubGlobal("XMLHttpRequest", UploadRequest);
});
afterEach(() => vi.unstubAllGlobals());

describe("import_local_media", () => {
  it("uploads multipart media with its original library identity and reports byte progress", async () => {
    const file = new File(["video"], "产品演示.mp4", { type: "video/mp4" });
    const on_progress = vi.fn();
    const request = import_local_media(file, {
      library_id: "library-import",
      on_progress,
    });
    const upload = UploadRequest.requests[0];
    expect(upload.open).toHaveBeenCalledWith(
      "POST",
      "/api/media/assets/import",
    );
    const form = upload.send.mock.calls[0][0] as FormData;
    expect(form.get("library_id")).toBe("library-import");
    expect((form.get("file") as File).name).toBe(file.name);
    upload.upload.onprogress?.(
      new ProgressEvent("progress", {
        loaded: 5,
        total: 10,
        lengthComputable: true,
      }),
    );
    expect(on_progress).toHaveBeenCalledWith(5, 10);
    upload.upload.onload?.();
    expect(on_progress).toHaveBeenLastCalledWith(file.size, file.size);
    upload.onload?.();
    await expect(request).resolves.toMatchObject({ asset_id: "asset-import" });
    expect(upload.upload.onprogress).toBeNull();
  });

  it("aborts transport when explicitly stopped and does not start an already cancelled upload", async () => {
    const controller = new AbortController();
    const request = import_local_media(new File(["video"], "课程.mp4"), {
      library_id: "library-import",
      signal: controller.signal,
    });
    const rejection = expect(request).rejects.toMatchObject({
      name: "AbortError",
    });
    controller.abort();
    await rejection;
    expect(UploadRequest.requests[0].abort).toHaveBeenCalledOnce();
    await expect(
      import_local_media(new File([], "课程.mp4"), {
        library_id: "library-import",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(UploadRequest.requests).toHaveLength(1);
  });

  it("keeps server error messages and status codes for failed imports", async () => {
    const request = import_local_media(new File([], "课程.mp4"), {
      library_id: "library-import",
    });
    const upload = UploadRequest.requests[0];
    upload.status = 409;
    upload.responseText = JSON.stringify({
      detail: "资料库已切换，请重新导入",
    });
    upload.onload?.();
    await expect(request).rejects.toEqual(
      new ApiError("资料库已切换，请重新导入", 409),
    );
  });
});
