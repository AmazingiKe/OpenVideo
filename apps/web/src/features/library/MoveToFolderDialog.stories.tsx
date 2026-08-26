import { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { Button } from "@/components/ui/button";
import { STORY_FOLDERS } from "@/features/library/library_story_fixtures";
import { MoveToFolderDialog } from "@/features/library/MoveToFolderDialog";

function DialogStory() {
  const [open, set_open] = useState(true);
  return (
    <>
      <Button onClick={() => set_open(true)}>移动视频</Button>
      <MoveToFolderDialog
        open={open}
        title="移动视频"
        description="将 2 个视频归入同一文件夹。"
        folders={STORY_FOLDERS}
        initial_folder_id={null}
        root_label="未分类"
        submitting={false}
        on_open_change={set_open}
        on_submit={() => set_open(false)}
      />
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
  title: "Library/MoveToFolderDialog",
  component: DialogStory,
} satisfies Meta<typeof DialogStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {};

export const Dark: Story = {
  render: () => <DarkDialogStory />,
};
