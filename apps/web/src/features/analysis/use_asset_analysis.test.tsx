import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApplicationQueryProvider } from "@/app/query_cache";
import { load_asset_analysis } from "@/shared/load_asset_analysis";
import { use_asset_analysis } from "./use_asset_analysis";

vi.mock("@/shared/api", () => ({
  update_transcript_segment: vi.fn(),
}));

vi.mock("@/shared/load_asset_analysis", () => ({
  load_asset_analysis: vi.fn(),
}));

const ASSET_ID = "asset-0198d12345677890abcdef1234567890";

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
