import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MediaTimelineAggregateCanvas } from "./MediaTimelineAggregateCanvas";

afterEach(() => vi.restoreAllMocks());

describe("MediaTimelineAggregateCanvas", () => {
  it("reads its global tokens directly from the document root", () => {
    const root_style = {
      getPropertyValue: vi.fn((property: string) => {
        if (property === "--timeline-ruler-font") return "ruler-font";
        if (property === "--timeline-count-font") return "count-font";
        return "4";
      }),
    } as unknown as CSSStyleDeclaration;
    const read_style = vi
      .spyOn(window, "getComputedStyle")
      .mockReturnValue(root_style);
    const { container, rerender } = render(
      <MediaTimelineAggregateCanvas
        aggregates={[]}
        canvas_width={800}
        scroll_left={0}
        scroll_top={0}
        on_select={vi.fn()}
        on_zoom={vi.fn()}
      />,
    );
    const canvas = container.querySelector("canvas")!;
    expect(read_style).toHaveBeenCalledTimes(2);
    expect(
      read_style.mock.calls.every(
        ([element]) => element === document.documentElement,
      ),
    ).toBe(true);
    expect(canvas.getContext("2d")?.font).toBe("ruler-font");
    expect(root_style.getPropertyValue).toHaveBeenCalledWith(
      "--timeline-color-marker-border",
    );
    expect(root_style.getPropertyValue).toHaveBeenCalledWith(
      "--timeline-count-font",
    );

    rerender(
      <MediaTimelineAggregateCanvas
        aggregates={[]}
        canvas_width={800}
        scroll_left={100}
        scroll_top={0}
        on_select={vi.fn()}
        on_zoom={vi.fn()}
      />,
    );
    expect(read_style).toHaveBeenCalledTimes(2);
  });
});
