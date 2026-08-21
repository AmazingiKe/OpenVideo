import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SettingsPage } from "./SettingsPage";

afterEach(cleanup);

describe("SettingsPage", () => {
  it("shows environment settings and restores defaults", () => {
    render(<SettingsPage />);

    expect(
      screen.getByRole("heading", { name: "配置 OpenVideo 工作环境" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存设置" })).toBeDisabled();

    const library_path = screen.getByLabelText("媒体库路径");
    fireEvent.change(library_path, { target: { value: "D:/media" } });
    expect(library_path).toHaveValue("D:/media");

    fireEvent.click(screen.getByRole("button", { name: "恢复默认值" }));
    expect(library_path).toHaveValue("./library");
  });

  it("disables the language input when automatic detection is enabled", () => {
    render(<SettingsPage />);

    const language = screen.getByLabelText("转写语言");
    fireEvent.click(screen.getByRole("checkbox", { name: "自动检测语言" }));

    expect(language).toBeDisabled();
  });
});
