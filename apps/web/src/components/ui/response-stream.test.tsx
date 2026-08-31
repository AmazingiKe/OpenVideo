import { act, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { ResponseStream } from "./response-stream";

describe("ResponseStream", () => {
  it("keeps displayed text when the live target grows", () => {
    vi.useFakeTimers();
    let update_target: ((value: string) => void) | undefined;

    function Harness() {
      const [target, set_target] = useState("你好");
      update_target = set_target;
      return <ResponseStream text_stream={target} />;
    }

    render(<Harness />);
    advance_animation_frames(2);
    expect(screen.getByText("你好")).toBeInTheDocument();

    act(() => update_target?.("你好世界"));
    expect(screen.getByText("你好")).toBeInTheDocument();
    advance_animation_frames(2);
    expect(screen.getByText("你好世界")).toBeInTheDocument();

    vi.useRealTimers();
  });

  it("reports completion after the final buffered character", () => {
    vi.useFakeTimers();
    const on_complete = vi.fn();
    render(
      <ResponseStream
        text_stream="完成"
        stream_live={false}
        on_complete={on_complete}
      />,
    );

    expect(on_complete).not.toHaveBeenCalled();
    advance_animation_frames(2);
    expect(screen.getByText("完成")).toBeInTheDocument();
    expect(on_complete).toHaveBeenCalledOnce();

    vi.useRealTimers();
  });
});

function advance_animation_frames(frame_count: number) {
  for (let index = 0; index < frame_count; index += 1) {
    act(() => vi.advanceTimersByTime(17));
  }
}
