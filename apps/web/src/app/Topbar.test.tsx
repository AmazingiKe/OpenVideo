import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { Topbar } from "@/app/Topbar";

describe("Topbar", () => {
  it("marks the current workspace link", () => {
    render(
      <MemoryRouter initialEntries={["/markers"]}>
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
    expect(
      screen
        .getAllByRole("link")
        .filter((link) =>
          ["下载", "视频库", "标记", "解析"].includes(link.textContent ?? ""),
        )
        .map((link) => link.textContent),
    ).toEqual(["下载", "视频库", "标记", "解析"]);
  });
});
