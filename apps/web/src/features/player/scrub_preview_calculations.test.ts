import { describe, expect, it } from "vitest";

import {
  contained_preview_rect,
  next_preview_quality_scale,
  preview_dimensions,
  storyboard_tile_at,
} from "./scrub_preview_calculations";

describe("scrub preview calculations", () => {
  it("uses player size and density while limiting 4K decode cost", () => {
    expect(preview_dimensions(640, 360, 2)).toEqual({
      width: 1280,
      height: 720,
    });
    expect(preview_dimensions(3840, 2160, 2)).toEqual({
      width: 1920,
      height: 1080,
    });
  });

  it("reduces future preview dimensions after slow 4K decoding", () => {
    const reduced_scale = next_preview_quality_scale(1, 260);
    expect(reduced_scale).toBe(0.8);
    expect(preview_dimensions(1200, 675, 1, reduced_scale)).toEqual({
      width: 960,
      height: 540,
    });
    expect(next_preview_quality_scale(0.625, 500)).toBe(0.625);
    expect(next_preview_quality_scale(0.8, 40)).toBe(0.8);
  });

  it("selects the nearest preceding fallback tile", () => {
    const storyboard = {
      url: "/thumbnails.jpg",
      tile_width: 640,
      tile_height: 360,
      tiles: [
        { start_time: 0, x: 0, y: 0 },
        { start_time: 5, x: 640, y: 0 },
        { start_time: 10, x: 1280, y: 0 },
      ],
    };
    expect(storyboard_tile_at(storyboard, 7.8)?.start_time).toBe(5);
    expect(storyboard_tile_at(storyboard, 0)?.start_time).toBe(0);
  });

  it("contains fallback images without changing their aspect ratio", () => {
    expect(contained_preview_rect(640, 360, 800, 800)).toEqual({
      x: 0,
      y: 175,
      width: 800,
      height: 450,
    });
  });
});
