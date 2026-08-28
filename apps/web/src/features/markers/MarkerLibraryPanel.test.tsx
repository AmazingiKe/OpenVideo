import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { MediaAsset } from "@/shared/types";
import { MarkerLibraryPanel } from "./MarkerLibraryPanel";

const ASSET = {
  asset_id: "asset-019c0000000070008000000000000010",
} as MediaAsset;

vi.mock("@/features/library/LibraryBrowser", () => ({
  LibraryBrowser: ({
    on_open_video,
  }: {
    on_open_video: (asset: MediaAsset) => void;
  }) => (
    <button type="button" onClick={() => on_open_video(ASSET)}>
      打开测试视频
    </button>
  ),
}));

describe("MarkerLibraryPanel", () => {
  it("uses a narrow rail when the desktop library is collapsed", () => {
    const on_collapsed_change = vi.fn();
    render(
      <MarkerLibraryPanel
        collapsed
        current_video_id={null}
        on_collapsed_change={on_collapsed_change}
        on_open_video={vi.fn()}
      />,
    );

    expect(screen.queryByText("打开测试视频")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "展开视频库" }));
    expect(on_collapsed_change).toHaveBeenCalledWith(false);
  });

  it("uses a compact restore action on narrow layouts", () => {
    const on_collapsed_change = vi.fn();
    render(
      <MarkerLibraryPanel
        collapsed
        compact
        current_video_id={null}
        on_collapsed_change={on_collapsed_change}
        on_open_video={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "打开视频库" }));
    expect(on_collapsed_change).toHaveBeenCalledWith(false);
  });

  it("keeps library navigation focused and forwards the selected video", () => {
    const on_collapsed_change = vi.fn();
    const on_open_video = vi.fn();
    render(
      <MarkerLibraryPanel
        current_video_id={ASSET.asset_id}
        on_collapsed_change={on_collapsed_change}
        on_open_video={on_open_video}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "收起视频库" }));
    expect(on_collapsed_change).toHaveBeenCalledWith(true);

    fireEvent.click(screen.getByRole("button", { name: "打开测试视频" }));
    expect(on_open_video).toHaveBeenCalledWith(ASSET);
  });
});
