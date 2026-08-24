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

    const slider = screen.getByRole("slider", { name: "向前范围" });
    expect(slider).toHaveAttribute("data-disabled");
    expect(screen.getByText("使用默认（当前 10 秒）")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "向前范围：单独设置" }));
    expect(slider).not.toHaveAttribute("data-disabled");
    expect(screen.getByText("10 秒")).toBeInTheDocument();

    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(screen.getByText("15 秒")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "向前范围：使用默认" }));
    expect(slider).toHaveAttribute("data-disabled");
    expect(screen.getByText("使用默认（当前 10 秒）")).toBeInTheDocument();
  });
});
