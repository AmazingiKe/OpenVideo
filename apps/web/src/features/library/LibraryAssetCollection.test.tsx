import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { LibraryAssetCollection } from "@/features/library/LibraryAssetCollection";
import {
  STORY_ASSETS,
  STORY_FOLDERS,
} from "@/features/library/library_story_fixtures";

describe("LibraryAssetCollection", () => {
  it("keeps Ctrl+A inside the collection and exposes batch actions by right click", async () => {
    const on_move = vi.fn();
    render(<TestCollection on_move={on_move} />);

    const outside_input = screen.getByRole("textbox", { name: "区域外输入框" });
    fireEvent.keyDown(outside_input, { key: "a", ctrlKey: true });
    expect(
      screen.getByRole("checkbox", { name: "选择 从镜头语言理解电影叙事" }),
    ).not.toBeChecked();

    const selection_region = screen.getByRole("region", {
      name: "视频选择区域",
    });
    fireEvent.keyDown(selection_region, { key: "a", ctrlKey: true });
    expect(
      screen.getByRole("checkbox", { name: "选择 从镜头语言理解电影叙事" }),
    ).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "选择 景别与构图的叙事作用" }),
    ).toBeChecked();
    expect(
      screen.queryByRole("button", { name: "移动所选" }),
    ).not.toBeInTheDocument();

    fireEvent.contextMenu(
      screen.getByRole("group", { name: "从镜头语言理解电影叙事" }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "移动所选" }));
    expect(on_move).toHaveBeenCalledWith(
      STORY_ASSETS.map((asset) => asset.asset_id),
    );
  });

  it("starts one drag operation for every selected video", () => {
    const on_drag_start = vi.fn();
    render(
      <TestCollection
        initially_selected
        on_move={vi.fn()}
        on_drag_start={on_drag_start}
      />,
    );

    const first_card = screen.getByRole("group", {
      name: "从镜头语言理解电影叙事",
    });
    const data_transfer = {
      effectAllowed: "none",
      setData: vi.fn(),
    };
    fireEvent.dragStart(first_card.parentElement as HTMLElement, {
      dataTransfer: data_transfer,
    });

    expect(on_drag_start).toHaveBeenCalledWith(
      STORY_ASSETS.map((asset) => asset.asset_id),
    );
    expect(data_transfer.setData).toHaveBeenCalledWith(
      "text/plain",
      STORY_ASSETS[0].title,
    );
  });
});

function TestCollection({
  initially_selected = false,
  on_move,
  on_drag_start = vi.fn(),
}: {
  initially_selected?: boolean;
  on_move: (asset_ids: string[]) => void;
  on_drag_start?: (asset_ids: string[]) => void;
}) {
  const [selected_asset_ids, set_selected_asset_ids] = useState(
    initially_selected
      ? new Set(STORY_ASSETS.map((asset) => asset.asset_id))
      : new Set<string>(),
  );

  return (
    <>
      <input aria-label="区域外输入框" />
      <LibraryAssetCollection
        assets={STORY_ASSETS}
        folders={STORY_FOLDERS}
        selected_asset_ids={selected_asset_ids}
        dragging_asset_ids={[]}
        view_mode="grid"
        on_selection_change={set_selected_asset_ids}
        on_move={on_move}
        on_drag_start={on_drag_start}
        on_drag_end={() => undefined}
        on_delete={() => undefined}
        on_open_markers={() => undefined}
        on_open_summary={() => undefined}
      />
    </>
  );
}
