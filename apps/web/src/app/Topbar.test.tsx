import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { Topbar } from "@/app/Topbar";
import { GlobalAssistantProvider } from "@/app/global_assistant";
import { LocalPreferencesProvider } from "@/app/local_preferences";

function render_topbar() {
  return render(
    <LocalPreferencesProvider>
      <MemoryRouter initialEntries={["/markers"]}>
        <GlobalAssistantProvider>
          <Topbar />
        </GlobalAssistantProvider>
      </MemoryRouter>
    </LocalPreferencesProvider>,
  );
}

describe("Topbar", () => {
  it("marks the current workspace link", () => {
    render_topbar();

    expect(
      screen.getByRole("navigation", { name: "工作区导航" }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "标记" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "视频库" })).not.toHaveAttribute(
      "aria-current",
    );
    expect(
      screen
        .getAllByRole("link")
        .filter((link) =>
          ["视频库", "标记", "总结"].includes(link.textContent ?? ""),
        )
        .map((link) => link.textContent),
    ).toEqual(["视频库", "标记", "总结"]);
  });

  it("does not render the removed marker video dropdown", () => {
    render_topbar();

    expect(
      screen.queryByRole("button", { name: "选择标记视频" }),
    ).not.toBeInTheDocument();
  });

  it("toggles the global assistant from one persistent control", () => {
    render_topbar();

    const collapse_button = screen.getByRole("button", {
      name: "收起全局助手",
    });
    expect(collapse_button).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(collapse_button);

    expect(
      screen.getByRole("button", { name: "打开全局助手" }),
    ).toHaveAttribute("aria-pressed", "false");
  });
});
