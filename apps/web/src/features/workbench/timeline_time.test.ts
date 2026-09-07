import { describe, expect, it } from "vitest";
import { format_timeline_time } from "./timeline_time";

describe("timeline time", () => {
  it.each([
    [0, "00:00:00.000"],
    [0.125, "00:00:00.125"],
    [0.9996, "00:00:01.000"],
    [59.9996, "00:01:00.000"],
    [3599.9996, "01:00:00.000"],
    [3601.234, "01:00:01.234"],
    [-1, "00:00:00.000"],
  ])("formats %s with millisecond carry", (time, expected) => {
    expect(format_timeline_time(time)).toBe(expected);
  });
  it("shows total duration with whole seconds", () => {
    expect(format_timeline_time(3661.999, { milliseconds: false })).toBe(
      "01:01:01",
    );
  });
});
