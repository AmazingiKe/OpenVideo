import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  get_preferences,
  get_transcription_model_download,
  list_transcription_models,
  test_ai_model,
  update_preferences,
} from "@/shared/api";
import { SettingsPage } from "./SettingsPage";

vi.mock("@/app/library", () => ({
  use_library: () => ({
    library: {
      library_id: "library-0123456789abcdef0123456789abcdef",
      name: "课程资料库",
      root_path: "D:\\课程.openvideo-library",
      format_version: 1,
      created_at: "2026-01-01T00:00:00Z",
    },
    set_library: vi.fn(),
  }),
}));

vi.mock("@/shared/api", () => ({
  create_library: vi.fn(),
  download_transcription_model: vi.fn(),
  get_preferences: vi.fn(),
  get_transcription_model_download: vi.fn(),
  list_transcription_models: vi.fn(),
  open_library: vi.fn(),
  select_directory: vi.fn(),
  test_ai_model: vi.fn(),
  update_preferences: vi.fn(),
}));

const preferences = {
  tools_directory: null,
  models_directory: null,
  default_transcription: {
    engine: "faster-whisper" as const,
    model: "small",
    language: "zh",
    device: "cpu" as const,
    compute_type: "int8" as const,
  },
  ai_models: [],
  managed_fields: ["tools_directory"],
  library_path_managed: false,
};

beforeEach(() => {
  vi.mocked(get_preferences).mockResolvedValue(preferences);
  vi.mocked(list_transcription_models).mockResolvedValue([
    {
      engine: "faster-whisper",
      model: "small",
      name: "Whisper Small",
      description: "兼顾资源占用与识别质量。",
      accuracy: "标准",
      speed: "快",
      languages: ["多语言"],
      repository: "Systran/faster-whisper-small",
      recommended: false,
      integration_status: "available",
      installation_status: "installed",
      download_job: null,
    },
    {
      engine: "qwen3-asr",
      model: "qwen3-asr-1.7b",
      name: "Qwen3-ASR 1.7B",
      description: "中文高精度扩展方案。",
      accuracy: "最高",
      speed: "较慢",
      languages: ["中文"],
      repository: "Qwen/Qwen3-ASR-1.7B",
      recommended: false,
      integration_status: "adapter_required",
      installation_status: "not_installed",
      download_job: null,
    },
  ]);
  vi.mocked(test_ai_model).mockResolvedValue({
    available: true,
    latency_ms: 86,
    message: "模型响应正常",
  });
  vi.mocked(get_transcription_model_download).mockRejectedValue(
    new Error("不应轮询"),
  );
  vi.mocked(update_preferences).mockResolvedValue(preferences);
});

afterEach(cleanup);

describe("SettingsPage", () => {
  it("loads preferences and marks environment-managed fields read-only", async () => {
    render(<SettingsPage />);
    expect(
      screen.getByRole("heading", { name: "配置 OpenVideo 工作环境" }),
    ).toBeInTheDocument();
    expect(await screen.findByLabelText(/工具目录/)).toBeDisabled();
    expect(screen.getByLabelText("模型目录")).toHaveValue("");
  });

  it("saves editable settings through the preferences API", async () => {
    render(<SettingsPage />);
    const models_directory = await screen.findByLabelText("模型目录");
    fireEvent.change(models_directory, { target: { value: "D:\\Models" } });
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    expect(update_preferences).toHaveBeenCalledWith(
      expect.objectContaining({
        models_directory: "D:\\Models",
        default_transcription: preferences.default_transcription,
      }),
    );
  });

  it("shows future transcription engines without enabling unavailable models", async () => {
    render(<SettingsPage />);

    expect(await screen.findByText("Qwen3-ASR 1.7B")).toBeInTheDocument();
    const model_list = screen.getByRole("list", {
      name: "本地转录模型列表",
    });
    expect(within(model_list).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("待接入")).toBeInTheDocument();
    expect(screen.getAllByText("Whisper Small")).not.toHaveLength(0);
  });

  it("adds a LiteLLM model configuration before saving", async () => {
    render(<SettingsPage />);
    await screen.findByText("尚未配置 AI 模型");
    fireEvent.click(screen.getByRole("button", { name: "添加模型" }));
    fireEvent.change(screen.getByLabelText("LiteLLM 模型"), {
      target: { value: "anthropic/claude-sonnet-4-5" },
    });
    fireEvent.click(screen.getByRole("button", { name: "图片" }));
    fireEvent.click(screen.getByRole("button", { name: "音频" }));
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));

    expect(update_preferences).toHaveBeenCalledWith(
      expect.objectContaining({
        ai_models: [
          expect.objectContaining({
            model_id: expect.stringMatching(/^model-[0-9a-f]{32}$/),
            litellm_model: "anthropic/claude-sonnet-4-5",
            input_modalities: ["text", "image", "audio"],
          }),
        ],
      }),
    );
  });

  it("tests an unsaved AI model and displays its latency", async () => {
    render(<SettingsPage />);
    await screen.findByText("尚未配置 AI 模型");
    fireEvent.click(screen.getByRole("button", { name: "添加模型" }));
    fireEvent.change(screen.getByLabelText("LiteLLM 模型"), {
      target: { value: "openai/test-model" },
    });
    fireEvent.click(screen.getByRole("button", { name: "测试模型" }));

    expect(test_ai_model).toHaveBeenCalledWith(
      expect.objectContaining({ litellm_model: "openai/test-model" }),
    );
    expect(await screen.findByText("可用")).toBeInTheDocument();
    expect(screen.getByText("延迟 86 ms")).toBeInTheDocument();
  });
});
