import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApplicationQueryProvider } from "@/app/query_cache";
import { get_analysis } from "@/shared/api";
import { generate_chapters } from "@/shared/api/analysis";
import { DEFAULT_ANALYSIS_STRATEGY } from "@/shared/analysis";
import type { AnalysisJob, MediaSegment } from "@/shared/types";
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
const NEXT_ASSET_ID = "asset-0198d12345677890abcdef1234567892";
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
    const saved_segments = [
      create_segment("sampled"),
      create_segment("failed"),
    ];
    vi.mocked(load_asset_analysis).mockResolvedValue({
      segments: saved_segments,
      transcript: null,
    });
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
    expect(result.current.segments).toEqual(saved_segments);
    expect(load_asset_analysis).toHaveBeenCalledOnce();
  });

  it("retains saved visual statuses after successful generation, remount, and reload", async () => {
    const saved_segments = [
      create_segment("sampled"),
      create_segment("failed"),
    ];
    vi.mocked(load_asset_analysis)
      .mockResolvedValueOnce({
        segments: [create_segment("unknown")],
        transcript: null,
      })
      .mockResolvedValue({ segments: saved_segments, transcript: null });
    vi.mocked(generate_chapters).mockResolvedValue({
      ...CHAPTER_JOB,
      stage: "complete",
      proposed_segments: [create_segment("sampled")],
    });
    const view = render(
      <ApplicationQueryProvider>
        <AnalysisCacheHarness />
      </ApplicationQueryProvider>,
    );

    expect(await screen.findByText("unknown")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "生成章节" }));
    expect(await screen.findByText("sampled,failed")).toBeInTheDocument();
    expect(load_asset_analysis).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "隐藏分析" }));
    fireEvent.click(screen.getByRole("button", { name: "显示分析" }));
    expect(await screen.findByText("sampled,failed")).toBeInTheDocument();
    expect(load_asset_analysis).toHaveBeenCalledTimes(2);

    view.unmount();
    render(
      <ApplicationQueryProvider>
        <AnalysisCacheHarness />
      </ApplicationQueryProvider>,
    );
    expect(await screen.findByText("sampled,failed")).toBeInTheDocument();
    expect(load_asset_analysis).toHaveBeenCalledTimes(3);
    expect(generate_chapters).toHaveBeenCalledOnce();
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
    rerender({ asset_id: NEXT_ASSET_ID });
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      resolve_job(CHAPTER_JOB);
    });
    expect(result.current.chapter_generation_message).toBeNull();
    expect(result.current.chapter_generation_error).toBeNull();
    expect(get_analysis).not.toHaveBeenCalled();
  });

  it.each(["complete", "failed"] as const)(
    "ignores a late %s poll after switching videos without clearing the new generation",
    async (stage) => {
      let resolve_old_poll!: (job: AnalysisJob) => void;
      let resolve_new_job!: (job: AnalysisJob) => void;
      vi.mocked(load_asset_analysis).mockImplementation(async (asset_id) => ({
        segments: [
          create_segment(
            asset_id === ASSET_ID ? "sampled" : "unknown",
            asset_id,
          ),
        ],
        transcript: null,
      }));
      vi.mocked(generate_chapters)
        .mockResolvedValueOnce(CHAPTER_JOB)
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolve_new_job = resolve;
            }),
        );
      vi.mocked(get_analysis).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolve_old_poll = resolve;
          }),
      );
      const { result, rerender } = renderHook(
        ({ asset_id }) => ({
          ...use_asset_analysis(asset_id),
          query_client: useQueryClient(),
        }),
        {
          initialProps: { asset_id: ASSET_ID },
          wrapper: ApplicationQueryProvider,
        },
      );
      await waitFor(() => expect(result.current.is_loading).toBe(false));
      const invalidate = vi.spyOn(
        result.current.query_client,
        "invalidateQueries",
      );
      let old_generation!: Promise<void>;
      act(() => {
        old_generation = result.current.regenerate_chapters();
      });
      await waitFor(() => expect(get_analysis).toHaveBeenCalledOnce(), {
        timeout: 3_000,
      });
      const old_signal = vi.mocked(get_analysis).mock.calls[0][1];

      rerender({ asset_id: NEXT_ASSET_ID });
      await waitFor(() => expect(result.current.is_loading).toBe(false));
      expect(old_signal?.aborted).toBe(true);
      let new_generation!: Promise<void>;
      act(() => {
        new_generation = result.current.regenerate_chapters();
      });
      await act(async () => {
        resolve_old_poll({
          ...CHAPTER_JOB,
          stage,
          error_message: stage === "failed" ? "旧视频生成失败" : null,
        });
        await old_generation;
      });
      expect(result.current.chapter_generation_message).toBe("正在生成章节…");
      expect(result.current.chapter_generation_error).toBeNull();
      expect(result.current.segments).toEqual([
        create_segment("unknown", NEXT_ASSET_ID),
      ]);
      expect(load_asset_analysis).toHaveBeenCalledTimes(2);
      expect(invalidate).not.toHaveBeenCalled();

      await act(async () => {
        resolve_new_job({
          ...CHAPTER_JOB,
          asset_id: NEXT_ASSET_ID,
          stage: "complete",
        });
        await new_generation;
      });
      expect(result.current.chapter_generation_message).toBeNull();
      expect(load_asset_analysis).toHaveBeenCalledTimes(3);
      expect(load_asset_analysis).toHaveBeenLastCalledWith(
        NEXT_ASSET_ID,
        expect.any(AbortSignal),
      );
      expect(get_analysis).toHaveBeenCalledOnce();
      expect(invalidate).toHaveBeenCalledExactlyOnceWith({
        queryKey: ["asset_analysis", NEXT_ASSET_ID],
      });
    },
  );

  it("aborts a pending poll on unmount and does not reload for its late completion", async () => {
    let resolve_poll!: (job: AnalysisJob) => void;
    vi.mocked(generate_chapters).mockResolvedValue(CHAPTER_JOB);
    vi.mocked(get_analysis).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolve_poll = resolve;
        }),
    );
    const { result, unmount } = renderHook(
      () => ({
        ...use_asset_analysis(ASSET_ID),
        query_client: useQueryClient(),
      }),
      { wrapper: ApplicationQueryProvider },
    );
    await waitFor(() => expect(result.current.is_loading).toBe(false));
    const invalidate = vi.spyOn(
      result.current.query_client,
      "invalidateQueries",
    );
    let generation!: Promise<void>;
    act(() => {
      generation = result.current.regenerate_chapters();
    });
    await waitFor(() => expect(get_analysis).toHaveBeenCalledOnce(), {
      timeout: 3_000,
    });
    const signal = vi.mocked(get_analysis).mock.calls[0][1];
    unmount();
    expect(signal?.aborted).toBe(true);

    await act(async () => {
      resolve_poll({ ...CHAPTER_JOB, stage: "complete" });
      await generation;
    });
    expect(load_asset_analysis).toHaveBeenCalledOnce();
    expect(get_analysis).toHaveBeenCalledOnce();
    expect(invalidate).not.toHaveBeenCalled();
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
  const { transcript, segments, regenerate_chapters } =
    use_asset_analysis(ASSET_ID);
  return (
    <>
      <p>{transcript?.language ?? "正在读取"}</p>
      <p>
        {segments.map((segment) => segment.visual_analysis_status).join(",")}
      </p>
      <button type="button" onClick={() => void regenerate_chapters()}>
        生成章节
      </button>
    </>
  );
}

function create_segment(
  visual_analysis_status: MediaSegment["visual_analysis_status"],
  asset_id = ASSET_ID,
): MediaSegment {
  return {
    segment_id: "segment-0198d12345677890abcdef1234567893",
    asset_id,
    start_seconds: 0,
    end_seconds: 10,
    title: "已保存章节",
    detailed_summary: null,
    transcript_text: null,
    speaker_name: null,
    key_frame_paths: ["artifacts/frame.jpg"],
    visual_description: null,
    visual_analysis_status,
    ocr_text: null,
    formula_latex: [],
    marker_ids: [],
    tags: [],
  };
}
