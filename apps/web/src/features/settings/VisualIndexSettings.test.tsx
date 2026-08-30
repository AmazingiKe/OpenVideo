import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { VisualIndexStatus } from "@/shared/types";
import { VisualIndexSettingsPanel } from "./VisualIndexSettings";

const STATUS: VisualIndexStatus = {
  state: "not_prepared",
  progress_percent: 0,
  message: "视觉索引尚未准备",
  model_name: "google/siglip2-base-patch16-224",
  model_revision: "997aaec",
  indexed_frames: 0,
  total_frames: 0,
  model_loaded: false,
  error_message: null,
  updated_at: "2026-08-31T10:00:00Z",
};

describe("VisualIndexSettingsPanel", () => {
  it("offers one recommended preparation action without loading by default", () => {
    const on_prepare = vi.fn();
    render(
      <VisualIndexSettingsPanel
        status={STATUS}
        pending={false}
        error={null}
        on_prepare={on_prepare}
        on_unload={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "准备推荐索引" }));

    expect(on_prepare).toHaveBeenCalledOnce();
    expect(screen.getByText("未准备")).toBeInTheDocument();
    expect(
      screen.getByText(/应用启动与素材导入不会等待它/),
    ).toBeInTheDocument();
  });

  it("lets the user release a loaded model while keeping the index", () => {
    const on_unload = vi.fn();
    render(
      <VisualIndexSettingsPanel
        status={{ ...STATUS, state: "ready", model_loaded: true }}
        pending={false}
        error={null}
        on_prepare={() => undefined}
        on_unload={on_unload}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "释放模型" }));

    expect(on_unload).toHaveBeenCalledOnce();
    expect(screen.getByText("已加载")).toBeInTheDocument();
  });
});
