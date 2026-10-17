import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  get_transcript_version,
  list_transcript_versions,
  restore_transcript_version,
} from "@/shared/api/transcript_history";
import { TranscriptHistory } from "./TranscriptHistory";
vi.mock("@/shared/api/transcript_history", () => ({
  get_transcript_version: vi.fn(),
  list_transcript_versions: vi.fn(),
  restore_transcript_version: vi.fn(),
}));
const VERSION_ID = "transcript-version-019c0000000070008000000000000001";
const TRANSCRIPT = {
  asset_id: "asset",
  language: "zh",
  created_at: "2026-10-17T12:00:00Z",
  segments: [
    {
      start_seconds: 0,
      end_seconds: 3,
      text: "人工修订",
      emotion: null,
      audio_events: [],
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(list_transcript_versions).mockResolvedValue([
    {
      version_id: VERSION_ID,
      saved_at: TRANSCRIPT.created_at,
      reason: "replacement",
      segment_count: 1,
    },
  ]);
  vi.mocked(get_transcript_version).mockResolvedValue(TRANSCRIPT);
  vi.mocked(restore_transcript_version).mockResolvedValue(TRANSCRIPT);
  Element.prototype.scrollIntoView = vi.fn();
});

async function select_version() {
  fireEvent.click(screen.getByRole("button", { name: "字幕历史" }));
  const select = await screen.findByRole("combobox", { name: "历史版本" });
  select.hasPointerCapture = () => false;
  select.setPointerCapture = vi.fn();
  select.releasePointerCapture = vi.fn();
  fireEvent.pointerDown(select, { button: 0, pointerType: "mouse" });
  fireEvent.click(screen.getByRole("option"));
  await screen.findByText("人工修订");
}

describe("transcript history", () => {
  it("loads on demand, previews before restore, and refreshes the current transcript", async () => {
    const restored = vi.fn();
    render(<TranscriptHistory asset_id="asset" on_restored={restored} />);
    expect(list_transcript_versions).not.toHaveBeenCalled();
    await select_version();
    expect(restore_transcript_version).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "恢复此版本" }));
    expect(screen.getByRole("button", { name: "正在恢复…" })).toBeDisabled();
    await waitFor(() => expect(restored).toHaveBeenCalledOnce());
    expect(restore_transcript_version).toHaveBeenCalledWith(
      "asset",
      VERSION_ID,
      expect.any(AbortSignal),
    );
    await screen.findByText("已恢复字幕，恢复前的内容也已保存在历史中。");
  });
  it("keeps the preview and reports failed restoration without claiming success", async () => {
    vi.mocked(restore_transcript_version).mockRejectedValue(
      new Error("当前任务仍在运行"),
    );
    const restored = vi.fn();
    render(<TranscriptHistory asset_id="asset" on_restored={restored} />);
    await select_version();
    fireEvent.click(screen.getByRole("button", { name: "恢复此版本" }));
    await screen.findByText("当前任务仍在运行");
    expect(screen.getByText("人工修订")).toBeVisible();
    expect(restored).not.toHaveBeenCalled();
  });
});
