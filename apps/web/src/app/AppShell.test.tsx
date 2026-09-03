import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { AppShell } from "./AppShell";

vi.mock("@/app/Topbar", () => ({ Topbar: () => <header>OpenVideo</header> }));
vi.mock("@/app/global_assistant", () => ({
  GlobalAssistantLayout: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/app/GlobalMediaImport", () => ({ GlobalMediaImport: () => null }));
vi.mock("@/app/library", () => ({
  use_library_state: () => ({ library: null }),
}));
function render_shell(pathname: string) {
  render(
    <MemoryRouter initialEntries={[pathname]}>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="*" element={<div>工作区</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
  return screen.getByRole("main");
}

describe("AppShell", () => {
  it.each(["/markers", "/markers/asset-id", "/summary"])(
    "keeps %s inside the fixed-height workspace",
    (pathname) => {
      const workspace = render_shell(pathname);

      expect(workspace).toHaveClass("row-start-2");
      expect(workspace).toHaveClass("overflow-hidden");
      expect(workspace).not.toHaveClass("overflow-auto");
    },
  );

  it("keeps document pages scrollable", () => {
    const workspace = render_shell("/library");

    expect(workspace).toHaveClass("overflow-auto");
  });
});
