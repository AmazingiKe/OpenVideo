import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  Link,
  MemoryRouter,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AssetCatalogProvider } from "@/app/asset_catalog";
import {
  ApplicationQueryProvider,
  RESOURCE_QUERY_KEYS,
} from "@/app/query_cache";
import { TaskManagerProvider, use_task_manager } from "@/app/task_manager";
import { TaskCenter } from "@/app/TaskCenter";
import {
  create_download,
  cancel_analysis,
  get_agent_index_status,
  get_download,
  list_agent_tasks,
  list_analysis_tasks,
  analyze_asset,
  generate_chapters,
  list_assets,
  list_downloads,
  transcribe_asset,
  get_analysis,
  retry_agent_run,
  ApiError,
  delete_download,
  pause_download,
  probe_source,
  resume_download,
} from "@/shared/api";
import type {
  AgentIndexStatus,
  AgentRun,
  AgentTaskSnapshot,
  DownloadJob,
  AnalysisJob,
  AnalysisTaskSnapshot,
  MediaAsset,
  ProbeResponse,
} from "@/shared/types";
import { DEFAULT_ANALYSIS_STRATEGY } from "@/shared/analysis";

vi.mock("@/shared/api", async () => ({
  ApiError: (await import("@/shared/api/client")).ApiError,
  delete_download: vi.fn(),
  pause_download: vi.fn(),
  probe_source: vi.fn(),
  resume_download: vi.fn(),
  create_download: vi.fn(),
  get_download: vi.fn(),
  get_agent_index_status: vi.fn(),
  list_agent_tasks: vi.fn(),
  list_analysis_tasks: vi.fn(),
  analyze_asset: vi.fn(),
  generate_chapters: vi.fn(),
  list_downloads: vi.fn(),
  retry_agent_run: vi.fn(),
  list_assets: vi.fn(),
  get_analysis: vi.fn(),
  transcribe_asset: vi.fn(),
  cancel_analysis: vi.fn(),
  create_transcript_correction: vi.fn(),
  get_agent_job: vi.fn(),
  list_asset_agent_jobs: vi.fn(),
  respond_to_agent_job: vi.fn(),
}));

const load_analysis_resource = vi.fn(async () => "loaded");

describe("TaskManagerProvider", () => {
  beforeEach(() => {
    vi.mocked(list_downloads).mockResolvedValue([]);
    vi.mocked(list_agent_tasks).mockResolvedValue([]);
    vi.mocked(list_analysis_tasks).mockReset().mockResolvedValue([]);
    vi.mocked(get_agent_index_status).mockResolvedValue(agent_index_status());
    load_analysis_resource.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("restores queued and running analysis by reading history without submitting work", async () => {
    vi.useFakeTimers();
    const initialization = {
      ...transcription_job("transcribing"),
      operation: "initialization",
    } as const;
    const chapters = {
      ...transcription_job("pending"),
      operation: "chapters",
      asset_id: "asset-second",
      job_id: "job-second",
    } as const;
    const approval = {
      ...transcription_job("waiting_for_approval"),
      operation: "analysis",
      asset_id: "asset-third",
      job_id: "job-third",
    } as const;
    vi.mocked(list_analysis_tasks).mockResolvedValue(
      [initialization, chapters, approval].map((job) => ({
        job,
        transcription_options: null,
      })),
    );
    const { result } = render_task_manager();
    await act(async () => Promise.resolve());
    expect(
      result.current.task_records.filter(
        (task) => task.task_type === "analysis",
      ),
    ).toHaveLength(3);
    expect(
      result.current.is_transcription_running(initialization.asset_id),
    ).toBe(true);
    expect(
      result.current.task_records.find(
        (task) => task.task_id === initialization.job_id,
      ),
    ).toMatchObject({ cancel_available: true });
    expect(
      result.current.task_records.find(
        (task) => task.task_id === approval.job_id,
      ),
    ).toMatchObject({ cancel_available: false, result_available: true });
    await act(async () => result.current.cancel_task(approval.job_id));
    expect(cancel_analysis).not.toHaveBeenCalled();
    expect(transcribe_asset).not.toHaveBeenCalled();
    expect(analyze_asset).not.toHaveBeenCalled();
    expect(generate_chapters).not.toHaveBeenCalled();
    expect(get_analysis).not.toHaveBeenCalled();
    expect(list_analysis_tasks).toHaveBeenCalledWith(
      50,
      expect.any(AbortSignal),
    );
  });

  it("keeps task-history refresh single-flight and ignores an abandoned response", async () => {
    vi.useFakeTimers();
    const response = deferred<AnalysisTaskSnapshot[]>();
    vi.mocked(list_analysis_tasks).mockReturnValue(response.promise);
    const query_client = new QueryClient();
    const refresh = vi.spyOn(query_client, "invalidateQueries");
    const { result, unmount } = render_task_manager(query_client);
    await act(async () => vi.advanceTimersByTimeAsync(6000));
    expect(list_analysis_tasks).toHaveBeenCalledOnce();
    const signal = vi.mocked(list_analysis_tasks).mock.calls[0][1];
    unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () =>
      response.resolve([
        { job: transcription_job("complete"), transcription_options: null },
      ]),
    );
    expect(
      result.current.task_records.some(
        (task) =>
          task.task_type === "analysis" || task.task_type === "transcription",
      ),
    ).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes completed restored results without starting a per-task submission or poll", async () => {
    vi.useFakeTimers();
    const job = transcription_job("transcribing");
    vi.mocked(list_analysis_tasks)
      .mockResolvedValueOnce([{ job, transcription_options: null }])
      .mockResolvedValue([
        { job: { ...job, stage: "complete" }, transcription_options: null },
      ]);
    const query_client = new QueryClient();
    const refresh = vi.spyOn(query_client, "invalidateQueries");
    const { result } = render_task_manager(query_client);
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(
      result.current.task_records.find((task) => task.task_id === job.job_id)
        ?.stage,
    ).toBe("complete");
    expect(result.current.is_transcription_running(job.asset_id)).toBe(false);
    expect(refresh).toHaveBeenCalledWith({
      queryKey: RESOURCE_QUERY_KEYS.asset_analysis(job.asset_id),
    });
    expect(transcribe_asset).not.toHaveBeenCalled();
    expect(get_analysis).not.toHaveBeenCalled();
  });

  it("retries a restored transcription only when its original options are available", async () => {
    const job = transcription_job("failed");
    const options = {
      engine: "bailian",
      model: "paraformer-v2",
      language: "zh",
      device: "auto",
      compute_type: "auto",
    } as const;
    const missing_options = {
      ...job,
      job_id: "job-no-options",
      asset_id: "asset-no-options",
    };
    vi.mocked(list_analysis_tasks).mockResolvedValue([
      { job, transcription_options: options },
      { job: missing_options, transcription_options: null },
    ]);
    vi.mocked(transcribe_asset).mockResolvedValue({
      ...job,
      job_id: "job-retry",
      stage: "complete",
    });
    const { result } = render_task_manager();
    await act(async () => Promise.resolve());
    expect(
      result.current.task_records.find(
        (task) => task.task_id === missing_options.job_id,
      ),
    ).toMatchObject({
      retry_available: false,
      message: expect.stringContaining("请回视频页面选择模型"),
    });
    await expect(
      result.current.retry_task(missing_options.job_id),
    ).rejects.toThrow("缺少安全重试所需信息");
    expect(transcribe_asset).not.toHaveBeenCalled();
    await act(async () => result.current.retry_task(job.job_id));
    expect(transcribe_asset).toHaveBeenCalledWith(
      job.asset_id,
      options,
      expect.any(AbortSignal),
    );
  });

  it("uses the restored chapter operation or analysis strategy only after an explicit retry", async () => {
    const chapter = {
      ...transcription_job("cancelled"),
      operation: "chapters",
    } as const;
    const analysis = {
      ...transcription_job("failed"),
      job_id: "job-analysis",
      asset_id: "asset-analysis",
      operation: "analysis",
      ai_model_id: "model-original",
    } as const;
    vi.mocked(list_analysis_tasks).mockResolvedValue([
      { job: chapter, transcription_options: null },
      { job: analysis, transcription_options: null },
    ]);
    vi.mocked(generate_chapters).mockResolvedValue({
      ...chapter,
      job_id: "job-chapter-retry",
      stage: "complete",
    });
    vi.mocked(analyze_asset).mockResolvedValue({
      ...analysis,
      job_id: "job-analysis-retry",
      stage: "complete",
    });
    const { result } = render_task_manager();
    await act(async () => Promise.resolve());
    expect(generate_chapters).not.toHaveBeenCalled();
    expect(analyze_asset).not.toHaveBeenCalled();
    await act(async () => result.current.retry_task(chapter.job_id));
    expect(generate_chapters).toHaveBeenCalledWith(
      chapter.asset_id,
      expect.any(AbortSignal),
    );
    await act(async () => result.current.retry_task(analysis.job_id));
    expect(analyze_asset).toHaveBeenCalledWith(
      analysis.asset_id,
      {
        mode: analysis.mode,
        ai_model_id: analysis.ai_model_id,
        strategy: analysis.strategy,
      },
      expect.any(AbortSignal),
    );
  });

  it("retries an incomplete worker stop from task history and only releases it after cancellation is confirmed", async () => {
    vi.useFakeTimers();
    const job = {
      ...transcription_job("cancelling"),
      operation: "initialization",
      error_message: "进程尚未退出",
    } as const;
    vi.mocked(list_analysis_tasks).mockResolvedValue([
      { job, transcription_options: null },
    ]);
    vi.mocked(cancel_analysis).mockResolvedValue({
      ...job,
      error_message: null,
    });
    vi.mocked(get_analysis).mockResolvedValue({
      ...job,
      stage: "cancelled",
      error_message: null,
    });
    const { result } = render_task_manager(new QueryClient(), true);
    await act(async () => Promise.resolve());
    expect(screen.getByRole("button", { name: "重试停止" })).toBeEnabled();
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "重试停止" })),
    );
    expect(cancel_analysis).toHaveBeenCalledWith(job.job_id);
    expect(screen.getByRole("button", { name: "正在停止…" })).toBeDisabled();
    expect(result.current.is_transcription_running(job.asset_id)).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(result.current.is_transcription_running(job.asset_id)).toBe(false);
  });

  it("shows task synchronization failures and clears them after reconnecting", async () => {
    vi.useFakeTimers();
    vi.mocked(list_analysis_tasks)
      .mockRejectedValueOnce(new Error("连接断开"))
      .mockResolvedValue([]);
    const { result } = render_task_manager();
    await act(async () => Promise.resolve());
    expect(result.current.task_sync_error).toContain("连接断开");
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(result.current.task_sync_error).toBeNull();
  });

  it("opens the source video for a restored proposal without cancelling or re-running it", async () => {
    const job = {
      ...transcription_job("waiting_for_approval"),
      operation: "analysis",
    } as const;
    vi.mocked(list_analysis_tasks).mockResolvedValue([
      { job, transcription_options: null },
    ]);
    vi.mocked(list_assets).mockResolvedValue([
      {
        asset_id: job.asset_id,
        title: "原视频",
        status: "ready",
      } as MediaAsset,
    ]);
    render_task_manager(new QueryClient(), true);
    fireEvent.click(await screen.findByRole("button", { name: "查看视频" }));
    await waitFor(() =>
      expect(screen.getByLabelText("当前位置")).toHaveTextContent(
        `/markers/${job.asset_id}`,
      ),
    );
    expect(cancel_analysis).not.toHaveBeenCalled();
    expect(analyze_asset).not.toHaveBeenCalled();
  });

  it("keeps polling a download after the initiating page unmounts", async () => {
    vi.useFakeTimers();
    vi.mocked(list_downloads).mockResolvedValue([]);
    vi.mocked(create_download).mockResolvedValue([download_job("downloading")]);
    vi.mocked(get_download).mockResolvedValue(download_job("complete"));
    vi.mocked(list_assets).mockResolvedValue([]);

    render(
      <MemoryRouter initialEntries={["/start"]}>
        <ApplicationQueryProvider>
          <AssetCatalogProvider>
            <TaskManagerProvider>
              <Routes>
                <Route path="/start" element={<TaskStarter />} />
                <Route path="/other" element={<TaskStatus />} />
              </Routes>
            </TaskManagerProvider>
          </AssetCatalogProvider>
        </ApplicationQueryProvider>
      </MemoryRouter>,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "开始下载" }));
      await Promise.resolve();
    });
    expect(create_download).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("link", { name: "离开页面" }));

    await act(async () => vi.advanceTimersByTimeAsync(1000));

    expect(get_download).toHaveBeenCalledOnce();
    // 离开素材页面后只使缓存过期，下次进入视频库时再读取。
    expect(list_assets).not.toHaveBeenCalled();
    expect(screen.getByText("complete")).toBeInTheDocument();
  });

  it("opens an optimistic task before acceptance and retries the same identifier after a failed submission", async () => {
    const pending = deferred<DownloadJob[]>();
    vi.mocked(create_download).mockReturnValueOnce(pending.promise);
    const { result } = render_task_manager();
    let request!: Promise<DownloadJob[]>;
    act(() => {
      request = result.current.start_downloads(["https://example.com/video"]);
    });
    const task = result.current.task_records.find(
      (item) => item.task_type === "download",
    )!;
    expect(task.stage).toBe("submitting");
    expect(task.task_id).toMatch(
      /^job-[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$/,
    );
    expect(result.current.task_center_open).toBe(true);
    await act(async () => {
      pending.reject(new Error("连接失败"));
      await expect(request).rejects.toThrow("连接失败");
    });
    expect(
      result.current.task_records.find((item) => item.task_id === task.task_id),
    ).toMatchObject({
      stage: "failed",
      retry_available: true,
      delete_available: true,
    });
    vi.mocked(get_download).mockRejectedValueOnce(
      new ApiError("任务不存在", 404),
    );
    vi.mocked(create_download).mockResolvedValueOnce([
      { ...download_job("complete"), job_id: task.task_id },
    ]);
    await act(async () => result.current.retry_task(task.task_id));
    expect(
      vi.mocked(create_download).mock.calls.map((call) => call[3]),
    ).toEqual([[task.task_id], [task.task_id]]);
    expect(
      result.current.task_records.filter(
        (item) => item.task_type === "download",
      ),
    ).toHaveLength(1);
  });

  it("reconnects an accepted task after its response was lost instead of creating another download", async () => {
    vi.mocked(create_download).mockRejectedValueOnce(new Error("响应丢失"));
    const { result } = render_task_manager();
    await act(async () => {
      await expect(
        result.current.start_downloads(["https://example.com/video"]),
      ).rejects.toThrow();
    });
    const task = result.current.task_records.find(
      (item) => item.task_type === "download",
    )!;
    vi.mocked(get_download).mockResolvedValueOnce({
      ...download_job("failed"),
      job_id: task.task_id,
    });
    vi.mocked(resume_download).mockResolvedValueOnce({
      ...download_job("downloading"),
      job_id: task.task_id,
    });
    await act(async () => result.current.retry_task(task.task_id));
    expect(create_download).toHaveBeenCalledOnce();
    expect(resume_download).toHaveBeenCalledWith(task.task_id);
  });

  it("keeps polling an accepted pause and allows retrying a worker cleanup failure", async () => {
    vi.useFakeTimers();
    const job = download_job("downloading");
    vi.mocked(list_downloads).mockResolvedValueOnce([job]);
    vi.mocked(pause_download).mockResolvedValueOnce({
      ...job,
      stage: "pausing",
    });
    vi.mocked(get_download)
      .mockResolvedValueOnce({
        ...job,
        stage: "pausing",
        error_message: "进程尚未退出",
      })
      .mockResolvedValueOnce({ ...job, stage: "paused" });
    const { result } = render_task_manager();
    await act(async () => Promise.resolve());
    await act(async () => result.current.pause_task(job.job_id));
    expect(
      result.current.task_records.find((task) => task.task_id === job.job_id),
    ).toMatchObject({
      stage: "pausing",
      retry_available: false,
      delete_available: false,
      pause_available: false,
    });
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(
      result.current.task_records.find((task) => task.task_id === job.job_id),
    ).toMatchObject({
      stage: "pausing",
      pause_available: true,
      retry_available: false,
      delete_available: false,
    });
    vi.mocked(pause_download).mockResolvedValueOnce({
      ...job,
      stage: "pausing",
    });
    await act(async () => result.current.pause_task(job.job_id));
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(
      result.current.task_records.find((task) => task.task_id === job.job_id),
    ).toMatchObject({
      stage: "paused",
      retry_available: true,
      delete_available: true,
    });
    expect(pause_download).toHaveBeenCalledTimes(2);
    expect(resume_download).not.toHaveBeenCalled();
    expect(delete_download).not.toHaveBeenCalled();
  });

  it("pauses optimistically, ignores late polling, resumes, and restores a task when deletion fails", async () => {
    vi.useFakeTimers();
    const job = download_job("downloading");
    vi.mocked(list_downloads).mockResolvedValueOnce([job]);
    const stale_poll = deferred<DownloadJob>();
    vi.mocked(get_download).mockReturnValueOnce(stale_poll.promise);
    const pause = deferred<DownloadJob>();
    vi.mocked(pause_download).mockReturnValueOnce(pause.promise);
    const { result } = render_task_manager();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    let request!: Promise<void>;
    act(() => {
      request = result.current.pause_task(job.job_id);
    });
    expect(
      result.current.task_records.find((item) => item.task_id === job.job_id)
        ?.stage,
    ).toBe("pausing");
    await act(async () => {
      pause.resolve({ ...job, stage: "paused" });
      await request;
      stale_poll.resolve(job);
    });
    expect(
      result.current.task_records.find((item) => item.task_id === job.job_id)
        ?.stage,
    ).toBe("paused");
    vi.mocked(get_download).mockResolvedValueOnce({ ...job, stage: "paused" });
    vi.mocked(resume_download).mockResolvedValueOnce(job);
    await act(async () => result.current.retry_task(job.job_id));
    expect(resume_download).toHaveBeenCalledWith(job.job_id);
    vi.mocked(pause_download).mockResolvedValueOnce({
      ...job,
      stage: "paused",
    });
    await act(async () => result.current.pause_task(job.job_id));
    vi.mocked(get_download).mockResolvedValue({ ...job, stage: "paused" });
    const deletion = deferred<void>();
    vi.mocked(delete_download).mockReturnValueOnce(deletion.promise);
    act(() => {
      request = result.current.delete_task(job.job_id);
    });
    expect(
      result.current.task_records.some((item) => item.task_id === job.job_id),
    ).toBe(false);
    await act(async () => {
      deletion.reject(new Error("删除失败"));
      await expect(request).rejects.toThrow("删除失败");
    });
    expect(
      result.current.task_records.find((item) => item.task_id === job.job_id)
        ?.stage,
    ).toBe("paused");
    vi.mocked(delete_download).mockResolvedValueOnce(undefined);
    await act(async () => result.current.delete_task(job.job_id));
    expect(
      result.current.task_records.some((item) => item.task_id === job.job_id),
    ).toBe(false);
  });

  it("keeps slow parsing in the task center and makes failed parses retryable and removable", async () => {
    const pending = deferred<ProbeResponse>();
    vi.mocked(probe_source).mockReturnValueOnce(pending.promise);
    const { result } = render_task_manager();
    act(() => result.current.start_probe("https://example.com/video"));
    const task = result.current.task_records.find(
      (item) => item.task_type === "probe",
    )!;
    expect(task.stage).toBe("probing");
    expect(result.current.task_center_open).toBe(true);
    act(() => result.current.set_task_center_open(false));
    await act(async () => pending.reject(new Error("解析失败")));
    expect(result.current.task_center_open).toBe(false);
    expect(
      result.current.task_records.find((item) => item.task_id === task.task_id)
        ?.retry_available,
    ).toBe(true);
    const probe: ProbeResponse = {
      platform: "youtube",
      title: "视频",
      is_playlist: false,
      entries: [],
      total_count: 0,
      truncated: false,
    };
    vi.mocked(probe_source).mockResolvedValueOnce(probe);
    await act(async () => result.current.retry_task(task.task_id));
    act(() => result.current.view_task_result(task.task_id));
    expect(result.current.selected_probe?.result).toEqual(probe);
    expect(result.current.task_center_open).toBe(false);
    await act(async () => result.current.delete_task(task.task_id));
    expect(
      result.current.task_records.some((item) => item.task_id === task.task_id),
    ).toBe(false);
  });

  it("loads the latest 50 persisted download tasks on startup", async () => {
    vi.mocked(list_downloads).mockResolvedValue([
      download_job("complete", "Blender 角色绑定完整教程"),
    ]);

    render(
      <MemoryRouter>
        <ApplicationQueryProvider>
          <AssetCatalogProvider>
            <TaskManagerProvider>
              <TaskStatus />
            </TaskManagerProvider>
          </AssetCatalogProvider>
        </ApplicationQueryProvider>
      </MemoryRouter>,
    );

    expect(
      await screen.findByText("Blender 角色绑定完整教程"),
    ).toBeInTheDocument();
    expect(list_downloads).toHaveBeenCalledWith(50, expect.any(AbortSignal));
  });

  it("returns queued downloads immediately and refreshes each completion without cancelling another batch", async () => {
    vi.useFakeTimers();
    vi.mocked(list_downloads).mockResolvedValue([]);
    const first_job = download_job("downloading");
    const second_job = {
      ...first_job,
      job_id: "job-019c0000000070008000000000000002",
      asset_id: "asset-019c0000000070008000000000000002",
    };
    vi.mocked(create_download)
      .mockResolvedValueOnce([first_job])
      .mockResolvedValueOnce([second_job]);
    vi.mocked(get_download).mockImplementation(async (job_id) =>
      job_id === first_job.job_id
        ? { ...first_job, stage: "complete" }
        : second_job,
    );
    const query_client = new QueryClient();
    const refresh = vi.spyOn(query_client, "invalidateQueries");
    const { result } = render_task_manager(query_client);
    await act(async () => {
      expect(
        await result.current.start_downloads(["https://example.com/first"]),
      ).toEqual([first_job]);
      expect(
        await result.current.start_downloads(["https://example.com/second"]),
      ).toEqual([second_job]);
    });
    refresh.mockClear();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(get_download).toHaveBeenCalledTimes(2);
    for (const [, signal] of vi.mocked(get_download).mock.calls)
      expect(signal?.aborted).toBe(false);
    expect(refresh).toHaveBeenCalledWith({
      queryKey: RESOURCE_QUERY_KEYS.assets,
    });
    expect(refresh).toHaveBeenCalledWith({
      queryKey: RESOURCE_QUERY_KEYS.library_folders,
    });
    expect(
      result.current.task_records.find(
        (task) => task.task_id === first_job.job_id,
      )?.stage,
    ).toBe("complete");
    expect(
      result.current.task_records.find(
        (task) => task.task_id === second_job.job_id,
      )?.stage,
    ).toBe("downloading");
  });

  it("resumes polling unfinished downloads from history", async () => {
    vi.useFakeTimers();
    vi.mocked(list_downloads).mockResolvedValue([download_job("downloading")]);
    vi.mocked(get_download).mockResolvedValue(download_job("complete"));
    const { result } = render_task_manager();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(get_download).toHaveBeenCalledOnce();
    expect(
      result.current.task_records.some(
        (task) => task.task_type === "download" && task.stage === "complete",
      ),
    ).toBe(true);
  });

  it("tracks multiple transcriptions independently and refreshes their results", async () => {
    vi.useFakeTimers();
    vi.mocked(list_downloads).mockResolvedValue([]);
    const options = {
      engine: "faster-whisper",
      model: "small",
      language: null,
      device: "cpu",
      compute_type: "int8",
    } as const;
    const jobs = ["asset-first", "asset-second"].map(
      (asset_id, index) =>
        ({
          job_id: `job-${index}`,
          asset_id,
          stage: "pending",
          progress_percent: 0,
          message: "等待转写",
          created_at: "2026-01-01T00:00:00Z",
        }) as AnalysisJob,
    );
    vi.mocked(transcribe_asset).mockImplementation(async (asset_id) =>
      jobs.find((job) => job.asset_id === asset_id)!,
    );
    vi.mocked(get_analysis).mockImplementation(async (job_id) => ({
      ...jobs.find((job) => job.job_id === job_id)!,
      stage: "complete",
    }));
    const query_client = new QueryClient();
    const refresh = vi.spyOn(query_client, "invalidateQueries");
    const { result } = render_task_manager(query_client);
    let pending: Promise<AnalysisJob[]>;
    await act(async () => {
      pending = Promise.all(
        jobs.map((job) =>
          result.current.start_transcription(job.asset_id, options),
        ),
      );
    });
    expect(
      jobs.every((job) =>
        result.current.is_transcription_running(job.asset_id),
      ),
    ).toBe(true);
    for (const [, , signal] of vi.mocked(transcribe_asset).mock.calls)
      expect(signal?.aborted).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      await pending;
    });
    for (const job of jobs) {
      expect(result.current.is_transcription_running(job.asset_id)).toBe(false);
      expect(refresh).toHaveBeenCalledWith({
        queryKey: RESOURCE_QUERY_KEYS.asset_analysis(job.asset_id),
      });
    }
  });

  it("reports interrupted transcription observation and reconnects without another paid submission", async () => {
    vi.useFakeTimers();
    const options = {
      engine: "bailian",
      model: "fun-asr",
      language: null,
      device: "auto",
      compute_type: "auto",
    } as const;
    const job = transcription_job("transcribing");
    vi.mocked(transcribe_asset).mockResolvedValue(job);
    vi.mocked(get_analysis).mockRejectedValueOnce(new Error("网络中断"));
    const { result } = render_task_manager();
    let request!: Promise<AnalysisJob>;
    act(() => {
      request = result.current.start_transcription(job.asset_id, options);
    });
    const rejection = expect(request).rejects.toThrow("网络中断");
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    await rejection;
    expect(
      result.current.task_records.find((task) => task.task_id === job.job_id),
    ).toMatchObject({
      stage: "interrupted",
      retry_available: true,
      cancel_available: true,
      error_message: "网络中断",
    });
    expect(result.current.is_transcription_running(job.asset_id)).toBe(true);
    vi.mocked(get_analysis).mockResolvedValueOnce({
      ...job,
      stage: "complete",
    });
    await act(async () => result.current.retry_task(job.job_id));
    expect(transcribe_asset).toHaveBeenCalledOnce();
    expect(get_analysis).toHaveBeenLastCalledWith(
      job.job_id,
      expect.any(AbortSignal),
    );
    expect(result.current.is_transcription_running(job.asset_id)).toBe(false);
  });

  it("finishes reconnection as soon as observation restarts so stopping remains available", async () => {
    vi.useFakeTimers();
    const options = {
      engine: "bailian",
      model: "fun-asr",
      language: null,
      device: "auto",
      compute_type: "auto",
    } as const;
    const job = transcription_job("transcribing");
    vi.mocked(transcribe_asset).mockResolvedValue(job);
    vi.mocked(get_analysis).mockRejectedValueOnce(new Error("网络中断"));
    const { result } = render_task_manager(new QueryClient(), true);
    let request!: Promise<AnalysisJob>;
    act(() => {
      request = result.current.start_transcription(job.asset_id, options);
    });
    const rejection = expect(request).rejects.toThrow("网络中断");
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    await rejection;
    vi.mocked(get_analysis).mockResolvedValueOnce(job);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "重新连接" }));
    });
    expect(screen.getByRole("button", { name: "停止转写" })).toBeEnabled();
    expect(
      result.current.task_records.find((task) => task.task_id === job.job_id),
    ).toMatchObject({
      stage: "transcribing",
      retry_available: false,
      cancel_available: true,
    });
    vi.mocked(cancel_analysis).mockResolvedValueOnce({
      ...job,
      stage: "cancelled",
    });
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "停止转写" })),
    );
    expect(cancel_analysis).toHaveBeenCalledOnce();
    expect(result.current.is_transcription_running(job.asset_id)).toBe(false);
    expect(transcribe_asset).toHaveBeenCalledOnce();
  });

  it("waits for confirmed cancellation, ignores stale progress, and retries the original options", async () => {
    vi.useFakeTimers();
    const options = {
      engine: "bailian",
      model: "fun-asr",
      language: "zh",
      device: "auto",
      compute_type: "auto",
    } as const;
    const job = transcription_job("transcribing");
    const stale_poll = deferred<AnalysisJob>();
    vi.mocked(transcribe_asset).mockResolvedValueOnce(job);
    vi.mocked(get_analysis)
      .mockReturnValueOnce(stale_poll.promise)
      .mockResolvedValueOnce({
        ...job,
        stage: "cancelled",
        message: "转写已停止",
      });
    vi.mocked(cancel_analysis).mockResolvedValue({
      ...job,
      stage: "cancelling",
      message: "正在安全退出",
    });
    const { result } = render_task_manager();
    let request!: Promise<AnalysisJob>;
    act(() => {
      request = result.current.start_transcription(job.asset_id, options);
    });
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    const signal = vi.mocked(transcribe_asset).mock.calls[0][2];
    await act(async () => result.current.cancel_task(job.job_id));
    expect(cancel_analysis).toHaveBeenCalledWith(job.job_id);
    expect(signal?.aborted).toBe(false);
    expect(result.current.is_transcription_running(job.asset_id)).toBe(true);
    await act(async () => stale_poll.resolve(job));
    expect(
      result.current.task_records.find((task) => task.task_id === job.job_id),
    ).toMatchObject({
      stage: "cancelling",
      cancel_available: false,
      retry_available: false,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      expect((await request).stage).toBe("cancelled");
    });
    expect(result.current.is_transcription_running(job.asset_id)).toBe(false);
    expect(
      result.current.task_records.find((task) => task.task_id === job.job_id),
    ).toMatchObject({
      stage: "cancelled",
      retry_available: true,
    });
    vi.mocked(transcribe_asset).mockResolvedValueOnce({
      ...job,
      job_id: "job-retried",
      stage: "complete",
    });
    await act(async () => result.current.retry_task(job.job_id));
    expect(transcribe_asset).toHaveBeenLastCalledWith(
      job.asset_id,
      options,
      expect.any(AbortSignal),
    );
    expect(transcribe_asset).toHaveBeenCalledTimes(2);
  });

  it("does not let a late stop response cancel a newer transcription for the same asset", async () => {
    vi.useFakeTimers();
    const options = {
      engine: "bailian",
      model: "fun-asr",
      language: null,
      device: "auto",
      compute_type: "auto",
    } as const;
    const job = transcription_job("transcribing");
    const new_job = { ...job, job_id: "job-newer" };
    const cancelled = { ...job, stage: "cancelled" } as const;
    const cancellation_response = deferred<AnalysisJob>();
    vi.mocked(transcribe_asset)
      .mockResolvedValueOnce(job)
      .mockResolvedValueOnce(new_job);
    vi.mocked(cancel_analysis).mockReturnValueOnce(
      cancellation_response.promise,
    );
    vi.mocked(get_analysis).mockResolvedValueOnce(cancelled);
    const { result } = render_task_manager();
    let old_request!: Promise<AnalysisJob>;
    await act(async () => {
      old_request = result.current.start_transcription(job.asset_id, options);
    });
    let stop_request!: Promise<void>;
    act(() => {
      stop_request = result.current.cancel_task(job.job_id);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      await old_request;
    });
    expect(result.current.is_transcription_running(job.asset_id)).toBe(false);
    let new_request!: Promise<AnalysisJob>;
    await act(async () => {
      new_request = result.current.start_transcription(job.asset_id, options);
      void new_request.catch(() => undefined);
    });
    const new_signal = vi.mocked(transcribe_asset).mock.calls[1][2];
    expect(new_signal?.aborted).toBe(false);
    await act(async () => {
      cancellation_response.resolve(cancelled);
      await stop_request;
    });
    expect(new_signal?.aborted).toBe(false);
    expect(result.current.is_transcription_running(job.asset_id)).toBe(true);
    vi.mocked(get_analysis).mockResolvedValueOnce({
      ...new_job,
      stage: "complete",
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      expect((await new_request).stage).toBe("complete");
    });
    expect(result.current.is_transcription_running(job.asset_id)).toBe(false);
  });

  it("keeps observing after a failed stop request and lets the user stop again", async () => {
    vi.useFakeTimers();
    const job = transcription_job("transcribing");
    vi.mocked(transcribe_asset).mockResolvedValue(job);
    vi.mocked(cancel_analysis)
      .mockRejectedValueOnce(new Error("停止请求失败"))
      .mockResolvedValueOnce({ ...job, stage: "cancelled" });
    const { result } = render_task_manager();
    let request!: Promise<AnalysisJob>;
    act(() => {
      request = result.current.start_transcription(job.asset_id, {
        engine: "bailian",
        model: "fun-asr",
        language: null,
        device: "auto",
        compute_type: "auto",
      });
    });
    await act(async () => Promise.resolve());
    await act(async () => {
      await expect(result.current.cancel_task(job.job_id)).rejects.toThrow(
        "停止请求失败",
      );
    });
    expect(vi.mocked(transcribe_asset).mock.calls[0][2]?.aborted).toBe(false);
    expect(result.current.is_transcription_running(job.asset_id)).toBe(true);
    expect(
      result.current.task_records.find((task) => task.task_id === job.job_id),
    ).toMatchObject({
      stage: "transcribing",
      cancel_available: true,
      error_message: "停止请求失败",
    });
    await act(async () => {
      await result.current.cancel_task(job.job_id);
      expect((await request).stage).toBe("cancelled");
    });
    expect(cancel_analysis).toHaveBeenCalledTimes(2);
    expect(result.current.is_transcription_running(job.asset_id)).toBe(false);
  });

  it("loads global agent tasks and retries an interrupted run", async () => {
    vi.mocked(list_downloads).mockResolvedValue([]);
    vi.mocked(list_agent_tasks).mockResolvedValue([agent_task_snapshot()]);
    vi.mocked(retry_agent_run).mockResolvedValue(
      agent_task_snapshot("running").run,
    );

    render(
      <MemoryRouter>
        <ApplicationQueryProvider>
          <AssetCatalogProvider>
            <TaskManagerProvider>
              <AgentResumeStarter />
              <TaskStatus />
            </TaskManagerProvider>
          </AssetCatalogProvider>
        </ApplicationQueryProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText("分析角色动作")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "继续助手任务" }));

    await waitFor(() =>
      expect(retry_agent_run).toHaveBeenCalledWith(
        "run-019c012345677abc8123456789abcdef",
      ),
    );
    expect(list_agent_tasks).toHaveBeenCalledTimes(2);
  });

  it("reports automatic initialization transcription without creating a duplicate task", async () => {
    vi.mocked(list_downloads).mockResolvedValue([]);
    vi.mocked(list_agent_tasks).mockResolvedValue([]);
    vi.mocked(get_agent_index_status).mockResolvedValue({
      ...agent_index_status(),
      asset_id: "asset-019c012345677abc8123456789abcdef",
      state: "initializing",
      stage: "transcribing",
      stage_label: "正在转写音频",
    });

    render(
      <MemoryRouter>
        <ApplicationQueryProvider>
          <AssetCatalogProvider>
            <TaskManagerProvider>
              <TranscriptionStatus />
              <TaskStatus />
            </TaskManagerProvider>
          </AssetCatalogProvider>
        </ApplicationQueryProvider>
      </MemoryRouter>,
    );

    expect(
      await screen.findByText("transcription-running"),
    ).toBeInTheDocument();
    expect(screen.getByText("当前视频证据索引")).toBeInTheDocument();
    expect(screen.queryByText("素材转录")).not.toBeInTheDocument();
  });

  it("refreshes analysis data when automatic transcription finishes", async () => {
    vi.useFakeTimers();
    vi.mocked(list_downloads).mockResolvedValue([]);
    vi.mocked(list_agent_tasks).mockResolvedValue([]);
    vi.mocked(get_agent_index_status)
      .mockResolvedValueOnce({
        ...agent_index_status(),
        asset_id: "asset-019c012345677abc8123456789abcdef",
        state: "initializing",
        stage: "transcribing",
        stage_label: "正在转写音频",
      })
      .mockResolvedValue({
        ...agent_index_status(),
        asset_id: "asset-019c012345677abc8123456789abcdef",
        state: "initializing",
        stage: "building_timeline",
        stage_label: "正在构建时间轴事件",
      });

    render(
      <MemoryRouter>
        <ApplicationQueryProvider>
          <AssetCatalogProvider>
            <TaskManagerProvider>
              <AnalysisResourceStatus />
            </TaskManagerProvider>
          </AssetCatalogProvider>
        </ApplicationQueryProvider>
      </MemoryRouter>,
    );

    await act(async () => Promise.resolve());
    expect(load_analysis_resource).toHaveBeenCalledOnce();

    await act(async () => vi.advanceTimersByTimeAsync(2_000));

    expect(load_analysis_resource).toHaveBeenCalledTimes(2);
  });
});

function render_task_manager(
  query_client = new QueryClient(),
  show_task_center = false,
) {
  return renderHook(use_task_manager, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <MemoryRouter>
        <QueryClientProvider client={query_client}>
          <AssetCatalogProvider>
            <TaskManagerProvider>
              {children}
              {show_task_center ? <ManagedTaskCenter /> : null}
            </TaskManagerProvider>
          </AssetCatalogProvider>
        </QueryClientProvider>
      </MemoryRouter>
    ),
  });
}

function ManagedTaskCenter() {
  const manager = use_task_manager();
  return (
    <>
      <TaskCenter
        open
        tasks={manager.task_records}
        on_retry={manager.retry_task}
        on_cancel={manager.cancel_task}
        sync_error={manager.task_sync_error}
        on_view_result={manager.view_task_result}
      />
      <output aria-label="当前位置">{useLocation().pathname}</output>
    </>
  );
}

function TaskStarter() {
  const { start_downloads } = use_task_manager();
  return (
    <>
      <button
        type="button"
        onClick={() => void start_downloads(["https://example.com/video"])}
      >
        开始下载
      </button>
      <Link to="/other">离开页面</Link>
    </>
  );
}

function TaskStatus() {
  const { task_records } = use_task_manager();
  return (
    <p>
      {task_records[0]?.name ?? "empty"}
      <span>{task_records[0]?.stage}</span>
    </p>
  );
}

function AgentResumeStarter() {
  const { retry_task } = use_task_manager();
  return (
    <button
      type="button"
      onClick={() => void retry_task("run-019c012345677abc8123456789abcdef")}
    >
      继续助手任务
    </button>
  );
}

function TranscriptionStatus() {
  const { is_transcription_running } = use_task_manager();
  return (
    <p>
      {is_transcription_running("asset-019c012345677abc8123456789abcdef")
        ? "transcription-running"
        : "transcription-idle"}
    </p>
  );
}

function AnalysisResourceStatus() {
  useQuery({
    queryKey: RESOURCE_QUERY_KEYS.asset_analysis(
      "asset-019c012345677abc8123456789abcdef",
    ),
    queryFn: load_analysis_resource,
  });
  return null;
}

function download_job(
  stage: DownloadJob["stage"],
  name = "测试视频",
): DownloadJob {
  return {
    job_id: "job-0123456789abcdef0123456789abcdef",
    asset_id: "01890f4c-7a2b-7cc2-98c4-dc0c0c07398f",
    video_quality: "best",
    stage,
    progress_percent: stage === "complete" ? 100 : 20,
    message: stage,
    error_message: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    name,
  };
}

function agent_task_snapshot(
  stage: AgentRun["stage"] = "interrupted",
): AgentTaskSnapshot {
  return {
    run: {
      run_id: "run-019c012345677abc8123456789abcdef",
      session_id: "session-019c012345677abc8123456789abcdef",
      request_key: "request-019c012345677abc8123456789abcdef",
      model_id: "model-019c012345677abc8123456789abcdef",
      stage,
      error_code: null,
      error_message: null,
      latest_event_sequence: 4,
      created_at: "2026-08-29T10:00:00Z",
      started_at: "2026-08-29T10:00:01Z",
      updated_at: "2026-08-29T10:00:02Z",
      completed_at: stage === "running" ? null : "2026-08-29T10:00:02Z",
    },
    session_title: "分析角色动作",
    asset_id: "asset-019c012345677abc8123456789abcdef",
    retry_available: stage === "interrupted",
  };
}

function agent_index_status(): AgentIndexStatus {
  return {
    index_task_id: "index-task-019c012345677abc8123456789abcdef",
    asset_id: null,
    state: "ready",
    stage: "ready",
    stage_label: "检索索引已就绪",
    processed_documents: 20,
    total_documents: 20,
    indexed_documents: 20,
    covered_seconds: 50,
    duration_seconds: 60,
    available_capabilities: ["字幕检索", "关键词检索", "语义检索"],
    error_message: null,
    updated_at: "2025-01-01T00:00:00Z",
  };
}

function transcription_job(stage: AnalysisJob["stage"]): AnalysisJob {
  return {
    job_id: "job-019c012345677abc8123456789abcdea",
    asset_id: "asset-019c012345677abc8123456789abcdef",
    operation: "transcription",
    mode: "full",
    ai_model_id: null,
    strategy: DEFAULT_ANALYSIS_STRATEGY,
    capabilities: ["transcript"],
    stage,
    progress_percent: 20,
    message: "正在转写",
    error_message: null,
    proposal_base_digest: null,
    proposed_segments: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}
