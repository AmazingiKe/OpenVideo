import { useContext, useEffect, useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { Link, MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { WorkspaceActiveContext } from "./workspace_activity";
import { WorkspaceRouter } from "./WorkspaceRouter";

const lifecycle = vi.hoisted(() => ({
  mounted: vi.fn(),
  unmounted: vi.fn(),
}));

function TestWorkspace({ name }: { name: string }) {
  const [draft, set_draft] = useState("");
  const active = useContext(WorkspaceActiveContext);
  useEffect(() => {
    lifecycle.mounted(name);
    return () => lifecycle.unmounted(name);
  }, [name]);
  return (
    <label>
      {name}
      <input
        value={draft}
        onChange={(event) => set_draft(event.target.value)}
        data-active={active}
      />
    </label>
  );
}

vi.mock("@/pages/LibraryPage", () => ({
  LibraryPage: () => <TestWorkspace name="library" />,
}));
vi.mock("@/pages/MarkersPage", () => ({
  MarkersPage: () => <TestWorkspace name="markers" />,
}));
vi.mock("@/pages/SummaryPage", () => ({
  SummaryPage: () => <TestWorkspace name="summary" />,
}));
vi.mock("@/features/settings/SettingsPage", () => ({
  SettingsPage: () => <TestWorkspace name="settings" />,
}));

describe("WorkspaceRouter", () => {
  it("retains drafts, DOM and scroll containers without restarting page effects", async () => {
    lifecycle.mounted.mockClear();
    lifecycle.unmounted.mockClear();
    const { unmount } = render(
      <MemoryRouter initialEntries={["/library"]}>
        <nav>
          <Link to="/library">视频库</Link>
          <Link to="/markers/asset-one">标记</Link>
          <Link to="/summary">总结</Link>
          <Link to="/settings">设置</Link>
        </nav>
        <WorkspaceRouter />
      </MemoryRouter>,
    );

    const library = await screen.findByRole("textbox", { name: "library" });
    const library_container = library.closest("div")!;
    library_container.scrollTop = 240;
    fireEvent.change(library, { target: { value: "搜索条件" } });
    expect(lifecycle.mounted).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("link", { name: "标记" }));
    const markers = await screen.findByRole("textbox", { name: "markers" });
    fireEvent.change(markers, { target: { value: "选中的标记" } });
    expect(library).not.toBeVisible();
    expect(library_container).toHaveAttribute("inert");
    expect(library).toHaveAttribute("data-active", "false");

    fireEvent.click(screen.getByRole("link", { name: "总结" }));
    const summary = await screen.findByRole("textbox", { name: "summary" });
    fireEvent.change(summary, { target: { value: "未完成的草稿" } });

    for (const name of ["视频库", "标记", "总结", "设置", "总结"]) {
      fireEvent.click(screen.getByRole("link", { name }));
      if (name === "设置")
        await screen.findByRole("textbox", { name: "settings" });
    }
    expect(screen.getByRole("textbox", { name: "summary" })).toBe(summary);
    expect(summary).toHaveValue("未完成的草稿");
    expect(markers).toHaveValue("选中的标记");
    expect(library).toHaveValue("搜索条件");
    expect(library_container.scrollTop).toBe(240);
    expect(lifecycle.mounted).toHaveBeenCalledTimes(4);
    expect(lifecycle.unmounted).not.toHaveBeenCalled();

    unmount();
    expect(lifecycle.unmounted).toHaveBeenCalledTimes(4);
  });
});
