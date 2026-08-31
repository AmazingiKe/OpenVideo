import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type ReactNode } from "react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  GlobalAssistantLayout,
  GlobalAssistantProvider,
  GlobalAssistantRegistration,
  use_global_assistant_controls,
} from "@/app/global_assistant";

vi.mock("@/app/asset_catalog", () => ({
  use_asset_catalog: () => ({
    selected_asset: {
      asset_id: "asset-0198f10e3f9871239c79000000000001",
      title: "当前视频",
    },
    selected_asset_id: "asset-0198f10e3f9871239c79000000000001",
  }),
}));

vi.mock("@/features/workbench/use_processing_resources", () => ({
  use_agent_preferences: () => ({
    agent_preferences: { default_thinking_mode: "fast" },
    error: null,
  }),
  use_ai_models: () => ({ models: [], error: null }),
}));

vi.mock("@/components/AgentPanel", () => ({
  AgentPanel: ({
    agent_id,
    context_label,
  }: {
    agent_id: string;
    context_label: string;
  }) => (
    <div aria-label="助手面板" data-agent-id={agent_id}>
      {context_label}
    </div>
  ),
}));

function set_compact_layout(compact: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: compact,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
}

function Workspace({
  agent_id,
  context_label,
}: {
  agent_id: string;
  context_label: string;
}) {
  return (
    <>
      <GlobalAssistantRegistration
        binding={{ agent_id, asset_id: null, context_label }}
      />
      <Link to={agent_id === "marker" ? "/summary" : "/markers"}>
        切换工作区
      </Link>
    </>
  );
}

function OpenAssistantButton() {
  const { open_assistant } = use_global_assistant_controls();
  return <button onClick={open_assistant}>打开助手</button>;
}

function render_assistant(children?: ReactNode) {
  return render(
    <MemoryRouter initialEntries={["/markers"]}>
      <GlobalAssistantProvider>
        <GlobalAssistantLayout>
          {children ?? (
            <Routes>
              <Route
                path="/markers"
                element={
                  <Workspace
                    agent_id="marker"
                    context_label="当前视频 · 示例"
                  />
                }
              />
              <Route
                path="/summary"
                element={
                  <Workspace
                    agent_id="summary"
                    context_label="总结文档 · 初稿"
                  />
                }
              />
            </Routes>
          )}
        </GlobalAssistantLayout>
      </GlobalAssistantProvider>
    </MemoryRouter>,
  );
}

describe("GlobalAssistantLayout", () => {
  beforeEach(() => set_compact_layout(false));

  it("keeps one assistant instance and switches its route context", async () => {
    render_assistant();

    expect(
      screen.getByRole("separator", { name: "调整助手宽度" }),
    ).toBeVisible();
    const marker_panel = await screen.findByLabelText("助手面板");
    expect(marker_panel).toHaveAttribute("data-agent-id", "marker");
    expect(marker_panel).toHaveTextContent("当前视频 · 示例");
    expect(screen.getAllByLabelText("助手面板")).toHaveLength(1);

    fireEvent.click(screen.getByRole("link", { name: "切换工作区" }));

    await waitFor(() => {
      const summary_panel = screen.getByLabelText("助手面板");
      expect(summary_panel).toHaveAttribute("data-agent-id", "summary");
      expect(summary_panel).toHaveTextContent("总结文档 · 初稿");
    });
    expect(screen.getAllByLabelText("助手面板")).toHaveLength(1);
  });

  it("starts closed on compact layouts and opens in a sheet", async () => {
    set_compact_layout(true);
    render_assistant(<OpenAssistantButton />);

    expect(screen.queryByLabelText("助手面板")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "打开助手" }));

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getAllByLabelText("助手面板")).toHaveLength(1);
  });
});
