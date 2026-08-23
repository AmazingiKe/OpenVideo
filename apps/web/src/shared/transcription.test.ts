import { describe, expect, it } from "vitest";

import {
  transcription_model_is_selectable,
  transcription_runtime_profile,
} from "./transcription";
import type { TranscriptionModelDescriptor } from "./types";

const MODEL: TranscriptionModelDescriptor = {
  engine: "faster-whisper",
  model: "small",
  name: "Whisper Small",
  description: "测试模型",
  accuracy: "标准",
  speed: "快",
  languages: ["多语言"],
  repository: "Systran/faster-whisper-small",
  recommended: false,
  integration_status: "available",
  installation_status: "installed",
  download_job: null,
};

describe("transcription runtime profiles", () => {
  it("recommends CPU Int8 for lightweight Whisper models", () => {
    const profile = transcription_runtime_profile(MODEL);

    expect(profile.recommended_device).toBe("cpu");
    expect(profile.recommended_compute_type).toBe("int8");
  });

  it("recommends automatic precision for large Whisper models", () => {
    const profile = transcription_runtime_profile({
      ...MODEL,
      model: "large-v3-turbo",
    });

    expect(profile.recommended_device).toBe("auto");
    expect(profile.recommended_compute_type).toBe("auto");
  });

  it("limits Qwen3-ASR to its planned runtime choices", () => {
    const profile = transcription_runtime_profile({
      ...MODEL,
      engine: "qwen3-asr",
      model: "qwen3-asr-1.7b",
    });

    expect(profile.devices).toEqual(["auto", "cuda"]);
    expect(profile.compute_types).toEqual(["auto", "float16"]);
  });

  it("only allows installed models with an available adapter to be selected", () => {
    expect(transcription_model_is_selectable(MODEL)).toBe(true);
    expect(
      transcription_model_is_selectable({
        ...MODEL,
        installation_status: "not_installed",
      }),
    ).toBe(false);
    expect(
      transcription_model_is_selectable({
        ...MODEL,
        integration_status: "adapter_required",
      }),
    ).toBe(false);
  });
});
