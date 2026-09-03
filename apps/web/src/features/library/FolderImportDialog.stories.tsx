import { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { Button } from "@/components/ui/button";
import { FolderImportDialog } from "@/features/library/FolderImportDialog";

function DialogStory() {
  const [open, set_open] = useState(true);
  return (
    <>
      <Button onClick={() => set_open(true)}>导入视频文件夹</Button>
      <FolderImportDialog open={open} on_open_change={set_open} />
    </>
  );
}

function DarkDialogStory() {
  useEffect(() => {
    document.documentElement.classList.add("dark");
    return () => document.documentElement.classList.remove("dark");
  }, []);
  return <DialogStory />;
}

const meta = {
  title: "Library/FolderImportDialog",
  component: DialogStory,
} satisfies Meta<typeof DialogStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {};

export const Dark: Story = {
  render: () => <DarkDialogStory />,
};
