import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_ANALYSIS_STRATEGY } from "@/shared/analysis";
import { analyze_asset, list_analysis_tasks } from "./analysis";

afterEach(() => vi.restoreAllMocks());

describe("analysis task API", () => {
  it("reads existing task snapshots with a bounded history and abort signal", async () => {
    const snapshots = [
      {
        job: { job_id: "job-existing", stage: "transcribing" },
        transcription_options: null,
      },
    ];
    const fetch_mock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json(snapshots));
    const controller = new AbortController();
    await expect(list_analysis_tasks(50, controller.signal)).resolves.toEqual(
      snapshots,
    );
    expect(fetch_mock).toHaveBeenCalledWith("/api/analysis?limit=50", {
      signal: controller.signal,
    });
  });

  it("preserves the selected model and strategy for an explicitly retried analysis", async () => {
    const fetch_mock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ job_id: "job-new" }, { status: 202 }));
    const options = {
      mode: "full",
      ai_model_id: "model-original",
      strategy: DEFAULT_ANALYSIS_STRATEGY,
    } as const;
    await expect(analyze_asset("asset-original", options)).resolves.toEqual({
      job_id: "job-new",
    });
    expect(fetch_mock).toHaveBeenCalledWith(
      "/api/media/assets/asset-original/analyze",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: true, ...options }),
        signal: undefined,
      },
    );
  });
});
