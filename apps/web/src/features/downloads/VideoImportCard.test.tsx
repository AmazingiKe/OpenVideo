import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { VideoImportCard } from "@/features/downloads/VideoImportCard";

describe("VideoImportCard", () => {
  it("imports one supported video through drag and drop only", () => {
    const on_video_drop = vi.fn();
    render(
      <VideoImportCard
        state={{ stage: "idle" }}
        on_video_drop={on_video_drop}
        on_invalid_drop={vi.fn()}
      />,
    );

    const drop_region = screen.getByRole("region", {
      name: "本地视频拖拽导入区",
    });
    const file = new File(["video"], "课程片段.MP4", { type: "video/mp4" });
    const data_transfer = {
      files: [file],
      types: ["Files"],
      dropEffect: "none",
    };

    fireEvent.dragEnter(drop_region, { dataTransfer: data_transfer });
    expect(screen.getByText("松开即可导入视频")).toBeVisible();

    fireEvent.drop(drop_region, { dataTransfer: data_transfer });
    expect(on_video_drop).toHaveBeenCalledWith(file);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  it("rejects non-video files and multiple-file drops", () => {
    const on_invalid_drop = vi.fn();
    render(
      <VideoImportCard
        state={{ stage: "idle" }}
        on_video_drop={vi.fn()}
        on_invalid_drop={on_invalid_drop}
      />,
    );
    const drop_region = screen.getByRole("region", {
      name: "本地视频拖拽导入区",
    });

    fireEvent.drop(drop_region, {
      dataTransfer: {
        files: [new File(["text"], "说明.txt", { type: "text/plain" })],
        types: ["Files"],
      },
    });
    expect(on_invalid_drop).toHaveBeenLastCalledWith(
      "仅支持 AVI、M4V、MKV、MOV、MP4 和 WebM 视频文件",
    );

    fireEvent.drop(drop_region, {
      dataTransfer: {
        files: [
          new File(["one"], "one.mp4", { type: "video/mp4" }),
          new File(["two"], "two.mp4", { type: "video/mp4" }),
        ],
        types: ["Files"],
      },
    });
    expect(on_invalid_drop).toHaveBeenLastCalledWith(
      "每次只能拖入一个视频文件",
    );
  });

  it("announces importing, completion, and failure states", () => {
    const props = {
      on_video_drop: vi.fn(),
      on_invalid_drop: vi.fn(),
    };
    const { rerender } = render(
      <VideoImportCard
        {...props}
        state={{ stage: "importing", filename: "演示.mp4" }}
      />,
    );
    expect(screen.getByText("正在导入“演示.mp4”")).toBeVisible();

    rerender(
      <VideoImportCard
        {...props}
        state={{ stage: "complete", title: "演示" }}
      />,
    );
    expect(screen.getByText("“演示”已导入")).toBeVisible();

    rerender(
      <VideoImportCard
        {...props}
        state={{ stage: "failed", message: "文件中没有视频轨道" }}
      />,
    );
    expect(screen.getByText("无法导入此视频")).toBeVisible();
    expect(screen.getByText("文件中没有视频轨道")).toBeVisible();
  });
});
