import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  download_formula_model,
  get_formula_model_download,
} from "@/shared/api";
import { FormulaRecognitionSettings } from "./FormulaRecognitionSettings";

vi.mock("@/shared/api", () => ({
  download_formula_model: vi.fn(),
  get_formula_model_download: vi.fn(),
}));

const MODEL = {
  name: "视频公式识别",
  description: "从关键帧提取结构化公式。",
  repositories: [
    "PaddlePaddle/PP-DocLayout_plus-L",
    "PaddlePaddle/PP-FormulaNet_plus-S",
  ],
  installation_status: "not_installed" as const,
  download_job: null,
};

describe("FormulaRecognitionSettings", () => {
  it("downloads one formula capability without exposing an enable switch", async () => {
    const job = {
      job_id: "formula-model-download-019c0000000070008000000000000000",
      stage: "pending" as const,
      progress_percent: 0,
      downloaded_bytes: 0,
      total_bytes: null,
      message: "等待下载",
      error_message: null,
      created_at: "2026-08-30T00:00:00Z",
      updated_at: "2026-08-30T00:00:00Z",
    };
    vi.mocked(download_formula_model).mockResolvedValue(job);
    vi.mocked(get_formula_model_download).mockResolvedValue({
      ...job,
      stage: "complete",
      progress_percent: 100,
    });
    const on_change = vi.fn();

    render(<FormulaRecognitionSettings model={MODEL} on_change={on_change} />);
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "下载公式模型" }));

    await waitFor(() => expect(download_formula_model).toHaveBeenCalled());
    expect(on_change).toHaveBeenCalledWith(
      expect.objectContaining({ installation_status: "downloading" }),
    );
  });
});
