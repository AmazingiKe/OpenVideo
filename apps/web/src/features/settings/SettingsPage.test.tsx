import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { get_preferences, update_preferences } from "@/shared/api";
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
  get_preferences: vi.fn(),
  open_library: vi.fn(),
  select_library_directory: vi.fn(),
  update_preferences: vi.fn(),
}));

const preferences = {
  ffmpeg_path: null,
  ffprobe_path: null,
  whisper_model: "small",
  whisper_language: "zh",
  whisper_compute_type: "int8",
  openai_base_url: "https://api.openai.com/v1",
  openai_api_key: null,
  vision_model: "gpt-5.6-terra",
  managed_fields: ["ffmpeg_path"],
  library_path_managed: false,
};

beforeEach(() => {
  vi.mocked(get_preferences).mockResolvedValue(preferences);
  vi.mocked(update_preferences).mockResolvedValue(preferences);
});

afterEach(cleanup);

describe("SettingsPage", () => {
  it("loads preferences and marks environment-managed fields read-only", async () => {
    render(<SettingsPage />);
    expect(
      screen.getByRole("heading", { name: "配置 OpenVideo 工作环境" }),
    ).toBeInTheDocument();
    expect(await screen.findByLabelText(/FFmpeg 路径/)).toBeDisabled();
    expect(screen.getByLabelText("转写语言")).toHaveValue("zh");
  });

  it("saves editable settings through the preferences API", async () => {
    render(<SettingsPage />);
    const language = await screen.findByLabelText("转写语言");
    fireEvent.change(language, { target: { value: "en" } });
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    expect(update_preferences).toHaveBeenCalledWith(
      expect.objectContaining({ whisper_language: "en" }),
    );
  });
});
