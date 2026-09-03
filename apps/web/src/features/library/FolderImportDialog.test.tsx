import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FolderImportDialog } from "@/features/library/FolderImportDialog";
import { import_video_directory, select_directory } from "@/shared/api";

vi.mock("@/shared/api", () => ({
  import_video_directory: vi.fn(),
  select_directory: vi.fn(),
}));

describe("FolderImportDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(select_directory).mockResolvedValue("D:\\素材\\课程");
    vi.mocked(import_video_directory).mockResolvedValue({
      assets: [],
      failed_files: [],
    });
  });

  it("defaults to importing only videos directly inside the selected folder", async () => {
    render_dialog();

    expect(
      screen.getByRole("checkbox", { name: "包含子文件夹" }),
    ).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "选择文件夹" }));
    await waitFor(() =>
      expect(screen.getByLabelText("来源文件夹")).toHaveValue("D:\\素材\\课程"),
    );
    fireEvent.click(screen.getByRole("button", { name: "开始导入" }));

    await waitFor(() =>
      expect(import_video_directory).toHaveBeenCalledWith(
        "D:\\素材\\课程",
        false,
      ),
    );
    expect(await screen.findByText("已导入 0 个视频")).toBeInTheDocument();
  });

  it("passes the recursive option when the user enables subfolder import", async () => {
    render_dialog();

    fireEvent.click(screen.getByRole("button", { name: "选择文件夹" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "包含子文件夹" }));
    fireEvent.click(await screen.findByRole("button", { name: "开始导入" }));

    await waitFor(() =>
      expect(import_video_directory).toHaveBeenCalledWith(
        "D:\\素材\\课程",
        true,
      ),
    );
  });
});

function render_dialog() {
  const query_client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={query_client}>
      <FolderImportDialog open on_open_change={vi.fn()} />
    </QueryClientProvider>,
  );
}
