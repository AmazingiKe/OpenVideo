import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, userEvent, waitFor, within } from "storybook/test";

import {
  EMPTY_MARKDOWN_FORMATTING_STATE,
  MarkdownEditorContextMenu,
  type MarkdownFormattingState,
  type MarkdownInlineStyle,
} from "./MarkdownEditorContextMenu";

const INLINE_STATE_KEYS: Record<
  MarkdownInlineStyle,
  Exclude<keyof MarkdownFormattingState, "block_style">
> = {
  bold: "bold",
  italic: "italic",
  strikethrough: "strikethrough",
  "inline-code": "inline_code",
  "inline-math": "inline_math",
  link: "link",
};

function MarkdownEditorContextMenuFixture() {
  const [formatting_state, set_formatting_state] =
    useState<MarkdownFormattingState>(EMPTY_MARKDOWN_FORMATTING_STATE);
  return (
    <MarkdownEditorContextMenu
      enabled
      formatting_state={formatting_state}
      on_open_change={() => undefined}
      on_block_style={(block_style) =>
        set_formatting_state((current) => ({ ...current, block_style }))
      }
      on_inline_style={(style) => {
        const state_key = INLINE_STATE_KEYS[style];
        set_formatting_state((current) => ({
          ...current,
          [state_key]: !current[state_key],
        }));
      }}
    >
      <div
        className="max-w-xl rounded-lg border bg-background p-6 text-foreground"
        aria-label="文字格式右键测试区"
      >
        选择正文后，可通过右键快速切换文字和段落样式。
      </div>
    </MarkdownEditorContextMenu>
  );
}

const meta = {
  title: "Summary/MarkdownEditorContextMenu",
  component: MarkdownEditorContextMenuFixture,
} satisfies Meta<typeof MarkdownEditorContextMenuFixture>;

export default meta;
type Story = StoryObj<typeof meta>;

async function verify_context_menu(canvas_element: HTMLElement) {
  const canvas = within(canvas_element);
  const page = within(canvas_element.ownerDocument.body);
  const trigger = canvas.getByLabelText("文字格式右键测试区");

  await userEvent.pointer({ keys: "[MouseRight]", target: trigger });
  const menu = await page.findByRole("menu", { name: "文字格式" });
  await waitFor(() => expect(menu).toBeVisible());

  await userEvent.click(page.getByRole("menuitemcheckbox", { name: /粗体/ }));
  await userEvent.pointer({ keys: "[MouseRight]", target: trigger });
  expect(page.getByRole("menuitemcheckbox", { name: /粗体/ })).toHaveAttribute(
    "data-state",
    "checked",
  );
}

export const Default: Story = {
  play: async ({ canvasElement }) => {
    await verify_context_menu(canvasElement);
  },
};

export const Dark: Story = {
  beforeEach() {
    document.documentElement.classList.add("dark");
    return () => document.documentElement.classList.remove("dark");
  },
  decorators: [
    (StoryComponent) => (
      <div className="min-h-screen bg-background p-8 text-foreground">
        <StoryComponent />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    await verify_context_menu(canvasElement);
  },
};
