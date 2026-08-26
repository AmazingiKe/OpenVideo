import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { MarkerRangeField } from "./MarkerRangeField";

describe("MarkerRangeField", () => {
  it("switches one side between inherited and explicit values", () => {
    function Harness() {
      const [value, set_value] = useState<number | null>(null);
      return (
        <MarkerRangeField
          id="before-range"
          label="向前范围"
          value={value}
          default_value={10}
          on_change={set_value}
        />
      );
    }

    render(<Harness />);

    const slider = screen.getByRole("slider", { name: "向前范围秒数" });
    expect(slider).toHaveAttribute("data-disabled");
    expect(screen.getByText("跟随当前分析策略")).toBeInTheDocument();
    expect(screen.getByText("默认 · 10 秒")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "向前范围自定义" }));
    expect(slider).not.toHaveAttribute("data-disabled");
    expect(screen.getByText("仅覆盖这个标记")).toBeInTheDocument();
    expect(slider).toHaveAttribute("aria-valuenow", "10");

    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(screen.getByText("15 秒")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "向前范围跟随策略" }));
    expect(slider).toHaveAttribute("data-disabled");
    expect(screen.getByText("默认 · 10 秒")).toBeInTheDocument();
  });
});
