import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApplicationQueryProvider } from "@/app/query_cache";
import { get_analysis } from "@/shared/api";
import { generate_chapters } from "@/shared/api/analysis";
import { DEFAULT_ANALYSIS_STRATEGY } from "@/shared/analysis";
import type { AnalysisJob } from "@/shared/types";
import { load_asset_analysis } from "@/shared/load_asset_analysis";
import { use_asset_analysis } from "./use_asset_analysis";

vi.mock("@/shared/api", () => ({
  update_transcript_segment: vi.fn(),
  get_analysis: vi.fn(),
}));

vi.mock("@/shared/api/analysis", () => ({ generate_chapters: vi.fn() }));

vi.mock("@/shared/load_asset_analysis", () => ({
  load_asset_analysis: vi.fn(),
}));

const ASSET_ID = "asset-0198d12345677890abcdef1234567890";
const CHAPTER_JOB: AnalysisJob = {
  job_id: "job-0198d12345677890abcdef1234567891",
  asset_id: ASSET_ID,
  operation: "chapters",
  mode: "full",
  ai_model_id: null,
  strategy: DEFAULT_ANALYSIS_STRATEGY,
  capabilities: [],
  stage: "pending",
  progress_percent: 0,
  message: "正在核对章节",
  error_message: null,
  proposal_base_digest: null,
  proposed_segments: [],
  created_at: "2026-09-08T00:00:00Z",
  updated_at: "2026-09-08T00:00:00Z",
};

describe("use_asset_analysis", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(load_asset_analysis).mockResolvedValue({
      segments: [],
      transcript: {
        asset_id: ASSET_ID,
        language: "zh",
        segments: [],
        created_at: "2026-08-24T08:00:00Z",
      },
    });
  });

  it("reuses fresh analysis data when its consumer mounts again", async () => {
    render(
      <ApplicationQueryProvider>
        <AnalysisCacheHarness />
      </ApplicationQueryProvider>,
    );

    expect(await screen.findByText("zh")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "隐藏分析" }));
    fireEvent.click(screen.getByRole("button", { name: "显示分析" }));
    expect(await screen.findByText("zh")).toBeInTheDocument();
    expect(load_asset_analysis).toHaveBeenCalledOnce();
  });

  it("waits for complete chapters before reloading and ignores duplicate generation", async () => {
    vi.mocked(generate_chapters).mockResolvedValue(CHAPTER_JOB);
    vi.mocked(get_analysis).mockResolvedValue({
      ...CHAPTER_JOB,
      stage: "complete",
    });
    const { result } = renderHook(() => use_asset_analysis(ASSET_ID), {
      wrapper: ApplicationQueryProvider,
    });
    await waitFor(() => expect(result.current.is_loading).toBe(false));
    act(() => {
      void result.current.regenerate_chapters();
      void result.current.regenerate_chapters();
    });
    await waitFor(() =>
      expect(result.current.chapter_generation_message).toBe("正在核对章节"),
    );
    expect(load_asset_analysis).toHaveBeenCalledOnce();
    await waitFor(() => expect(load_asset_analysis).toHaveBeenCalledTimes(2), {
      timeout: 3_000,
    });
    expect(generate_chapters).toHaveBeenCalledOnce();
    expect(result.current.chapter_generation_error).toBeNull();
  });

  it("keeps cached chapters and exposes the reason when generation fails", async () => {
    vi.mocked(generate_chapters).mockResolvedValue({
      ...CHAPTER_JOB,
      stage: "failed",
      error_message: "章节边界存在遗漏",
    });
    const { result } = renderHook(() => use_asset_analysis(ASSET_ID), {
      wrapper: ApplicationQueryProvider,
    });
    await waitFor(() => expect(result.current.is_loading).toBe(false));
    await act(() => result.current.regenerate_chapters());
    expect(result.current.chapter_generation_error).toBe("章节边界存在遗漏");
    expect(result.current.chapter_generation_message).toBeNull();
    expect(load_asset_analysis).toHaveBeenCalledOnce();
  });

  it("aborts observation when switching videos and ignores the old response", async () => {
    let resolve_job!: (job: AnalysisJob) => void;
    vi.mocked(generate_chapters).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolve_job = resolve;
        }),
    );
    const { result, rerender } = renderHook(
      ({ asset_id }) => use_asset_analysis(asset_id),
      {
        initialProps: { asset_id: ASSET_ID },
        wrapper: ApplicationQueryProvider,
      },
    );
    act(() => {
      void result.current.regenerate_chapters();
    });
    const signal = vi.mocked(generate_chapters).mock.calls[0][1];
    rerender({ asset_id: "asset-0198d12345677890abcdef1234567892" });
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      resolve_job(CHAPTER_JOB);
    });
    expect(result.current.chapter_generation_message).toBeNull();
    expect(result.current.chapter_generation_error).toBeNull();
    expect(get_analysis).not.toHaveBeenCalled();
  });
});

function AnalysisCacheHarness() {
  const [visible, set_visible] = useState(true);
  return (
    <>
      <button type="button" onClick={() => set_visible((current) => !current)}>
        {visible ? "隐藏分析" : "显示分析"}
      </button>
      {visible ? <AnalysisResult /> : null}
    </>
  );
}

function AnalysisResult() {
  const { transcript } = use_asset_analysis(ASSET_ID);
  return <p>{transcript?.language ?? "正在读取"}</p>;
}
