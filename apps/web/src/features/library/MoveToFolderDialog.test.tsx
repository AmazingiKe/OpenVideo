import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MoveToFolderDialog } from "@/features/library/MoveToFolderDialog";
import { STORY_FOLDERS } from "@/features/library/library_story_fixtures";

describe("MoveToFolderDialog", () => {
  it("shows folder options above the dialog overlay", async () => {
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    render(
      <MoveToFolderDialog
        open
        title="移动视频"
        description="选择视频分类。"
        folders={STORY_FOLDERS}
        initial_folder_id={null}
        root_label="未分类"
        submitting={false}
        on_open_change={vi.fn()}
        on_submit={vi.fn()}
      />,
    );

    const trigger = screen.getByRole("combobox", { name: "目标位置" });
    trigger.hasPointerCapture = () => false;
    trigger.setPointerCapture = vi.fn();
    trigger.releasePointerCapture = vi.fn();
    fireEvent.pointerDown(trigger, {
      button: 0,
      pointerType: "mouse",
    });

    const folder_option = await screen.findByRole("option", { name: "课程" });
    const select_content = folder_option.closest(
      '[data-slot="select-content"]',
    );
    expect(select_content).toHaveClass("z-50");
  });
});
