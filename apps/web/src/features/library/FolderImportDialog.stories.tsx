import { useState } from "react";
import { Link } from "react-router-dom";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { AssetCatalogProvider } from "@/app/asset_catalog";
import { LibraryProvider } from "@/app/library";
import { TaskCenter } from "@/app/TaskCenter";
import { TaskManagerProvider, use_task_manager } from "@/app/task_manager";
import { Button } from "@/components/ui/button";
import { FolderImportDialog } from "@/features/library/FolderImportDialog";
import { STORY_ASSETS } from "@/features/library/library_story_fixtures";
import type { MediaAsset } from "@/shared/types";

const SOURCE_DIRECTORY = "/素材/课程";

function DialogStory() {
  const [open, set_open] = useState(true);
  const manager = use_task_manager();
  return (
    <div className="flex min-h-screen flex-col gap-4 p-4">
      <div className="flex items-center justify-between gap-4">
        <Button asChild variant="outline">
          <Link to="/markers">继续编辑</Link>
        </Button>
        <TaskCenter
          tasks={manager.task_records}
          open={manager.task_center_open}
          on_open_change={manager.set_task_center_open}
          on_retry={manager.retry_task}
          on_cancel={manager.cancel_task}
          on_delete={manager.delete_task}
          sync_error={manager.task_sync_error}
        />
      </div>
      <Button variant="outline" onClick={() => set_open(true)}>
        导入视频文件夹
      </Button>
      <FolderImportDialog open={open} on_open_change={set_open} />
    </div>
  );
}

const meta = {
  title: "Library/FolderImportDialog",
  component: DialogStory,
  parameters: { layout: "fullscreen", route: "/library" },
  beforeEach(context) {
    const original_fetch = window.fetch;
    let assets: MediaAsset[] = [];
    window.fetch = async (input, options) => {
      const path = new URL(String(input), window.location.origin).pathname;
      if (path === "/api/library")
        return Response.json({
          library_id: "library-019c012345677abc8123456789abcdef",
          name: "课程资料库",
          root_path: "/资料库",
          format_version: 2,
          created_at: "2026-10-17T00:00:00Z",
          index_issues: [],
        });
      if (path === "/api/directories/select")
        return Response.json({ path: SOURCE_DIRECTORY });
      if (path === "/api/media/assets/import-directory") {
        if (context.parameters.partial_failure) {
          assets = [STORY_ASSETS[0]];
          return Response.json(
            { assets, failed_files: ["损坏视频.mp4：无法识别视频轨道"] },
            { status: 201 },
          );
        }
        return new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("已停止", "AbortError")),
            { once: true },
          );
        });
      }
      if (path === "/api/media/assets") return Response.json(assets);
      if (
        [
          "/api/library/folders",
          "/api/analysis",
          "/api/agent/tasks",
          "/api/downloads",
        ].includes(path)
      )
        return Response.json([]);
      if (path === "/api/agent-index-status")
        return Response.json({
          index_task_id: "index-task-019c012345677abc8123456789abcdef",
          asset_id: null,
          state: "ready",
          stage: "ready",
          stage_label: "检索索引已就绪",
          processed_documents: 0,
          total_documents: 0,
          indexed_documents: 0,
          covered_seconds: 0,
          duration_seconds: null,
          available_capabilities: [],
          error_message: null,
          updated_at: "2026-10-17T00:00:00Z",
        });
      return Response.json({ detail: "此场景不使用该接口" }, { status: 404 });
    };
    return () => {
      window.fetch = original_fetch;
    };
  },
  render: () => (
    <LibraryProvider>
      <AssetCatalogProvider>
        <TaskManagerProvider>
          <DialogStory />
        </TaskManagerProvider>
      </AssetCatalogProvider>
    </LibraryProvider>
  ),
} satisfies Meta<typeof DialogStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {};

export const BackgroundImport: Story = {
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(
      await body.findByRole("button", { name: "选择文件夹" }),
    );
    await waitFor(() =>
      expect(body.getByLabelText("来源文件夹")).toHaveValue(SOURCE_DIRECTORY),
    );
    await userEvent.click(body.getByRole("button", { name: "开始导入" }));
    await waitFor(() =>
      expect(body.queryByLabelText("来源文件夹")).not.toBeInTheDocument(),
    );
    await userEvent.click(body.getByRole("link", { name: "继续编辑" }));
    await waitFor(() =>
      expect(
        body.queryByRole("button", { name: "停止导入", hidden: true }),
      ).not.toBeInTheDocument(),
    );
    await userEvent.click(body.getByRole("button", { name: /^任务中心/ }));
    await userEvent.click(
      await body.findByRole("button", { name: "停止导入" }),
    );
    await expect(
      await body.findByText("已取消", { exact: true }),
    ).toBeVisible();
    await expect(
      body.queryByRole("button", { name: "重新开始" }),
    ).not.toBeInTheDocument();
  },
};

export const PartialFailure: Story = {
  parameters: { partial_failure: true },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(
      await body.findByRole("button", { name: "选择文件夹" }),
    );
    await waitFor(() =>
      expect(body.getByRole("button", { name: "开始导入" })).toBeEnabled(),
    );
    await userEvent.click(body.getByRole("button", { name: "开始导入" }));
    await waitFor(() =>
      expect(body.queryByLabelText("来源文件夹")).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(body.getByText(/已导入 1 个视频，1 个失败/)).toBeVisible(),
    );
    await expect(
      body.queryByRole("button", { name: "重新开始" }),
    ).not.toBeInTheDocument();
    await expect(body.getByText(/损坏视频.mp4/)).toBeVisible();
  },
};
