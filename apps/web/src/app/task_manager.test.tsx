import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
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
import {
  create_download,
  get_agent_index_status,
  get_download,
  list_agent_tasks,
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
  ProbeResponse,
} from "@/shared/types";

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
  list_downloads: vi.fn(),
  retry_agent_run: vi.fn(),
  list_assets: vi.fn(),
  get_analysis: vi.fn(),
  transcribe_asset: vi.fn(),
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
    vi.mocked(get_agent_index_status).mockResolvedValue(agent_index_status());
    load_analysis_resource.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
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
    act(() => result.current.view_probe_result(task.task_id));
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

function render_task_manager(query_client = new QueryClient()) {
  return renderHook(use_task_manager, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <MemoryRouter>
        <QueryClientProvider client={query_client}>
          <AssetCatalogProvider>
            <TaskManagerProvider>{children}</TaskManagerProvider>
          </AssetCatalogProvider>
        </QueryClientProvider>
      </MemoryRouter>
    ),
  });
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}
