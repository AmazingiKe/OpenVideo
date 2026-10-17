import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  check_transcription,
  type TranscriptionPreflight,
} from "@/shared/api/transcription_preflight";
import { use_transcription_preflight } from "./use_transcription_preflight";
import type { TranscriptionOptions } from "@/shared/types";

vi.mock("@/shared/api/transcription_preflight", () => ({
  check_transcription: vi.fn(),
}));
const OPTIONS: TranscriptionOptions = {
  engine: "faster-whisper",
  model: "small",
  device: "cpu",
  compute_type: "int8",
  language: null,
};

describe("transcription preflight", () => {
  it("ignores an older check after changing the selection and aborts on close", async () => {
    let resolve_first!: (result: TranscriptionPreflight) => void;
    vi.mocked(check_transcription).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolve_first = resolve;
        }),
    );
    vi.mocked(check_transcription).mockResolvedValueOnce({
      ready: false,
      issues: ["新素材不可用"],
      notes: [],
    });
    const { result, rerender } = renderHook(
      ({ ids, enabled }) => use_transcription_preflight(enabled, ids, OPTIONS),
      { initialProps: { ids: ["first"], enabled: true } },
    );
    const first_signal = vi.mocked(check_transcription).mock.calls[0][2];
    rerender({ ids: ["second", "third"], enabled: true });
    expect(first_signal.aborted).toBe(true);
    await waitFor(() =>
      expect(result.current.check?.issues).toEqual(["新素材不可用"]),
    );
    await act(async () =>
      resolve_first({ ready: true, issues: [], notes: [] }),
    );
    expect(result.current.check?.ready).toBe(false);
    expect(check_transcription).toHaveBeenLastCalledWith(
      ["second", "third"],
      OPTIONS,
      expect.any(AbortSignal),
    );
    const last_signal = vi.mocked(check_transcription).mock.calls.at(-1)![2];
    rerender({ ids: ["second", "third"], enabled: false });
    expect(last_signal.aborted).toBe(true);
    expect(result.current.check).toBeNull();
  });
});
