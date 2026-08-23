import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AssetLibrary } from "./AssetLibrary";

describe("AssetLibrary", () => {
  it("collapses into an accessible 48 pixel rail and expands again", () => {
    const change_collapsed = vi.fn();
    const { rerender } = render(
      <AssetLibrary
        assets={[]}
        selected_asset_id={null}
        on_select={vi.fn()}
        on_collapsed_change={change_collapsed}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "收起视频库" }));
    expect(change_collapsed).toHaveBeenCalledWith(true);

    rerender(
      <AssetLibrary
        assets={[]}
        selected_asset_id={null}
        on_select={vi.fn()}
        collapsed
        on_collapsed_change={change_collapsed}
      />,
    );
    expect(screen.getByText("视频库")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "展开视频库" }));
    expect(change_collapsed).toHaveBeenLastCalledWith(false);
  });
});
