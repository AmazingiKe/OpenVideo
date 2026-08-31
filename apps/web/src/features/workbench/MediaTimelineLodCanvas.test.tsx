import { describe, expect, it } from "vitest";

import type { MediaTimelineAction } from "./media_timeline_calculations";
import {
  TIMELINE_LOD_VALUES,
  create_timeline_lod_blocks,
  select_timeline_lod,
} from "./MediaTimelineLodCanvas";

function timeline_action({
  end,
  id,
  kind = "transcript",
  selected = false,
  start,
}: {
  end: number;
  id: string;
  kind?: MediaTimelineAction["data"]["kind"];
  selected?: boolean;
  start: number;
}): MediaTimelineAction {
  return {
    id,
    start,
    end,
    effectId: kind,
    selected,
    data: { kind, label: id },
  } as MediaTimelineAction;
}

describe("MediaTimelineLodCanvas", () => {
  it("switches detail levels with hysteresis around both boundaries", () => {
    expect(select_timeline_lod(4, null)).toBe(TIMELINE_LOD_VALUES.overview);
    expect(select_timeline_lod(13, TIMELINE_LOD_VALUES.overview)).toBe(
      TIMELINE_LOD_VALUES.overview,
    );
    expect(select_timeline_lod(14, TIMELINE_LOD_VALUES.overview)).toBe(
      TIMELINE_LOD_VALUES.compact,
    );
    expect(select_timeline_lod(35, TIMELINE_LOD_VALUES.detail)).toBe(
      TIMELINE_LOD_VALUES.detail,
    );
    expect(select_timeline_lod(34, TIMELINE_LOD_VALUES.detail)).toBe(
      TIMELINE_LOD_VALUES.compact,
    );
    expect(select_timeline_lod(40, TIMELINE_LOD_VALUES.compact)).toBe(
      TIMELINE_LOD_VALUES.detail,
    );
  });

  it("keeps individual visible blocks in compact mode", () => {
    const blocks = create_timeline_lod_blocks({
      actions: [
        timeline_action({ id: "outside", start: 0, end: 1 }),
        timeline_action({ id: "first", start: 10, end: 11 }),
        timeline_action({ id: "second", start: 11.1, end: 12 }),
      ],
      canvas_width: 100,
      lod: TIMELINE_LOD_VALUES.compact,
      scroll_left: 100,
      start_left: 0,
      zoom_pixels_per_second: 10,
    });

    expect(blocks).toEqual([
      {
        count: 1,
        kind: "transcript",
        left: 0,
        right: 10,
        selected: false,
      },
      {
        count: 1,
        kind: "transcript",
        left: 11,
        right: 20,
        selected: false,
      },
    ]);
  });

  it("merges nearby actions into density blocks in overview mode", () => {
    const blocks = create_timeline_lod_blocks({
      actions: [
        timeline_action({ id: "first", start: 10, end: 11 }),
        timeline_action({ id: "second", start: 11.2, end: 12 }),
        timeline_action({
          id: "selected",
          start: 20,
          end: 20.1,
          kind: "marker",
          selected: true,
        }),
      ],
      canvas_width: 160,
      lod: TIMELINE_LOD_VALUES.overview,
      scroll_left: 80,
      start_left: 0,
      zoom_pixels_per_second: 8,
    });

    expect(blocks).toEqual([
      {
        count: 2,
        kind: "transcript",
        left: 0,
        right: 16,
        selected: false,
      },
      {
        count: 1,
        kind: "marker",
        left: 80,
        right: 82,
        selected: true,
      },
    ]);
  });
});
