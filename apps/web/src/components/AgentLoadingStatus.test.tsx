import { render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentLoadingStatus, format_elapsed_time } from "./AgentLoadingStatus";

describe("AgentLoadingStatus", () => {
  afterEach(() => vi.useRealTimers());

  it("counts elapsed loading time without announcing every tick", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T08:00:00Z"));
    const started_at = Date.now();

    render(
      <AgentLoadingStatus label="正在处理当前问题" started_at={started_at} />,
    );

    expect(
      screen.getByRole("status", { name: "正在处理当前问题" }),
    ).toBeVisible();
    expect(screen.getByText("00:00").parentElement).toHaveAttribute(
      "aria-hidden",
      "true",
    );

    act(() => vi.advanceTimersByTime(5_000));

    expect(screen.getByText("00:05")).toBeVisible();
  });

  it("formats long-running tasks with hours", () => {
    expect(format_elapsed_time(3_725)).toBe("01:02:05");
  });
});
