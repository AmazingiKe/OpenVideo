import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { MediaTimelineMarkerEditor } from "./MediaTimelineMarkerEditor";
import type { MarkerImportance } from "@/shared/types";

const meta = {
  title: "Workbench/MediaTimelineMarkerEditor",
  component: MediaTimelineMarkerEditor,
  args: {
    editing_marker_id: "marker-01890f4c7a2b7cc298c4dc0c0c07398f",
    marker_editor_position: { x: 16, y: 16 },
    duration: 120,
    marker_start_draft: 10,
    marker_end_draft: 20,
    marker_content_draft: "这里演示了参数变化对画面的影响。",
    marker_importance_draft: 3,
    marker_save_error: null,
    is_saving_marker: false,
    set_marker_start_draft: fn(),
    set_marker_end_draft: fn(),
    set_marker_content_draft: fn(),
    set_marker_importance_draft: fn(),
    cancel_marker_edit: fn(),
    save_marker: fn((event) => event.preventDefault()),
    delete_marker: fn(),
  },
  render: function MarkerEditorStory(args) {
    const [content, set_content] = useState(args.marker_content_draft);
    const [importance, set_importance] = useState<MarkerImportance>(
      args.marker_importance_draft,
    );
    return (
      <MediaTimelineMarkerEditor
        {...args}
        marker_content_draft={content}
        set_marker_content_draft={set_content}
        marker_importance_draft={importance}
        set_marker_importance_draft={set_importance}
      />
    );
  },
} satisfies Meta<typeof MediaTimelineMarkerEditor>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ContentAndImportance: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await waitFor(() =>
      expect(page.getByRole("dialog", { name: "编辑标记" })).toBeVisible(),
    );
    await userEvent.clear(page.getByLabelText("标记内容"));
    await userEvent.type(page.getByLabelText("标记内容"), "新的用户注释");
    await userEvent.click(page.getByRole("radio", { name: "未评分" }));
    await expect(page.getByLabelText("标记内容")).toHaveValue("新的用户注释");
    await expect(page.getByRole("radio", { name: "未评分" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  },
};
export const ContentOnly: Story = { args: { marker_importance_draft: 0 } };
export const ImportanceOnly: Story = { args: { marker_content_draft: "" } };
export const Empty: Story = {
  args: { marker_content_draft: "", marker_importance_draft: 0 },
};
export const Saving: Story = { args: { is_saving_marker: true } };
export const SaveError: Story = {
  args: { marker_save_error: "标记保存失败，请稍后重试" },
};
