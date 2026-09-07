import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, waitFor, within } from "storybook/test";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "./alert-dialog";
import { Button } from "./button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "./sheet";

const meta = {
  title: "Design System/Overlay Motion",
  component: Dialog,
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof Dialog>;

export default meta;

type Story = StoryObj<typeof meta>;

export const DialogWindow: Story = {
  play: async ({ canvas, canvasElement, userEvent }) => {
    const page = within(canvasElement.ownerDocument.body);
    const trigger = canvas.getByRole("button", { name: "打开弹窗" });
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await userEvent.click(trigger);
      const dialog = await page.findByRole("dialog");
      await waitFor(() => expect(dialog).toBeVisible());
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(page.queryByRole("dialog")).toBeNull());
      await expect(trigger).toHaveFocus();
    }
  },
  render: () => (
    <Dialog>
      <DialogTrigger asChild>
        <Button>打开弹窗</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>编辑视频信息</DialogTitle>
          <DialogDescription>
            弹窗使用轻微位移、缩放和淡入效果建立层级。
          </DialogDescription>
        </DialogHeader>
      </DialogContent>
    </Dialog>
  ),
};

export const ConfirmationWindow: Story = {
  play: async ({ canvas, canvasElement, userEvent }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole("button", { name: "删除片段" }));
    await waitFor(() => expect(page.getByRole("alertdialog")).toBeVisible());
    await userEvent.click(page.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(page.queryByRole("alertdialog")).toBeNull());
    await expect(
      canvas.getByRole("button", { name: "删除片段" }),
    ).toHaveFocus();
  },
  render: () => (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline">删除片段</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>确认删除这个片段？</AlertDialogTitle>
          <AlertDialogDescription>
            删除后无法恢复，时间线上的关联标记也会一并移除。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction variant="destructive">删除</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  ),
};

export const SideWindow: Story = {
  play: async ({ canvas, canvasElement, userEvent }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole("button", { name: "打开侧栏" }));
    await waitFor(() => expect(page.getByRole("dialog")).toBeVisible());
    await userEvent.click(page.getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(page.queryByRole("dialog")).toBeNull());
    await expect(
      canvas.getByRole("button", { name: "打开侧栏" }),
    ).toHaveFocus();
  },
  render: () => (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="secondary">打开侧栏</Button>
      </SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>视频库</SheetTitle>
          <SheetDescription>
            侧栏根据出现方向执行短距离位移动画。
          </SheetDescription>
        </SheetHeader>
      </SheetContent>
    </Sheet>
  ),
};
