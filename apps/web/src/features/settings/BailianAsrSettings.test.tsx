import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { BailianAsrSettings } from "./BailianAsrSettings";

const CONFIGURATION = { region: "beijing" as const, api_key_configured: true };

describe("BailianAsrSettings", () => {
  it("requires explicit saving and clears the masked key after success", async () => {
    const on_save = vi.fn().mockResolvedValue(CONFIGURATION);
    render(
      <BailianAsrSettings
        value={CONFIGURATION}
        on_save={on_save}
        on_test={vi.fn()}
      />,
    );

    const key_input = screen.getByLabelText("百炼 API Key");
    expect(key_input).toHaveAttribute("type", "password");
    expect(key_input).toHaveValue("");
    fireEvent.change(key_input, { target: { value: "sk-test-secret" } });
    expect(on_save).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "测试连接" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "保存百炼配置" }));

    await waitFor(() => expect(key_input).toHaveValue(""));
    expect(on_save).toHaveBeenCalledWith({
      region: "beijing",
      api_key: "sk-test-secret",
    });
    expect(screen.getByText("百炼语音配置已保存。")).toBeInTheDocument();
  });

  it("tests saved credentials and displays service failures", async () => {
    const on_test = vi
      .fn()
      .mockRejectedValue(new Error("密钥无效或区域不匹配"));
    render(
      <BailianAsrSettings
        value={CONFIGURATION}
        on_save={vi.fn()}
        on_test={on_test}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));

    expect(await screen.findByText("密钥无效或区域不匹配")).toBeInTheDocument();
    expect(on_test).toHaveBeenCalledWith();
    expect(screen.getByLabelText("百炼 API Key")).toHaveValue("");
  });

  it("removes credentials only through the explicit remove action", async () => {
    const on_save = vi.fn().mockResolvedValue({
      ...CONFIGURATION,
      api_key_configured: false,
    });
    render(
      <BailianAsrSettings
        value={CONFIGURATION}
        on_save={on_save}
        on_test={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "保存百炼配置" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "移除密钥" }));

    await waitFor(() => expect(on_save).toHaveBeenCalledWith({ api_key: "" }));
  });

  it("preserves the saved key when only changing the service region", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const on_save = vi
      .fn()
      .mockResolvedValue({ ...CONFIGURATION, region: "singapore" });
    render(
      <BailianAsrSettings
        value={CONFIGURATION}
        on_save={on_save}
        on_test={vi.fn()}
      />,
    );
    const region_trigger = screen.getByRole("combobox", { name: "服务区域" });
    region_trigger.hasPointerCapture = () => false;
    region_trigger.setPointerCapture = vi.fn();
    region_trigger.releasePointerCapture = vi.fn();
    fireEvent.pointerDown(region_trigger, { button: 0, pointerType: "mouse" });
    fireEvent.click(screen.getByRole("option", { name: "新加坡" }));
    fireEvent.click(screen.getByRole("button", { name: "保存百炼配置" }));

    await waitFor(() =>
      expect(on_save).toHaveBeenCalledWith({ region: "singapore" }),
    );
  });
});
