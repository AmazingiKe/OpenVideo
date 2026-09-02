import { afterEach, describe, expect, it, vi } from "vitest";

import { record_scrub_preview_metrics } from "./scrub_preview_diagnostics";

afterEach(() => vi.restoreAllMocks());

describe("record_scrub_preview_metrics", () => {
  it("records decode and range diagnostics in the Performance Timeline", () => {
    const measure = vi.spyOn(performance, "measure");
    record_scrub_preview_metrics({
      mode: "webcodecs",
      requested_time_seconds: 12,
      frame_time_seconds: 11.98,
      frame_duration_seconds: 0.04,
      decode_milliseconds: 18,
      range_request_count: 3,
      bytes_read: 8192,
      preview_width: 1280,
      preview_height: 720,
    });

    expect(measure).toHaveBeenCalledWith(
      "openvideo.scrub-preview",
      expect.objectContaining({
        duration: 18,
        detail: expect.objectContaining({ range_request_count: 3 }),
      }),
    );
  });
});
