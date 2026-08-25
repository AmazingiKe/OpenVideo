import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

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

    const time = screen.getByText(expected_text);
    expect(time).toHaveAttribute("datetime", created_at);
    expect(time.tagName).toBe("TIME");
  });

  it("shows the video title in both the task card and persisted log", () => {
    const name = "Blender 角色绑定完整教程";
    render(
      <DownloadActivity
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
                stage: "downloading",
                progress_percent: 2,
                message: "正在下载视频和音频",
                error_message: null,
                created_at: "2026-01-02T03:04:06Z",
              },
            ],
          },
        ]}
      />,
    );

    expect(screen.getAllByText(name)).toHaveLength(2);
    expect(screen.getByText("正在下载视频和音频")).toBeInTheDocument();
  });
});
