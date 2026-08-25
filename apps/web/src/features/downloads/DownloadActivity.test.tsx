import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DownloadActivity } from "@/features/downloads/DownloadActivity";

describe("DownloadActivity", () => {
  it("shows the local creation time and preserves its ISO value", () => {
    const created_at = "2026-01-02T03:04:05Z";
    const created_date = new Date(created_at);
    const expected_text =
      [
        created_date.getFullYear(),
        (created_date.getMonth() + 1).toString().padStart(2, "0"),
        created_date.getDate().toString().padStart(2, "0"),
      ].join("-") +
      " " +
      [
        created_date.getHours().toString().padStart(2, "0"),
        created_date.getMinutes().toString().padStart(2, "0"),
        created_date.getSeconds().toString().padStart(2, "0"),
      ].join(":");

    render(
      <DownloadActivity
        retrying_task_id={null}
        on_retry={vi.fn()}
        tasks={[
          {
            task_id: "job-0198d12345677890abcdef1234567890",
            task_type: "download",
            stage: "downloading",
            message: "Downloading",
            progress_percent: 48,
            error_message: null,
            created_at,
            name: "Blender 角色绑定完整教程",
            events: [],
          },
        ]}
      />,
    );

    const times = screen.getAllByText(expected_text);
    expect(times).toHaveLength(2);
    for (const time of times) {
      expect(time).toHaveAttribute("datetime", created_at);
      expect(time.tagName).toBe("TIME");
    }
  });

  it("shows one task summary and reveals persisted steps on demand", () => {
    const name = "Blender 角色绑定完整教程";
    const identified_message = `已识别视频：${name}`;
    render(
      <DownloadActivity
        retrying_task_id={null}
        on_retry={vi.fn()}
        tasks={[
          {
            task_id: "job-0198d12345677890abcdef1234567890",
            task_type: "download",
            stage: "downloading",
            message: "正在下载视频",
            progress_percent: 48,
            error_message: null,
            created_at: "2026-01-02T03:04:05Z",
            name,
            events: [
              {
                event_id: "event-0198d12345677890abcdef1234567891",
                job_id: "job-0198d12345677890abcdef1234567890",
                stage: "reading_metadata",
                progress_percent: 1,
                message: identified_message,
                error_message: null,
                created_at: "2026-01-02T03:04:06Z",
              },
              {
                event_id: "event-0198d12345677890abcdef1234567892",
                job_id: "job-0198d12345677890abcdef1234567890",
                stage: "downloading",
                progress_percent: 2,
                message: "正在下载视频和音频",
                error_message: null,
                created_at: "2026-01-02T03:04:08Z",
              },
            ],
          },
        ]}
      />,
    );

    expect(screen.getAllByText(name)).toHaveLength(2);
    expect(screen.queryByText(identified_message)).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", {
        name: /Blender 角色绑定完整教程/,
      }),
    );

    expect(screen.getByText(identified_message)).toBeVisible();
  });

  it("retries a failed task and disables the action while submitting", () => {
    const on_retry = vi.fn();
    const task_id = "job-0198d12345677890abcdef1234567890";
    const { rerender } = render(
      <DownloadActivity
        retrying_task_id={null}
        on_retry={on_retry}
        tasks={[
          {
            task_id,
            task_type: "download",
            stage: "failed",
            message: "下载失败",
            progress_percent: 12,
            error_message: "网络连接中断",
            created_at: "2026-01-02T03:04:05Z",
            name: "Maya 灯光渲染案例",
            events: [],
          },
        ]}
      />,
    );

    const retry_button = screen.getByRole("button", {
      name: "重新下载：Maya 灯光渲染案例",
    });
    fireEvent.click(retry_button);
    expect(on_retry).toHaveBeenCalledWith(task_id);

    rerender(
      <DownloadActivity
        retrying_task_id={task_id}
        on_retry={on_retry}
        tasks={[
          {
            task_id,
            task_type: "download",
            stage: "failed",
            message: "下载失败",
            progress_percent: 12,
            error_message: "网络连接中断",
            created_at: "2026-01-02T03:04:05Z",
            name: "Maya 灯光渲染案例",
            events: [],
          },
        ]}
      />,
    );
    expect(retry_button).toBeDisabled();
  });
});
