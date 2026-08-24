import type {
  TranscriptionComputeType,
  TranscriptionDevice,
  TranscriptionModelDescriptor,
} from "./types";

export type TranscriptionRuntimeProfile = {
  devices: readonly TranscriptionDevice[];
  compute_types: readonly TranscriptionComputeType[];
  recommended_device: TranscriptionDevice;
  recommended_compute_type: TranscriptionComputeType;
};

const WHISPER_CPU_PROFILE: TranscriptionRuntimeProfile = {
  devices: ["auto", "cpu", "cuda"],
  compute_types: ["auto", "int8", "float16"],
  recommended_device: "cpu",
  recommended_compute_type: "int8",
};

const WHISPER_LARGE_PROFILE: TranscriptionRuntimeProfile = {
  devices: ["auto", "cpu", "cuda"],
  compute_types: ["auto", "int8", "float16"],
  recommended_device: "auto",
  recommended_compute_type: "auto",
};

const QWEN3_ASR_PROFILE: TranscriptionRuntimeProfile = {
  devices: ["auto", "cuda"],
  compute_types: ["auto", "float16"],
  recommended_device: "cuda",
  recommended_compute_type: "float16",
};

const SENSEVOICE_PROFILE: TranscriptionRuntimeProfile = {
  devices: ["auto", "cpu", "cuda"],
  compute_types: ["auto"],
  recommended_device: "auto",
  recommended_compute_type: "auto",
};

const RUNTIME_PROFILES = new Map<string, TranscriptionRuntimeProfile>([
  ["faster-whisper:tiny", WHISPER_CPU_PROFILE],
  ["faster-whisper:base", WHISPER_CPU_PROFILE],
  ["faster-whisper:small", WHISPER_CPU_PROFILE],
  ["faster-whisper:medium", WHISPER_LARGE_PROFILE],
  ["faster-whisper:large-v2", WHISPER_LARGE_PROFILE],
  ["faster-whisper:large-v3-turbo", WHISPER_LARGE_PROFILE],
  ["faster-whisper:large-v3", WHISPER_LARGE_PROFILE],
  ["qwen3-asr:qwen3-asr-0.6b", QWEN3_ASR_PROFILE],
  ["qwen3-asr:qwen3-asr-1.7b", QWEN3_ASR_PROFILE],
  ["sensevoice:sensevoice-small", SENSEVOICE_PROFILE],
]);

export function transcription_model_is_selectable(
  model: TranscriptionModelDescriptor,
): boolean {
  return (
    model.integration_status === "available" &&
    model.installation_status === "installed"
  );
}

export function transcription_runtime_profile(
  model: TranscriptionModelDescriptor,
): TranscriptionRuntimeProfile {
  const model_key = `${model.engine}:${model.model}`;
  return RUNTIME_PROFILES.get(model_key) ?? WHISPER_CPU_PROFILE;
}

export function transcription_compute_type_is_compatible(
  device: TranscriptionDevice,
  compute_type: TranscriptionComputeType,
): boolean {
  return compute_type !== "float16" || device === "cuda";
}
