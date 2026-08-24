import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { Topbar } from "@/app/Topbar";

describe("Topbar", () => {
  it("marks the current workspace link", () => {
    render(
      <MemoryRouter initialEntries={["/analysis"]}>
        <Topbar />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("navigation", { name: "工作区导航" }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "标记" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "下载" })).not.toHaveAttribute(
      "aria-current",
    );
  });
});
