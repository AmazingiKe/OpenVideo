import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, create_download, media_url } from "./api";


afterEach(() => vi.restoreAllMocks());

describe("api client", () => {
  it("submits a typed download request", async () => {
    const response = {
      job_id: "job-1",
      asset_id: "asset-1",
      stage: "pending",
      progress_percent: 0,
      message: "等待开始",
      error_message: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
    const fetch_mock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(response), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(create_download("https://b23.tv/test")).resolves.toEqual(response);
    expect(fetch_mock).toHaveBeenCalledWith("/api/downloads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source_url: "https://b23.tv/test" }),
    });
  });

  it("surfaces API detail messages", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ detail: "地址无效" }), {
        status: 422,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(create_download("bad")).rejects.toEqual(new ApiError("地址无效", 422));
  });

  it("keeps relative media paths on the current API origin", () => {
    expect(media_url("/api/media/assets/a/stream")).toBe("/api/media/assets/a/stream");
    expect(media_url(null)).toBeUndefined();
  });
});
