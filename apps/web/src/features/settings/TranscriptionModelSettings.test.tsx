import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type {
  TranscriptionModelDescriptor,
  TranscriptionOptions,
} from "@/shared/types";
import { TranscriptionModelSettings } from "./TranscriptionModelSettings";

const CLOUD_MODEL: TranscriptionModelDescriptor = {
  engine: "bailian",
  model: "fun-asr",
  name: "百炼 Fun-ASR",
  description: "云端长音频识别。",
  accuracy: "高",
  speed: "快",
  languages: ["中文", "英语"],
  repository: "",
  recommended: false,
  integration_status: "available",
  installation_status: "installed",
  download_job: null,
};

const CLOUD_OPTIONS: TranscriptionOptions = {
  engine: "bailian",
  model: "fun-asr",
  language: "zh",
  device: "auto",
  compute_type: "auto",
};

describe("TranscriptionModelSettings", () => {
  it("shows cloud configuration without local runtime or model download actions", () => {
    render(
      <TranscriptionModelSettings
        models={[CLOUD_MODEL]}
        value={CLOUD_OPTIONS}
        on_change={vi.fn()}
        on_model_change={vi.fn()}
      />,
    );

    expect(screen.getByRole("combobox", { name: "默认模型" })).toBeEnabled();
    expect(
      screen.queryByRole("combobox", { name: "运行设备" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: "推理精度" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /下载/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("云端 · 无需下载")).toBeInTheDocument();
  });

  it("resets local device and precision when switching to a cloud model", () => {
    Element.prototype.scrollIntoView = vi.fn();
    const on_change = vi.fn();
    render(
      <TranscriptionModelSettings
        models={[CLOUD_MODEL]}
        value={{
          ...CLOUD_OPTIONS,
          engine: "faster-whisper",
          model: "small",
          device: "cpu",
          compute_type: "int8",
        }}
        on_change={on_change}
        on_model_change={vi.fn()}
      />,
    );
    const model_trigger = screen.getByRole("combobox", { name: "默认模型" });
    model_trigger.hasPointerCapture = () => false;
    model_trigger.setPointerCapture = vi.fn();
    model_trigger.releasePointerCapture = vi.fn();
    fireEvent.pointerDown(model_trigger, { button: 0, pointerType: "mouse" });
    fireEvent.click(screen.getByRole("option", { name: "百炼 Fun-ASR" }));

    expect(on_change).toHaveBeenCalledWith(CLOUD_OPTIONS);
  });
});
