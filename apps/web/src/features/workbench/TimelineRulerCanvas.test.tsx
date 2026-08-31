import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { apply_user_color_scheme } from "@/color_scheme";
import {
  create_visible_timeline_ruler_ticks,
  format_timeline_ruler_time,
  select_timeline_ruler_interval,
  timeline_ruler_bitmap_size,
  TimelineRulerCanvas,
} from "./TimelineRulerCanvas";

const DEFAULT_DEVICE_PIXEL_RATIO = window.devicePixelRatio;

describe("TimelineRulerCanvas", () => {
  afterEach(() => {
    Object.defineProperty(window, "devicePixelRatio", {
      configurable: true,
      value: DEFAULT_DEVICE_PIXEL_RATIO,
    });
    document.documentElement.classList.remove("dark");
    document.documentElement.removeAttribute("data-color-scheme-source");
    vi.restoreAllMocks();
  });

  it("keeps the current major interval inside the hysteresis range", () => {
    expect(select_timeline_ruler_interval(80, null)).toBe(1);
    expect(select_timeline_ruler_interval(179, 1)).toBe(1);
    expect(select_timeline_ruler_interval(181, 1)).toBe(0.5);
    expect(select_timeline_ruler_interval(30, 2)).toBe(2);
    expect(select_timeline_ruler_interval(29.9, 2)).toBe(5);
  });

  it("generates only visible ticks with stable major labels", () => {
    const ticks = create_visible_timeline_ruler_ticks({
      canvas_width: 800,
      duration_seconds: 120,
      major_interval_seconds: 1,
      scroll_left: 1_600,
      start_left: 16,
      zoom_pixels_per_second: 80,
    });

    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.every((tick) => tick.x >= 0 && tick.x <= 800)).toBe(true);
    expect(ticks.find((tick) => tick.seconds === 20)).toEqual({
      seconds: 20,
      x: 16,
      is_major: true,
      label: "00:20",
    });
    expect(
      ticks.find((tick) => Math.abs(tick.seconds - 20.2) < 1e-9)?.label,
    ).toBeNull();
    expect(ticks[0]?.seconds).toBeGreaterThanOrEqual(19.8);
    expect(ticks.at(-1)?.seconds).toBeLessThanOrEqual(29.8);
  });

  it("formats subsecond, second, and hour boundaries", () => {
    expect(format_timeline_ruler_time(0)).toBe("0.00s");
    expect(format_timeline_ruler_time(0.999)).toBe("1.00s");
    expect(format_timeline_ruler_time(1)).toBe("00:01");
    expect(format_timeline_ruler_time(3_600)).toBe("01:00:00");
  });

  it("sizes and draws the bitmap at the current device pixel ratio", () => {
    const context = {
      beginPath: vi.fn(),
      clearRect: vi.fn(),
      fillText: vi.fn(),
      lineTo: vi.fn(),
      moveTo: vi.fn(),
      setTransform: vi.fn(),
      stroke: vi.fn(),
      fillStyle: "",
      font: "",
      lineWidth: 0,
      strokeStyle: "",
      textAlign: "start",
      textBaseline: "alphabetic",
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      context as unknown as CanvasRenderingContext2D,
    );
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      getPropertyValue: (property_name: string) => {
        if (property_name === "--timeline-color-ruler-tick") return "tick";
        if (property_name === "--timeline-color-ruler-text") return "text";
        if (property_name === "--timeline-ruler-font") return "10px monospace";
        return "";
      },
    } as CSSStyleDeclaration);
    Object.defineProperty(window, "devicePixelRatio", {
      configurable: true,
      value: 2,
    });

    const { container } = render(
      <TimelineRulerCanvas
        canvas_width={123.5}
        duration_seconds={10}
        scroll_left={0}
        start_left={16}
        zoom_pixels_per_second={80}
      />,
    );
    const canvas = container.querySelector("canvas");

    expect(timeline_ruler_bitmap_size(123.5, 32, 2)).toEqual({
      width: 247,
      height: 64,
    });
    expect(canvas).toHaveAttribute("width", "247");
    expect(canvas).toHaveAttribute("height", "64");
    expect(context.setTransform).toHaveBeenCalledWith(2, 0, 0, 2, 0, 0);
    expect(context.clearRect).toHaveBeenCalledWith(0, 0, 123.5, 32);
    expect(context.fillText).toHaveBeenCalled();

    const draw_count = context.clearRect.mock.calls.length;
    act(() => {
      apply_user_color_scheme(document, "dark");
    });
    expect(context.clearRect.mock.calls.length).toBeGreaterThan(draw_count);
  });
});
