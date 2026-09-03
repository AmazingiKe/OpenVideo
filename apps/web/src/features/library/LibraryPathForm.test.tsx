import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { activate_library, select_directory } from "@/shared/api";
import { LibraryPathForm } from "./LibraryPathForm";

vi.mock("@/shared/api", () => ({
  activate_library: vi.fn(),
  select_directory: vi.fn(),
}));

const library = {
  library_id: "library-0123456789abcdef0123456789abcdef",
  name: "课程",
  root_path: "D:\\课程.openvideo-library",
  format_version: 2,
  index_issues: [],
  created_at: "2026-01-01T00:00:00Z",
};

beforeEach(() => {
  vi.mocked(activate_library).mockResolvedValue(library);
  vi.mocked(select_directory).mockResolvedValue(null);
});

afterEach(cleanup);

describe("LibraryPathForm", () => {
  it("validates the folder path before activation", () => {
    render(<LibraryPathForm on_success={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "使用此文件夹" }));
    expect(screen.getByRole("alert")).toHaveTextContent("请填写文件夹");
    expect(activate_library).not.toHaveBeenCalled();
  });

  it("activates the selected directory", async () => {
    const on_success = vi.fn();
    render(<LibraryPathForm on_success={on_success} />);
    fireEvent.change(screen.getByLabelText("资料库路径"), {
      target: { value: "D:\\课程" },
    });
    fireEvent.click(screen.getByRole("button", { name: "使用此文件夹" }));
    await waitFor(() => expect(on_success).toHaveBeenCalledWith(library));
    expect(activate_library).toHaveBeenCalledWith("D:\\课程");
  });

  it("fills the input with the selected local directory", async () => {
    vi.mocked(select_directory).mockResolvedValue("D:\\课程");
    render(<LibraryPathForm on_success={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "选择文件夹" }));

    expect(await screen.findByLabelText("资料库路径")).toHaveValue("D:\\课程");
  });
});
