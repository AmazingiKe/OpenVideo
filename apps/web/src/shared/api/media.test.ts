import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "./client";
import { download_subtitle_file } from "./media";

const create_object_url = vi.fn(() => "blob:subtitle-download");
const revoke_object_url = vi.fn();

describe("subtitle file downloads", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    create_object_url.mockClear();
    revoke_object_url.mockClear();
    vi.stubGlobal(
      "URL",
      class extends URL {
        static createObjectURL = create_object_url;
        static revokeObjectURL = revoke_object_url;
      },
    );
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("downloads UTF-8 filenames through a temporary link and releases its URL", async () => {
    const fetch_mock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("WEBVTT\n\n课程字幕", {
        headers: {
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent("课程字幕.vtt")}`,
        },
      }),
    );
    const click_mock = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        expect(this.isConnected).toBe(true);
        expect(this.download).toBe("课程字幕.vtt");
        expect(this.href).toBe("blob:subtitle-download");
      });
    const request = new AbortController();

    await download_subtitle_file("asset/test", "vtt", request.signal);

    expect(fetch_mock).toHaveBeenCalledWith(
      "/api/media/assets/asset%2Ftest/subtitle-file?format=vtt",
      { signal: request.signal },
    );
    expect(create_object_url).toHaveBeenCalledWith(expect.any(Blob));
    expect(click_mock).toHaveBeenCalledOnce();
    expect(document.querySelector("a[download]")).toBeNull();
    expect(revoke_object_url).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revoke_object_url).toHaveBeenCalledWith("blob:subtitle-download");
  });

  it("falls back to the asset filename when an encoded name is invalid", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("字幕", {
        headers: {
          "Content-Disposition": "attachment; filename*=UTF-8''%invalid",
        },
      }),
    );
    const click_mock = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        expect(this.download).toBe("asset-123.txt");
      });
    await download_subtitle_file("asset-123", "txt");
    expect(click_mock).toHaveBeenCalledOnce();
  });

  it.each([404, 409, 422])(
    "shows server errors for status %s without creating a download",
    async (status) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ detail: "字幕暂时不可用" }), { status }),
      );
      await expect(download_subtitle_file("asset-123", "srt")).rejects.toEqual(
        new ApiError("字幕暂时不可用", status),
      );
      expect(create_object_url).not.toHaveBeenCalled();
    },
  );

  it("preserves the status when an error body is not JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Service unavailable", { status: 503 }),
    );
    await expect(download_subtitle_file("asset-123", "srt")).rejects.toEqual(
      new ApiError("请求失败（503）", 503),
    );
  });

  it("does not download a stale response after the request was aborted", async () => {
    const request = new AbortController();
    const response = new Response("字幕");
    vi.spyOn(response, "blob").mockImplementation(async () => {
      request.abort();
      return new Blob(["字幕"]);
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    await expect(
      download_subtitle_file("asset-123", "txt", request.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(create_object_url).not.toHaveBeenCalled();
  });

  it("still removes the link and releases its URL if the browser rejects the download", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("字幕"));
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {
      throw new Error("下载失败");
    });
    await expect(download_subtitle_file("asset-123", "txt")).rejects.toThrow(
      "下载失败",
    );
    expect(document.querySelector("a[download]")).toBeNull();
    vi.runAllTimers();
    expect(revoke_object_url).toHaveBeenCalledWith("blob:subtitle-download");
  });
});
