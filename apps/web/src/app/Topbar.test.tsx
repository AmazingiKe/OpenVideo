import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";

import { Topbar } from "@/app/Topbar";
import { GlobalAssistantProvider } from "@/app/global_assistant";

function render_topbar() {
  return render(
    <MemoryRouter initialEntries={["/markers"]}>
      <GlobalAssistantProvider>
        <Topbar />
      </GlobalAssistantProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  document.documentElement.classList.remove("dark");
  document.documentElement.removeAttribute("data-color-scheme-source");
});

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

  it("switches between light and dark color schemes", () => {
    render_topbar();

    const dark_mode_button = screen.getByRole("button", {
      name: "切换到深色模式",
    });
    expect(dark_mode_button).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(dark_mode_button);

    expect(document.documentElement).toHaveClass("dark");
    expect(
      screen.getByRole("button", { name: "切换到浅色模式" }),
    ).toHaveAttribute("aria-pressed", "true");
  });
});
