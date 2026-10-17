import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GlobalMediaImport } from "@/app/GlobalMediaImport";

const enqueue_media_imports = vi.hoisted(() => vi.fn());
const set_task_center_open = vi.hoisted(() => vi.fn());
vi.mock("@/app/task_manager", () => ({
  use_task_manager: () => ({ enqueue_media_imports, set_task_center_open }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  enqueue_media_imports.mockReturnValue({
    queued: 1,
    duplicates: 0,
    unsupported: 0,
  });
});

describe("GlobalMediaImport", () => {
  it("accepts another drop immediately and lets users dismiss feedback without stopping queued imports", () => {
    render(
      <>
        <button type="button">继续编辑</button>
        <GlobalMediaImport />
      </>,
    );
    const first = new File(["one"], "一.mp4");
    fireEvent.dragEnter(window, {
      dataTransfer: { types: ["Files"], files: [first] },
    });
    expect(screen.getByText("松开即可导入媒体")).toBeInTheDocument();
    fireEvent.drop(window, {
      dataTransfer: { types: ["Files"], files: [first] },
    });
    expect(screen.queryByText("松开即可导入媒体")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "继续编辑" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "关闭导入提示" }));
    expect(screen.queryByText("媒体导入队列")).not.toBeInTheDocument();
    const second = new File(["two"], "二.mp4");
    fireEvent.drop(window, {
      dataTransfer: { types: ["Files"], files: [second] },
    });
    expect(enqueue_media_imports.mock.calls).toEqual([[[first]], [[second]]]);
    expect(set_task_center_open).toHaveBeenCalledTimes(2);
  });

  it("reports duplicate and unsupported files and clears a lost drag overlay on window blur", () => {
    enqueue_media_imports.mockReturnValue({
      queued: 0,
      duplicates: 1,
      unsupported: 1,
    });
    render(<GlobalMediaImport />);
    fireEvent.drop(window, {
      dataTransfer: { types: ["Files"], files: [new File([], "一.mp4")] },
    });
    expect(screen.getByText(/跳过 1 个已在导入的文件/)).toBeInTheDocument();
    expect(set_task_center_open).not.toHaveBeenCalled();
    fireEvent.dragEnter(window, { dataTransfer: { types: ["Files"] } });
    fireEvent.blur(window);
    expect(screen.queryByText("松开即可导入媒体")).not.toBeInTheDocument();
  });
});
