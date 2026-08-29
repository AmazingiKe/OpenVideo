import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AssetCatalogProvider } from "@/app/asset_catalog";
import { ApplicationQueryProvider } from "@/app/query_cache";
import { TaskManagerProvider, use_task_manager } from "@/app/task_manager";
import {
  create_download,
  get_download,
  list_agent_tasks,
  list_assets,
  list_downloads,
  request_download_retry,
  resume_agent_run,
} from "@/shared/api";
import type { AgentRun, AgentTaskSnapshot, DownloadJob } from "@/shared/types";

vi.mock("@/shared/api", () => ({
  create_download: vi.fn(),
  get_download: vi.fn(),
  list_agent_tasks: vi.fn(),
  list_downloads: vi.fn(),
  request_download_retry: vi.fn(),
  resume_agent_run: vi.fn(),
  list_assets: vi.fn(),
  get_analysis: vi.fn(),
  transcribe_asset: vi.fn(),
  create_transcript_correction: vi.fn(),
  get_agent_job: vi.fn(),
  list_asset_agent_jobs: vi.fn(),
  respond_to_agent_job: vi.fn(),
}));

describe("TaskManagerProvider", () => {
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
    expect(list_assets).toHaveBeenCalledOnce();
    expect(screen.getByText("complete")).toBeInTheDocument();
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

  it("creates and tracks a retry download task", async () => {
    vi.useFakeTimers();
    vi.mocked(list_downloads).mockResolvedValue([]);
    vi.mocked(request_download_retry).mockResolvedValue(
      download_job("downloading"),
    );
    vi.mocked(get_download).mockResolvedValue(download_job("complete"));
    vi.mocked(list_assets).mockResolvedValue([]);

    render(
      <MemoryRouter>
        <ApplicationQueryProvider>
          <AssetCatalogProvider>
            <TaskManagerProvider>
              <RetryStarter />
              <TaskStatus />
            </TaskManagerProvider>
          </AssetCatalogProvider>
        </ApplicationQueryProvider>
      </MemoryRouter>,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "重新下载" }));
      await Promise.resolve();
    });
    await act(async () => vi.advanceTimersByTimeAsync(1000));

    expect(request_download_retry).toHaveBeenCalledWith(
      "job-0123456789abcdef0123456789abcdef",
      expect.any(AbortSignal),
    );
    expect(get_download).toHaveBeenCalledOnce();
    expect(screen.getByText("complete")).toBeInTheDocument();
  });

  it("loads global agent tasks and resumes an interrupted run", async () => {
    vi.mocked(list_downloads).mockResolvedValue([]);
    vi.mocked(list_agent_tasks).mockResolvedValue([agent_task_snapshot()]);
    vi.mocked(resume_agent_run).mockResolvedValue(
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
      expect(resume_agent_run).toHaveBeenCalledWith(
        "run-019c012345677abc8123456789abcdef",
      ),
    );
    expect(list_agent_tasks).toHaveBeenCalledTimes(2);
  });
});

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

function RetryStarter() {
  const { retry_download } = use_task_manager();
  return (
    <button
      type="button"
      onClick={() =>
        void retry_download("job-0123456789abcdef0123456789abcdef")
      }
    >
      重新下载
    </button>
  );
}

function AgentResumeStarter() {
  const { resume_agent_task } = use_task_manager();
  return (
    <button
      type="button"
      onClick={() =>
        void resume_agent_task("run-019c012345677abc8123456789abcdef")
      }
    >
      继续助手任务
    </button>
  );
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
    events: [],
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
    resume_available: stage === "interrupted",
  };
}
