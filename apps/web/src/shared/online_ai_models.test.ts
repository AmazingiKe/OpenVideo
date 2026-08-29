import { describe, expect, it } from "vitest";

import { online_ai_model_error } from "@/shared/online_ai_models";
import {
  DEFAULT_MODEL_CAPABILITY_OVERRIDES,
  type AiModelConfiguration,
} from "@/shared/types";

function model(
  litellm_model: string,
  api_base: string | null = null,
): AiModelConfiguration {
  return {
    model_id: "model-0198d12345677890abcdef1234567890",
    name: "测试模型",
    litellm_model,
    api_key: null,
    api_base,
    api_version: null,
    input_modalities: ["text"],
    capabilities: { ...DEFAULT_MODEL_CAPABILITY_OVERRIDES },
  };
}

describe("online_ai_model_error", () => {
  it("accepts hosted providers and HTTPS compatible gateways", () => {
    expect(online_ai_model_error(model("openai/gpt-5"))).toBeNull();
    expect(
      online_ai_model_error(
        model("openai/custom", "https://models.example.com/v1"),
      ),
    ).toBeNull();
  });

  it("rejects local providers and loopback endpoints", () => {
    expect(online_ai_model_error(model("ollama/qwen2.5-vl"))).toMatch(
      /本地推理供应商/,
    );
    expect(
      online_ai_model_error(model("openai/custom", "http://127.0.0.1:1234/v1")),
    ).toMatch(/HTTPS/);
    expect(
      online_ai_model_error(
        model("openai/custom", "https://localhost:1234/v1"),
      ),
    ).toMatch(/本机或局域网地址/);
    expect(
      online_ai_model_error(
        model("openai/custom", "https://192.168.1.20:1234/v1"),
      ),
    ).toMatch(/本机或局域网地址/);
  });
});
