import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, waitFor, within } from "storybook/test";

import { Button } from "./button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./dropdown-menu";

const meta = {
  title: "Design System/Dropdown Menu",
  component: DropdownMenu,
  parameters: { layout: "centered" },
} satisfies Meta<typeof DropdownMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

function MenuDialogExample() {
  const [open, set_open] = useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline">视频操作</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuGroup>
            <DropdownMenuItem onSelect={() => set_open(true)}>
              编辑信息
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={open} onOpenChange={set_open}>
        <DialogContent>
          <DialogTitle>编辑视频信息</DialogTitle>
          <DialogDescription>更新视频标题和备注。</DialogDescription>
        </DialogContent>
      </Dialog>
    </>
  );
}

export const MenuToDialog: Story = {
  render: () => <MenuDialogExample />,
  play: async ({ canvas, canvasElement, userEvent }) => {
    const page = within(canvasElement.ownerDocument.body);
    for (let cycle = 0; cycle < 2; cycle += 1) {
      await userEvent.click(canvas.getByRole("button", { name: "视频操作" }));
      await userEvent.click(
        await page.findByRole("menuitem", { name: "编辑信息" }),
      );
      const dialog = await page.findByRole("dialog");
      await waitFor(() => expect(page.queryByRole("menu")).toBeNull());
      await waitFor(() => expect(dialog).toBeVisible());
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(page.queryByRole("dialog")).toBeNull());
    }
  },
};
