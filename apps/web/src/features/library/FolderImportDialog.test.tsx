import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FolderImportDialog } from "@/features/library/FolderImportDialog";
import { select_directory } from "@/shared/api";

const enqueue_directory_import = vi.hoisted(() => vi.fn());
const set_task_center_open = vi.hoisted(() => vi.fn());
vi.mock("@/app/task_manager", () => ({
  use_task_manager: () => ({ enqueue_directory_import, set_task_center_open }),
}));
vi.mock("@/shared/api", () => ({ select_directory: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(select_directory).mockResolvedValue("D:\\素材\\课程");
  enqueue_directory_import.mockReturnValue(true);
});

describe("FolderImportDialog", () => {
  it("queues the directory and closes immediately instead of waiting for import completion", async () => {
    const on_open_change = vi.fn();
    render(<FolderImportDialog open on_open_change={on_open_change} />);
    expect(
      screen.getByRole("checkbox", { name: "包含子文件夹" }),
    ).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "选择文件夹" }));
    await waitFor(() =>
      expect(screen.getByLabelText("来源文件夹")).toHaveValue("D:\\素材\\课程"),
    );
    fireEvent.click(screen.getByRole("button", { name: "开始导入" }));
    expect(enqueue_directory_import).toHaveBeenCalledWith(
      "D:\\素材\\课程",
      false,
    );
    expect(set_task_center_open).toHaveBeenCalledWith(true);
    expect(on_open_change).toHaveBeenCalledWith(false);
  });

  it("preserves the explicit recursion choice when queued", async () => {
    render(<FolderImportDialog open on_open_change={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "选择文件夹" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "开始导入" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "包含子文件夹" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "开始导入" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "开始导入" }));
    expect(enqueue_directory_import).toHaveBeenCalledWith(
      "D:\\素材\\课程",
      true,
    );
  });

  it("allows closing an unfinished picker and ignores its late response after reopening", async () => {
    let resolve_path!: (path: string) => void;
    vi.mocked(select_directory).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolve_path = resolve;
        }),
    );
    const on_open_change = vi.fn();
    const { rerender } = render(
      <FolderImportDialog open on_open_change={on_open_change} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "选择文件夹" }));
    const signal = vi.mocked(select_directory).mock.calls[0][0];
    expect(screen.getByRole("button", { name: "关闭" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(signal?.aborted).toBe(true);
    rerender(
      <FolderImportDialog open={false} on_open_change={on_open_change} />,
    );
    rerender(<FolderImportDialog open on_open_change={on_open_change} />);
    await act(async () => resolve_path("D:\\旧目录"));
    expect(screen.getByLabelText("来源文件夹")).toHaveValue("");
    expect(enqueue_directory_import).not.toHaveBeenCalled();
  });

  it("keeps the dialog open and explains a queue error", async () => {
    enqueue_directory_import.mockImplementationOnce(() => {
      throw new Error("资料库已关闭");
    });
    const on_open_change = vi.fn();
    render(<FolderImportDialog open on_open_change={on_open_change} />);
    fireEvent.click(screen.getByRole("button", { name: "选择文件夹" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "开始导入" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "开始导入" }));
    expect(screen.getByRole("alert")).toHaveTextContent("资料库已关闭");
    expect(on_open_change).not.toHaveBeenCalled();
  });
});
