import { describe, expect, it } from "vitest";
import {
  aggregate_timeline_rows,
  sort_timeline_rows,
  filter_timeline_rows_for_window,
  calculate_timeline_range_viewport,
  create_timeline_aggregator,
  type MediaTimelineAction,
  type TimelineRow,
} from "./media_timeline_calculations";

function action(
  id: string,
  start: number,
  end: number,
  kind: MediaTimelineAction["data"]["kind"] = "transcript",
): MediaTimelineAction {
  return { id, start, end, effectId: kind, data: { kind, label: id } };
}
function rows(actions: MediaTimelineAction[]): TimelineRow[] {
  return sort_timeline_rows([{ id: "track", rowHeight: 32, actions }]);
}

describe("adaptive timeline aggregation", () => {
  it("reuses unchanged tracks after an edit and invalidates their cache on threshold changes", () => {
    const aggregate = create_timeline_aggregator();
    const source = rows([action("a", 0, 1), action("b", 1, 2)]);
    source.push({
      id: "other",
      rowHeight: 48,
      actions: [action("wide", 0, 20)],
    });
    const initial = aggregate(source, 1, 8, {});
    const edited = aggregate(
      [{ ...source[0], actions: [action("replacement", 5, 15)] }, source[1]],
      1,
      8,
      {},
    );
    expect(edited.independent_rows[1]).toBe(initial.independent_rows[1]);
    expect(edited.aggregates).toHaveLength(0);
    const disabled = aggregate(source, 1, 0, {});
    expect(disabled.independent_rows[1]).not.toBe(initial.independent_rows[1]);
    expect(disabled.statistics.rendered_count).toBe(3);
  });
  it("merges only consecutive narrow bars at the inclusive gap boundary", () => {
    const source = rows([
      action("b", 7, 10),
      action("a", 0, 3),
      action("wide", 10, 18),
      action("isolated", 19, 20),
    ]);
    const snapshot = structuredClone(source);
    const result = aggregate_timeline_rows(source, 1, 8);
    expect(
      result.aggregates.map((group) =>
        group.members.map((member) => member.id),
      ),
    ).toEqual([["a", "b"]]);
    expect(result.independent_rows[0].actions.map((item) => item.id)).toEqual([
      "wide",
      "isolated",
    ]);
    expect(result.aggregates[0].members[0]).toBe(source[0].actions[0]);
    expect(result.statistics).toMatchObject({
      source_count: 4,
      rendered_count: 3,
      source_area: 512,
    });
    expect(source).toEqual(snapshot);
    expect(
      aggregate_timeline_rows(
        rows([action("a", 0, 3), action("b", 7.01, 10)]),
        1,
        8,
      ).aggregates,
    ).toHaveLength(0);
  });
  it("disables merging at zero but still clips every track", () => {
    const source = [
      {
        id: "timeline-marker-track",
        actions: [
          action("a", 0, 1),
          action("b", 1, 2),
          action("outside", 100, 101),
        ],
      },
    ];
    const result = aggregate_timeline_rows(source, 1, 0);
    expect(result.aggregates).toHaveLength(0);
    expect(
      filter_timeline_rows_for_window(result.independent_rows, {
        start_seconds: 0,
        end_seconds: 3,
      })[0].actions,
    ).toHaveLength(2);
  });
  it("isolates tracks and types and preserves chapter boundaries", () => {
    const source = rows([
      action("m", 0, 1, "marker"),
      action("t", 1, 2),
      action("e1", 2, 3, "event"),
      action("e2", 3, 4, "event"),
    ]);
    source.push({ id: "second", actions: [action("t2", 2, 3)] });
    expect(aggregate_timeline_rows(source, 1, 8).aggregates).toHaveLength(0);
  });
  it("uses minimum point width and full geometry before clipping", () => {
    const source = rows([
      action("p1", 0, 0, "marker"),
      action("p2", 2, 2, "marker"),
    ]);
    expect(aggregate_timeline_rows(source, 1, 2).aggregates).toHaveLength(0);
    expect(aggregate_timeline_rows(source, 1, 3).aggregates[0].count).toBe(2);
    const result = aggregate_timeline_rows(
      rows([
        action("wide", 0, 100),
        action("a", 100, 101),
        action("b", 101, 102),
      ]),
      1,
      8,
    );
    expect(result.aggregates[0]).toMatchObject({
      start_seconds: 100,
      end_seconds: 102,
      count: 2,
    });
    expect(
      filter_timeline_rows_for_window(result.independent_rows, {
        start_seconds: 99,
        end_seconds: 103,
      })[0].actions[0].id,
    ).toBe("wide");
  });
  it("reports selection without mutating members", () => {
    const source = rows([
      action("a", 0, 1),
      { ...action("b", 1, 2), selected: true },
    ]);
    expect(aggregate_timeline_rows(source, 1, 8).aggregates[0].selected).toBe(
      true,
    );
  });
  it("centers full ranges with padding and respects zoom and media bounds", () => {
    const viewport = calculate_timeline_range_viewport(
      { start_seconds: 100, end_seconds: 110 },
      1032,
      200,
    );
    expect(viewport.zoom_pixels_per_second).toBeCloseTo(1000 / 12);
    expect(
      105 * viewport.zoom_pixels_per_second + 16 - viewport.scroll_left,
    ).toBeCloseTo(516);
    expect(
      calculate_timeline_range_viewport(
        { start_seconds: 0, end_seconds: 0 },
        1032,
        200,
      ),
    ).toEqual({ zoom_pixels_per_second: 320, scroll_left: 0 });
    const end = calculate_timeline_range_viewport(
      { start_seconds: 199, end_seconds: 200 },
      1032,
      200,
    );
    expect(end.scroll_left).toBe(200 * 320 + 16 - 1032);
  });
  it("reduces 2,000 dense actions in a linear scan, with no hidden count rule", () => {
    const source = rows(
      Array.from({ length: 2000 }, (_, index) =>
        action(String(index), index * 1.2, (index + 1) * 1.2),
      ),
    );
    const started = performance.now();
    const merged = aggregate_timeline_rows(source, 0.4, 8);
    const elapsed = performance.now() - started;
    expect(merged.statistics.rendered_count).toBe(1);
    expect(
      aggregate_timeline_rows(source, 0.4, 0).statistics.rendered_count,
    ).toBe(2000);
    expect(elapsed).toBeLessThan(1000);
  });
});
