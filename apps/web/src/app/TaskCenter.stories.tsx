import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";

import { TaskCenter } from "@/app/TaskCenter";
import type { TaskRecord } from "@/features/workbench/tasks";

const TASKS: TaskRecord[] = [
  {
    task_id: "run-019c012345677abc8123456789abcdef",
    task_type: "agent",
    stage: "running",
    message: "助手正在处理",
    progress_percent: 50,
    error_message: null,
    created_at: "2026-08-29T10:00:00Z",
    name: "分析角色动作",
  },
  {
    task_id: "run-019c012345677abc8123456789abcdee",
    task_type: "agent",
    stage: "interrupted",
    message: "应用退出时任务中断",
    progress_percent: 100,
    error_message: null,
    created_at: "2026-08-29T09:00:00Z",
    name: "整理镜头标记",
    retry_available: true,
  },
  {
    task_id: "job-019c012345677abc8123456789abcdef",
    task_type: "download",
    stage: "complete",
    message: "下载完成",
    progress_percent: 100,
    error_message: null,
    created_at: "2026-08-29T08:00:00Z",
    name: "产品演示视频",
  },
];

const meta = {
  title: "App/TaskCenter",
  component: TaskCenter,
  args: {
    tasks: TASKS,
    on_retry: async () => undefined,
  },
} satisfies Meta<typeof TaskCenter>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ActiveAndInterrupted: Story = {};

export const Empty: Story = {
  args: { tasks: [] },
};

export const DownloadStates: Story = {
  args: {
    open: true,
    tasks: ["submitting", "downloading", "pausing", "paused", "failed"].map(
      (stage, index) => ({
        ...TASKS[2],
        task_id: `${TASKS[2].task_id.slice(0, -1)}${index}`,
        name: `视频课程 ${index + 1}`,
        stage,
        message:
          stage === "failed"
            ? "下载失败，可重新开始"
            : stage === "paused"
              ? "已暂停，保留续传分片"
              : "已加入下载队列",
        progress_percent: 25,
        progress_known: stage !== "submitting",
        error_message: stage === "failed" ? "网络连接中断" : null,
        retry_available: stage === "failed" || stage === "paused",
        pause_available: stage === "downloading",
        delete_available: stage === "failed" || stage === "paused",
      }),
    ),
    on_retry: fn(async () => undefined),
    on_pause: fn(async () => undefined),
    on_delete: fn(async () => undefined),
  },
  play: async ({ canvasElement, args }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(
      await body.findByRole("button", { name: "暂停下载" }),
    );
    await expect(args.on_pause).toHaveBeenCalledWith(args.tasks[1].task_id);
    await userEvent.click(body.getByRole("button", { name: "继续下载" }));
    await expect(args.on_retry).toHaveBeenCalledWith(args.tasks[3].task_id);
    await userEvent.click(body.getByRole("button", { name: "重新开始" }));
    await expect(args.on_retry).toHaveBeenCalledWith(args.tasks[4].task_id);
    const failed_task = body.getByText("网络连接中断").closest("li")!;
    await userEvent.click(
      within(failed_task).getByRole("button", { name: "删除任务" }),
    );
    await expect(args.on_delete).toHaveBeenCalledWith(args.tasks[4].task_id);
  },
};

export const TranscriptionStates: Story = {
  args: {
    open: true,
    tasks: [
      "transcribing",
      "cancelling",
      "cancelled",
      "interrupted",
      "failed",
    ].map((stage, index) => ({
      ...TASKS[2],
      task_id: `${TASKS[2].task_id.slice(0, -1)}${index}`,
      task_type: "transcription",
      name: `视频课程 ${index + 1}`,
      stage,
      message:
        stage === "cancelling"
          ? "等待后台安全退出"
          : stage === "cancelled"
            ? "转写已停止，保留原字幕"
            : stage === "interrupted"
              ? "同步中断，后台仍可能运行"
              : "正在转写",
      progress_percent: 35,
      error_message: stage === "interrupted" ? "网络连接中断" : null,
      cancel_available: stage === "transcribing" || stage === "interrupted",
      retry_available:
        stage === "cancelled" || stage === "failed" || stage === "interrupted",
    })),
    on_retry: fn(async () => undefined),
    on_cancel: fn(async () => undefined),
  },
  play: async ({ canvasElement, args }) => {
    const body = within(canvasElement.ownerDocument.body);
    const running_task = body.getByText("视频课程 1").closest("li")!;
    await userEvent.click(
      within(running_task).getByRole("button", { name: "停止转写" }),
    );
    await expect(args.on_cancel).toHaveBeenCalledWith(args.tasks[0].task_id);
    await expect(
      body.getByRole("button", { name: "正在停止…" }),
    ).toBeDisabled();
    await userEvent.click(body.getByRole("button", { name: "重新连接" }));
    await expect(args.on_retry).toHaveBeenCalledWith(args.tasks[3].task_id);
  },
};

export const ImportStates: Story = {
  args: {
    open: true,
    tasks: ["uploading", "processing", "queued", "failed", "cancelled"].map(
      (stage, index) => ({
        ...TASKS[2],
        task_id: `${TASKS[2].task_id.slice(0, -1)}${index}`,
        task_type: "import",
        name: `课程 ${index + 1} · 镜头语言与剪辑实操演示.mp4`,
        stage,
        message:
          stage === "uploading"
            ? "已上传 50.0 / 200.0 MB"
            : stage === "processing"
              ? "上传完成，正在校验并加入资料库"
              : stage === "queued"
                ? "已加入导入队列"
                : stage === "cancelled"
                  ? "导入请求已停止，已入库素材会保留"
                  : "导入失败，可重试或删除任务",
        progress_percent: 25,
        progress_known: stage === "uploading",
        error_message:
          stage === "failed" ? "媒体文件损坏，无法读取视频信息" : null,
        cancel_available:
          stage === "uploading" || stage === "processing" || stage === "queued",
        retry_available: stage === "failed" || stage === "cancelled",
        delete_available: stage === "failed" || stage === "cancelled",
      }),
    ),
    on_retry: fn(async () => undefined),
    on_cancel: fn(async () => undefined),
    on_delete: fn(async () => undefined),
  },
  play: async ({ canvasElement, args }) => {
    const body = within(canvasElement.ownerDocument.body);
    const uploading_task = body.getByText(args.tasks[0].name).closest("li")!;
    await userEvent.click(
      within(uploading_task).getByRole("button", { name: "停止导入" }),
    );
    await expect(args.on_cancel).toHaveBeenCalledWith(args.tasks[0].task_id);
    const failed_task = body.getByText(args.tasks[3].name).closest("li")!;
    await userEvent.click(
      within(failed_task).getByRole("button", { name: "重新开始" }),
    );
    await expect(args.on_retry).toHaveBeenCalledWith(args.tasks[3].task_id);
  },
};

export const RestoredAnalysisStates: Story = {
  args: {
    open: true,
    tasks: [
      {
        ...TASKS[0],
        task_id: "job-restored-initialization",
        task_type: "analysis",
        name: "视频课程 · 后台初始化",
        stage: "transcribing",
        message: "正在恢复已有分析进度",
        cancel_available: true,
      },
      {
        ...TASKS[0],
        task_id: "job-restored-stop",
        task_type: "analysis",
        name: "视频课程 · 章节生成",
        stage: "cancelling",
        message: "等待后台安全退出",
        error_message: "进程尚未退出，可以重试停止",
        cancel_available: true,
        progress_known: false,
      },
      {
        ...TASKS[0],
        task_id: "job-restored-approval",
        task_type: "analysis",
        name: "视频课程 · 视频分析",
        stage: "waiting_for_approval",
        message: "分析完成，等待查看建议",
        cancel_available: false,
        result_available: true,
      },
      {
        ...TASKS[0],
        task_id: "job-restored-no-options",
        task_type: "transcription",
        name: "旧视频 · 转写",
        stage: "failed",
        message: "请回视频页面选择模型重新转写",
        retry_available: false,
        result_available: true,
      },
    ],
    on_retry: fn(async () => undefined),
    on_cancel: fn(async () => undefined),
    on_view_result: fn(),
  },
  play: async ({ canvasElement, args }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(body.getByRole("button", { name: "重试停止" }));
    await expect(args.on_cancel).toHaveBeenCalledWith(args.tasks[1].task_id);
    const approval = body.getByText(args.tasks[2].name).closest("li")!;
    await expect(
      within(approval).queryByRole("button", { name: "停止分析" }),
    ).not.toBeInTheDocument();
    await userEvent.click(
      within(approval).getByRole("button", { name: "查看视频" }),
    );
    await expect(args.on_view_result).toHaveBeenCalledWith(
      args.tasks[2].task_id,
    );
  },
};

export const SynchronizationError: Story = {
  args: {
    open: true,
    tasks: [],
    sync_error: "分析任务同步中断，后台任务仍可能运行，请检查连接。",
  },
};
