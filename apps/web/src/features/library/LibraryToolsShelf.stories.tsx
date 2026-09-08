import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { AssetCatalogProvider } from "@/app/asset_catalog";
import { TaskCenter } from "@/app/TaskCenter";
import { TaskManagerProvider, use_task_manager } from "@/app/task_manager";
import { LibraryToolsShelf } from "./LibraryToolsShelf";
import type { DownloadJob, ProbeResponse } from "@/shared/types";

const STORY_URL = "https://www.bilibili.com/video/BV1xx411c7mD";
const PROBE: ProbeResponse = {
  platform: "bilibili",
  is_playlist: true,
  title: "视频制作课程",
  truncated: false,
  total_count: 40,
  entries: Array.from({ length: 40 }, (_, index) => ({
    source_video_id: `BV1xx411c7mD_p${index + 1}`,
    url: `${STORY_URL}?p=${index + 1}`,
    title: `${index + 1} · 镜头语言与剪辑技巧`,
    duration_seconds: 720,
    uploader: "开放影像课",
  })),
};

function DownloadWorkspace() {
  const manager = use_task_manager();
  return (
    <div className="flex min-h-screen flex-col gap-8 p-4">
      <div className="flex justify-end">
        <TaskCenter
          tasks={manager.task_records}
          on_retry={manager.retry_task}
          open={manager.task_center_open}
          on_open_change={manager.set_task_center_open}
          on_pause={manager.pause_task}
          on_delete={manager.delete_task}
          on_view_result={manager.view_probe_result}
        />
      </div>
      <LibraryToolsShelf />
    </div>
  );
}

const meta = {
  title: "Library/LibraryToolsShelf",
  component: LibraryToolsShelf,
  beforeEach() {
    const original_fetch = window.fetch;
    const jobs: DownloadJob[] = [];
    window.fetch = async (input, options) => {
      const url = new URL(String(input), window.location.origin);
      const path = url.pathname;
      if (path === "/api/health")
        return Response.json({
          status: "ready",
          dependencies: { yt_dlp: true, ffmpeg: true, ffprobe: true },
        });
      if (path === "/api/downloads/probe") return Response.json(PROBE);
      if (path === "/api/downloads" && options?.method === "POST") {
        const request = JSON.parse(String(options.body)) as {
          job_ids: string[];
        };
        jobs.push({
          job_id: request.job_ids[0],
          asset_id: "asset-019c0000000070008000000000000001",
          video_quality: "best",
          stage: "downloading",
          name: "镜头语言与剪辑技巧",
          message: "正在下载视频",
          progress_percent: 25,
          error_message: null,
          created_at: "2026-09-08T00:00:00Z",
          updated_at: "2026-09-08T00:00:00Z",
        });
        return Response.json(jobs);
      }
      if (path === "/api/downloads") return Response.json(jobs);
      if (path.startsWith("/api/downloads/job-")) {
        if (path.endsWith("/pause"))
          jobs[0] = {
            ...jobs[0],
            stage: "paused",
            message: "已暂停，继续时尝试续传",
          };
        if (path.endsWith("/resume"))
          jobs[0] = {
            ...jobs[0],
            stage: "downloading",
            message: "正在下载视频",
          };
        if (options?.method === "DELETE") {
          jobs.splice(0);
          return new Response(null, { status: 204 });
        }
        return Response.json(jobs[0]);
      }
      if (
        [
          "/api/media/assets",
          "/api/library/folders",
          "/api/download-accounts",
          "/api/agent/tasks",
        ].includes(path)
      )
        return Response.json([]);
      return Response.json({ detail: "此场景不使用该接口" }, { status: 404 });
    };
    return () => {
      window.fetch = original_fetch;
    };
  },
  render: () => (
    <AssetCatalogProvider>
      <TaskManagerProvider>
        <DownloadWorkspace />
      </TaskManagerProvider>
    </AssetCatalogProvider>
  ),
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(
      await body.findByRole("button", { name: "解析并下载在线视频" }),
    );
    await userEvent.type(
      await body.findByLabelText("视频或播放列表地址"),
      STORY_URL,
    );
    await userEvent.click(body.getByRole("button", { name: "解析链接" }));
    await userEvent.click(
      await body.findByRole("button", { name: "选择视频" }),
    );
    const button = await body.findByRole("button", { name: "下载 1 个视频" });
    const dialog = body.getByRole("dialog", { name: "解析下载" });
    await waitFor(() => expect(getComputedStyle(dialog).opacity).toBe("1"));
    const bounds = button.getBoundingClientRect();
    expect(bounds.top).toBeGreaterThan(0);
    expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight);
    expect(
      document
        .elementFromPoint(
          bounds.x + bounds.width / 2,
          bounds.y + bounds.height / 2,
        )
        ?.closest("button"),
    ).toBe(button);
  },
} satisfies Meta<typeof LibraryToolsShelf>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playlist: Story = {};
export const Narrow: Story = {
  globals: { viewport: { value: "mobile1", isRotated: false } },
};
export const SubmitToTaskCenter: Story = {
  play: async (context) => {
    await meta.play(context);
    const body = within(context.canvasElement.ownerDocument.body);
    await userEvent.click(body.getByRole("button", { name: "下载 1 个视频" }));
    await waitFor(() =>
      expect(
        body.queryByRole("dialog", { name: "解析下载" }),
      ).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(body.getByText("镜头语言与剪辑技巧")).toBeVisible(),
    );
    await userEvent.click(
      await body.findByRole("button", { name: "暂停下载" }),
    );
    await userEvent.click(
      await body.findByRole("button", { name: "继续下载" }),
    );
    await userEvent.click(
      await body.findByRole("button", { name: "暂停下载" }),
    );
    const download_item = body.getByText("镜头语言与剪辑技巧").closest("li")!;
    await userEvent.click(
      await within(download_item).findByRole("button", { name: "删除任务" }),
    );
    await waitFor(() =>
      expect(body.queryByText("镜头语言与剪辑技巧")).not.toBeInTheDocument(),
    );
  },
};
