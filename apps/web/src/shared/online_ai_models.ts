import type { AiModelConfiguration } from "@/shared/types";

const LOCAL_MODEL_PROVIDERS = new Set([
  "llama_cpp",
  "lm_studio",
  "localai",
  "ollama",
  "ollama_chat",
  "vllm",
]);
const LOOPBACK_HOST_NAMES = new Set([
  "0.0.0.0",
  "::",
  "::1",
  "localhost",
  "localhost.localdomain",
]);
const PRIVATE_IPV4_PATTERNS = [
  /^10\./,
  /^169\.254\./,
  /^172\.(?:1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
];

export function online_ai_model_error(
  model: AiModelConfiguration,
): string | null {
  const provider = model.litellm_model.split("/", 1)[0]?.toLowerCase();
  if (provider && LOCAL_MODEL_PROVIDERS.has(provider)) {
    return "大语言与视觉模型仅支持在线 API，不能使用本地推理供应商";
  }
  if (!model.api_base) return null;
  let api_url: URL;
  try {
    api_url = new URL(model.api_base);
  } catch {
    return "自定义 API 地址必须是完整的 HTTPS 地址";
  }
  if (api_url.protocol !== "https:") {
    return "在线 AI 模型的自定义 API 地址必须使用 HTTPS";
  }
  const hostname = api_url.hostname
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/\.$/, "");
  const private_address =
    LOOPBACK_HOST_NAMES.has(hostname) ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname) ||
    PRIVATE_IPV4_PATTERNS.some((pattern) => pattern.test(hostname)) ||
    /^(?:fc|fd|fe[89ab])/i.test(hostname);
  if (private_address) {
    return "在线 AI 模型不能连接本机或局域网地址";
  }
  return null;
}

export function is_online_ai_model(model: AiModelConfiguration): boolean {
  return online_ai_model_error(model) === null;
}
