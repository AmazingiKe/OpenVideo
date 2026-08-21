import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { create_library, open_library } from "@/shared/api";
import { LibraryPathForm } from "./LibraryPathForm";

vi.mock("@/shared/api", () => ({
  create_library: vi.fn(),
  open_library: vi.fn(),
}));

const library = {
  library_id: "library-0123456789abcdef0123456789abcdef",
  name: "课程",
  root_path: "D:\\课程.openvideo-library",
  format_version: 1,
  created_at: "2026-01-01T00:00:00Z",
};

beforeEach(() => {
  vi.mocked(create_library).mockResolvedValue(library);
  vi.mocked(open_library).mockResolvedValue(library);
});

afterEach(cleanup);

describe("LibraryPathForm", () => {
  it("validates the folder path before initializing", () => {
    render(<LibraryPathForm action="initialize" on_success={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "初始化文件夹" }));
    expect(screen.getByRole("alert")).toHaveTextContent("请填写文件夹");
    expect(create_library).not.toHaveBeenCalled();
  });

  it("initializes an empty directory", async () => {
    const on_success = vi.fn();
    render(<LibraryPathForm action="initialize" on_success={on_success} />);
    fireEvent.change(screen.getByLabelText("文件夹绝对路径"), {
      target: { value: "D:\\课程" },
    });
    fireEvent.click(screen.getByRole("button", { name: "初始化文件夹" }));
    await waitFor(() => expect(on_success).toHaveBeenCalledWith(library));
    expect(create_library).toHaveBeenCalledWith("D:\\课程");
  });

  it("opens an existing library", async () => {
    const on_success = vi.fn();
    render(<LibraryPathForm action="open" on_success={on_success} />);
    fireEvent.change(screen.getByLabelText("资料库绝对路径"), {
      target: { value: "D:\\课程.openvideo-library" },
    });
    fireEvent.click(screen.getByRole("button", { name: "打开资料库" }));
    await waitFor(() => expect(on_success).toHaveBeenCalledWith(library));
    expect(open_library).toHaveBeenCalledWith("D:\\课程.openvideo-library");
  });
});
