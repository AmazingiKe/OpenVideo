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

  it("selects the nearest preceding tile from the correct page", () => {
    const storyboard = {
      storyboard_id: "storyboard-test",
      tile_width: 640,
      tile_height: 360,
      interval_seconds: 5,
      columns: 2,
      total_tiles: 5,
      pages: [
        { url: "/page-1.jpg", start_index: 0, tile_count: 4 },
        { url: "/page-2.jpg", start_index: 4, tile_count: 1 },
      ],
    };
    expect(storyboard_tile_at(storyboard, 7.8)).toEqual({
      url: "/page-1.jpg",
      start_time: 5,
      duration: 5,
      x: 640,
      y: 0,
    });
    expect(storyboard_tile_at(storyboard, 25)).toEqual({
      url: "/page-2.jpg",
      start_time: 20,
      duration: 5,
      x: 0,
      y: 0,
    });
  });

  it("contains storyboard tiles without changing their aspect ratio", () => {
    expect(contained_preview_rect(640, 360, 800, 800)).toEqual({
      x: 0,
      y: 175,
      width: 800,
      height: 450,
    });
  });
});
