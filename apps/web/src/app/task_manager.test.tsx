import { act, fireEvent, render, screen } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AssetCatalogProvider } from "@/app/asset_catalog";
import { ApplicationQueryProvider } from "@/app/query_cache";
import { TaskManagerProvider, use_task_manager } from "@/app/task_manager";
import { create_download, get_download, list_assets } from "@/shared/api";
import type { DownloadJob } from "@/shared/types";

vi.mock("@/shared/api", () => ({
  create_download: vi.fn(),
  get_download: vi.fn(),
  list_assets: vi.fn(),
  analyze_asset: vi.fn(),
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
  return <p>{task_records[0]?.stage ?? "empty"}</p>;
}

function download_job(stage: DownloadJob["stage"]): DownloadJob {
  return {
    job_id: "job-0123456789abcdef0123456789abcdef",
    asset_id: "01890f4c-7a2b-7cc2-98c4-dc0c0c07398f",
    stage,
    progress_percent: stage === "complete" ? 100 : 20,
    message: stage,
    error_message: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}
