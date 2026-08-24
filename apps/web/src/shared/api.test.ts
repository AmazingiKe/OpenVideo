import { afterEach, describe, expect, it, vi } from "vitest";

import {
  analyze_asset,
  ApiError,
  create_transcript_correction,
  create_marker_agent_message,
  create_marker_agent_session,
  create_marker,
  create_download,
  create_download_account_login_session,
  delete_download_account_login_session,
  delete_download_account,
  download_transcription_model,
  get_download_accounts,
  get_download_account_login_session,
  get_transcription_model_download,
  get_markers_page_settings,
  import_download_account_from_browser,
  list_marker_agent_sessions,
  list_transcription_models,
  media_url,
  probe_source,
  resolve_marker_proposal,
  save_download_account,
  respond_to_agent_job,
  select_directory,
  test_ai_model,
  test_download_account,
  transcribe_asset,
  update_markers_page_settings,
  update_marker,
} from "./api";

afterEach(() => vi.restoreAllMocks());

describe("api client", () => {
  it("loads the shared transcription model catalog", async () => {
    const models = [
      {
        engine: "faster-whisper",
        model: "large-v3-turbo",
        integration_status: "available",
      },
    ];
    const fetch_mock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify(models), { status: 200 }));

    await expect(list_transcription_models()).resolves.toEqual(models);
    expect(fetch_mock).toHaveBeenCalledWith("/api/transcription/models", {
      signal: undefined,
    });
  });

  it("starts and reads a transcription model download", async () => {
    const job = {
      job_id: "model-download-0198d12345677890abcdef1234567890",
      stage: "pending",
    };
    const fetch_mock = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(job), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await download_transcription_model("faster-whisper", "large-v3-turbo");
    expect(fetch_mock).toHaveBeenLastCalledWith(
      "/api/transcription/models/faster-whisper/large-v3-turbo/downloads",
      { method: "POST", signal: undefined },
    );

    await get_transcription_model_download(job.job_id);
    expect(fetch_mock).toHaveBeenLastCalledWith(
      `/api/transcription/model-downloads/${job.job_id}`,
      { signal: undefined },
    );
  });

  it("tests an AI model with its current unsaved configuration", async () => {
    const model = {
      model_id: "model-0198d12345677890abcdef1234567890",
      name: "测试模型",
      litellm_model: "openai/test-model",
      tool_calling_mode: "auto" as const,
      api_key: "secret",
      api_base: "https://example.com/v1",
      api_version: null,
      input_modalities: ["text" as const],
    };
    const result = {
      available: true,
      latency_ms: 86,
      message: "模型响应正常",
    };
    const fetch_mock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(test_ai_model(model)).resolves.toEqual(result);
    expect(fetch_mock).toHaveBeenCalledWith("/api/ai/models/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(model),
      signal: undefined,
    });
  });

  it("loads and saves markers page settings", async () => {
    const settings = {
      asset_library_size_percent: 14,
      agent_panel_size_percent: 24,
      asset_library_collapsed: false,
      tool_panel_size_percent: 16,
      tool_panel_collapsed: false,
      left_panel_tab: "video" as const,
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

    await expect(get_markers_page_settings()).resolves.toEqual(settings);
    await expect(update_markers_page_settings(settings)).resolves.toEqual(
      settings,
    );
    expect(fetch_mock).toHaveBeenNthCalledWith(
      1,
      "/api/page-settings/markers",
      { signal: undefined },
    );
    expect(fetch_mock).toHaveBeenNthCalledWith(
      2,
      "/api/page-settings/markers",
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

  it("manages the saved Douyin download account", async () => {
    const account = {
      account_id: "account-0198d12345677890abcdef1234567890",
      platform: "douyin",
      display_name: "抖音账号",
      status: "untested",
      last_tested_at: null,
      updated_at: "2026-08-24T08:30:00Z",
    };
    const fetch_mock = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(account), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await get_download_accounts();
    expect(fetch_mock).toHaveBeenLastCalledWith("/api/download-accounts", {
      signal: undefined,
    });

    await create_download_account_login_session("douyin");
    expect(fetch_mock).toHaveBeenLastCalledWith(
      "/api/download-accounts/douyin/login-sessions",
      { method: "POST", signal: undefined },
    );

    const login_id = "login-0198d12345677890abcdef1234567890";
    await get_download_account_login_session(login_id);
    expect(fetch_mock).toHaveBeenLastCalledWith(
      `/api/download-account-login-sessions/${login_id}`,
      { signal: undefined },
    );

    fetch_mock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await delete_download_account_login_session(login_id);
    expect(fetch_mock).toHaveBeenLastCalledWith(
      `/api/download-account-login-sessions/${login_id}`,
      { method: "DELETE", signal: undefined },
    );

    await save_download_account("douyin", "sessionid=secret");
    expect(fetch_mock).toHaveBeenLastCalledWith(
      "/api/download-accounts/douyin",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cookie: "sessionid=secret" }),
        signal: undefined,
      },
    );

    await import_download_account_from_browser(
      "douyin",
      "edge",
      "https://www.douyin.com/video/123",
    );
    expect(fetch_mock).toHaveBeenLastCalledWith(
      "/api/download-accounts/douyin/import-browser",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          browser: "edge",
          source_url: "https://www.douyin.com/video/123",
        }),
        signal: undefined,
      },
    );

    await test_download_account("douyin", "https://www.douyin.com/video/123");
    expect(fetch_mock).toHaveBeenLastCalledWith(
      "/api/download-accounts/douyin/test",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source_url: "https://www.douyin.com/video/123",
        }),
        signal: undefined,
      },
    );

    fetch_mock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await delete_download_account("douyin");
    expect(fetch_mock).toHaveBeenLastCalledWith(
      "/api/download-accounts/douyin",
      { method: "DELETE", signal: undefined },
    );
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
      analyze_asset("asset-1", "markers", ["marker-1"], "model-1"),
    ).resolves.toEqual(response);
    expect(fetch_mock).toHaveBeenCalledWith(
      "/api/media/assets/asset-1/analyze",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "markers",
          marker_ids: ["marker-1"],
          ai_model_id: "model-1",
          strategy: {
            preset: "course_notes",
            weights: {
              core_concepts: 90,
              formula_derivation: 65,
              case_demonstration: 60,
              questions_conclusions: 80,
              visual_content: 55,
              user_markers: 100,
            },
            depth: "balanced",
            marker_range_before_seconds: 10,
            marker_range_after_seconds: 20,
          },
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
        engine: "faster-whisper",
        model: "small",
        language: "zh",
        device: "cpu",
        compute_type: "int8",
      }),
    ).resolves.toEqual(response);
    expect(fetch_mock).toHaveBeenCalledWith(
      "/api/media/assets/asset-1/transcribe",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          force: true,
          engine: "faster-whisper",
          model: "small",
          language: "zh",
          device: "cpu",
          compute_type: "int8",
        }),
        signal: undefined,
      },
    );
  });

  it("creates and resumes a transcript correction Agent", async () => {
    const job = {
      job_id: "agent-019c0000000070008000000000000000",
      stage: "pending",
    };
    const fetch_mock = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(job), {
          status: 202,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await create_transcript_correction("asset-1", [2], "model-1");
    await respond_to_agent_job(
      job.job_id,
      "question-1",
      "change_model",
      "model-2",
    );

    expect(fetch_mock).toHaveBeenNthCalledWith(
      1,
      "/api/media/assets/asset-1/transcript/corrections",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          segment_indices: [2],
          ai_model_id: "model-1",
        }),
        signal: undefined,
      },
    );
    expect(fetch_mock).toHaveBeenNthCalledWith(
      2,
      `/api/agent-jobs/${job.job_id}/responses`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question_id: "question-1",
          action: "change_model",
          ai_model_id: "model-2",
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
      start_seconds: 12.5,
      end_seconds: null,
      title: "重点",
      tags: ["重点"],
      marker_range_before_seconds: null,
      marker_range_after_seconds: null,
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
      create_marker(marker.asset_id, {
        start_seconds: marker.start_seconds,
        end_seconds: marker.end_seconds,
        title: marker.title,
        tags: marker.tags,
        marker_range_before_seconds: null,
        marker_range_after_seconds: null,
      }),
    ).resolves.toEqual(marker);
    await expect(
      update_marker(marker.asset_id, marker.marker_id, {
        start_seconds: marker.start_seconds,
        end_seconds: 27.5,
        title: "关键帧",
        tags: ["关键帧"],
        marker_range_before_seconds: 15,
        marker_range_after_seconds: 0,
      }),
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
        body: JSON.stringify({
          start_seconds: 12.5,
          end_seconds: null,
          title: "重点",
          tags: ["重点"],
          marker_range_before_seconds: null,
          marker_range_after_seconds: null,
        }),
        signal: undefined,
      },
    );
    expect(fetch_mock).toHaveBeenNthCalledWith(
      2,
      `/api/media/assets/${marker.asset_id}/markers/${marker.marker_id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          start_seconds: 12.5,
          end_seconds: 27.5,
          title: "关键帧",
          tags: ["关键帧"],
          marker_range_before_seconds: 15,
          marker_range_after_seconds: 0,
        }),
        signal: undefined,
      },
    );
  });

  it("creates marker Agent sessions, messages, and batch resolutions", async () => {
    const asset_id = "asset-01890f4c7a2b7cc298c4dc0c0c07398f";
    const session_id = "session-01890f4c7a2b7cc298c4dc0c0c07398f";
    const proposal_id = "proposal-01890f4c7a2b7cc298c4dc0c0c07398f";
    const session = {
      session: { session_id, agent_type: "marker", title: "标记" },
      asset_id,
      events: [],
      proposals: [],
    };
    const run = { run_id: "run-01890f4c7a2b7cc298c4dc0c0c07398f" };
    const proposal = { proposal_id, status: "accepted" };
    const fetch_mock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify([session])))
      .mockResolvedValueOnce(new Response(JSON.stringify(session)))
      .mockResolvedValueOnce(new Response(JSON.stringify(run)))
      .mockResolvedValueOnce(new Response(JSON.stringify(proposal)));

    await list_marker_agent_sessions(asset_id);
    await create_marker_agent_session(asset_id);
    await create_marker_agent_message(session_id, {
      content: "只看字幕，找出结论",
      ai_model_id: "model-01890f4c7a2b7cc298c4dc0c0c07398f",
      retrieval_mode: "transcript",
    });
    await resolve_marker_proposal(proposal_id, "accept");

    expect(fetch_mock).toHaveBeenNthCalledWith(
      1,
      `/api/media/assets/${asset_id}/marker-agent-sessions`,
      { signal: undefined },
    );
    expect(fetch_mock).toHaveBeenNthCalledWith(
      2,
      `/api/media/assets/${asset_id}/marker-agent-sessions`,
      { method: "POST", signal: undefined },
    );
    expect(fetch_mock).toHaveBeenNthCalledWith(
      3,
      `/api/marker-agent-sessions/${session_id}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "只看字幕，找出结论",
          ai_model_id: "model-01890f4c7a2b7cc298c4dc0c0c07398f",
          retrieval_mode: "transcript",
        }),
        signal: undefined,
      },
    );
    expect(fetch_mock).toHaveBeenNthCalledWith(
      4,
      `/api/marker-proposals/${proposal_id}/accept`,
      { method: "POST", signal: undefined },
    );
  });
});
