import { afterEach, describe, expect, it, vi } from "vitest";

import {
  analyze_asset,
  ApiError,
  create_marker,
  create_download,
  get_analysis_page_settings,
  media_url,
  probe_source,
  select_directory,
  transcribe_asset,
  update_analysis_page_settings,
  update_marker,
} from "./api";

afterEach(() => vi.restoreAllMocks());

describe("api client", () => {
  it("loads and saves analysis page settings", async () => {
    const settings = {
      asset_library_size_percent: 14,
      asset_library_collapsed: false,
      tool_panel_size_percent: 16,
      tool_panel_collapsed: false,
      open_tool_sections: ["video_information" as const],
    };
    const fetch_mock = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(settings), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(get_analysis_page_settings()).resolves.toEqual(settings);
    await expect(update_analysis_page_settings(settings)).resolves.toEqual(
      settings,
    );
    expect(fetch_mock).toHaveBeenNthCalledWith(
      1,
      "/api/page-settings/analysis",
      { signal: undefined },
    );
    expect(fetch_mock).toHaveBeenNthCalledWith(
      2,
      "/api/page-settings/analysis",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
        signal: undefined,
      },
    );
  });

  it("requests a local directory selection", async () => {
    const fetch_mock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ path: "D:\\课程" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(select_directory()).resolves.toBe("D:\\课程");
    expect(fetch_mock).toHaveBeenCalledWith("/api/directories/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: undefined,
    });
  });

  it("submits a typed download request", async () => {
    const response = [
      {
        job_id: "job-1",
        asset_id: "asset-1",
        stage: "pending",
        progress_percent: 0,
        message: "等待开始",
        error_message: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    ];
    const fetch_mock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(response), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(create_download(["https://b23.tv/test"])).resolves.toEqual(
      response,
    );
    expect(fetch_mock).toHaveBeenCalledWith("/api/downloads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source_urls: ["https://b23.tv/test"] }),
      signal: undefined,
    });
  });

  it("probes a source before creating downloads", async () => {
    const response = {
      platform: "youtube",
      is_playlist: false,
      title: null,
      entries: [
        {
          source_video_id: "vtR7cgYATdk",
          url: "https://www.youtube.com/watch?v=vtR7cgYATdk",
          title: "示例",
          duration_seconds: 30,
          uploader: "作者",
        },
      ],
      truncated: false,
      total_count: 1,
    };
    const fetch_mock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(probe_source("https://youtu.be/vtR7cgYATdk")).resolves.toEqual(
      response,
    );
    expect(fetch_mock).toHaveBeenCalledWith("/api/downloads/probe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source_url: "https://youtu.be/vtR7cgYATdk" }),
      signal: undefined,
    });
  });

  it("surfaces API detail messages", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ detail: "地址无效" }), {
        status: 422,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(create_download(["bad"])).rejects.toEqual(
      new ApiError("地址无效", 422),
    );
  });

  it("submits a marker-scoped analysis request", async () => {
    const response = {
      job_id: "job-1",
      asset_id: "asset-1",
      mode: "markers",
      marker_ids: ["marker-1"],
      capabilities: [],
      stage: "pending",
      progress_percent: 0,
      message: "等待开始",
      error_message: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
    const fetch_mock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify(response), { status: 202 }),
      );

    await expect(
      analyze_asset("asset-1", "markers", ["marker-1"]),
    ).resolves.toEqual(response);
    expect(fetch_mock).toHaveBeenCalledWith(
      "/api/media/assets/asset-1/analyze",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "markers",
          marker_ids: ["marker-1"],
          force: true,
        }),
        signal: undefined,
      },
    );
  });

  it("starts transcription independently from analysis", async () => {
    const response = {
      job_id: "job-1",
      operation: "transcription",
      stage: "pending",
    };
    const fetch_mock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify(response), { status: 202 }),
      );

    await expect(
      transcribe_asset("asset-1", {
        model: "small",
        language: "zh",
        compute_type: "int8",
      }),
    ).resolves.toEqual(response);
    expect(fetch_mock).toHaveBeenCalledWith(
      "/api/media/assets/asset-1/transcribe",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          force: false,
          model: "small",
          language: "zh",
          compute_type: "int8",
        }),
        signal: undefined,
      },
    );
  });

  it("keeps relative media paths on the current API origin", () => {
    expect(media_url("/api/media/assets/a/stream")).toBe(
      "/api/media/assets/a/stream",
    );
    expect(media_url(null)).toBeUndefined();
  });

  it("creates and updates persisted media markers", async () => {
    const marker = {
      marker_id: "marker-0123456789abcdef0123456789abcdef",
      asset_id: "01890f4c-7a2b-7cc2-98c4-dc0c0c07398f",
      time_seconds: 12.5,
      tags: ["重点"],
    };
    const fetch_mock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify(marker), { status: 201 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ...marker, tags: ["关键帧"] }), {
          status: 200,
        }),
      );

    await expect(
      create_marker(marker.asset_id, marker.time_seconds, marker.tags),
    ).resolves.toEqual(marker);
    await expect(
      update_marker(marker.asset_id, marker.marker_id, ["关键帧"]),
    ).resolves.toEqual({
      ...marker,
      tags: ["关键帧"],
    });
    expect(fetch_mock).toHaveBeenNthCalledWith(
      1,
      `/api/media/assets/${marker.asset_id}/markers`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ time_seconds: 12.5, tags: ["重点"] }),
        signal: undefined,
      },
    );
    expect(fetch_mock).toHaveBeenNthCalledWith(
      2,
      `/api/media/assets/${marker.asset_id}/markers/${marker.marker_id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags: ["关键帧"] }),
        signal: undefined,
      },
    );
  });
});
