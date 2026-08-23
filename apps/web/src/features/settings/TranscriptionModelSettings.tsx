import { Gauge } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  TranscriptionComputeType,
  TranscriptionDevice,
  TranscriptionEngine,
  TranscriptionModelDescriptor,
  TranscriptionOptions,
} from "@/shared/types";
import { TranscriptionModelDownloadAction } from "./TranscriptionModelDownloadAction";

const ENGINE_LABELS: Record<TranscriptionEngine, string> = {
  "faster-whisper": "Faster Whisper",
  "qwen3-asr": "Qwen3-ASR",
  sensevoice: "SenseVoice",
};

const DEVICE_LABELS: Record<TranscriptionDevice, string> = {
  auto: "自动选择",
  cpu: "CPU",
  cuda: "NVIDIA CUDA",
};

const COMPUTE_TYPE_LABELS: Record<TranscriptionComputeType, string> = {
  auto: "自动选择",
  int8: "Int8",
  float16: "Float16",
};

const LANGUAGE_OPTIONS = [
  { value: "auto", label: "自动检测" },
  { value: "zh", label: "中文" },
  { value: "en", label: "英语" },
  { value: "yue", label: "粤语" },
] as const;

const INSTALLATION_LABELS: Record<
  TranscriptionModelDescriptor["installation_status"],
  string
> = {
  not_installed: "未安装",
  downloading: "下载中",
  installed: "已安装",
  failed: "下载失败",
};

type TranscriptionModelSettingsProps = {
  models: TranscriptionModelDescriptor[];
  value: TranscriptionOptions;
  on_change: (value: TranscriptionOptions) => void;
  on_model_change: (model: TranscriptionModelDescriptor) => void;
};

export function TranscriptionModelSettings({
  models,
  value,
  on_change,
  on_model_change,
}: TranscriptionModelSettingsProps) {
  const available_models = models.filter(
    (model) => model.integration_status === "available",
  );
  const selected_model = models.find(
    (model) => model.engine === value.engine && model.model === value.model,
  );

  function change_model(model_name: string) {
    const model = available_models.find((item) => item.model === model_name);
    if (!model) return;
    on_change({ ...value, engine: model.engine, model: model.model });
  }

  function change_device(device: TranscriptionDevice) {
    const compute_type =
      device !== "cuda" && value.compute_type === "float16"
        ? "int8"
        : value.compute_type;
    on_change({ ...value, device, compute_type });
  }

  return (
    <div className="flex flex-col gap-6">
      <FieldGroup>
        <div className="grid gap-6 md:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="default_transcription_model">
              默认模型
            </FieldLabel>
            <Select value={value.model} onValueChange={change_model}>
              <SelectTrigger
                id="default_transcription_model"
                className="w-full"
              >
                <SelectValue placeholder="选择转录模型" />
              </SelectTrigger>
              <SelectContent>
                {group_models_by_engine(available_models).map(
                  ([engine, engine_models]) => (
                    <SelectGroup key={engine}>
                      <SelectLabel>{ENGINE_LABELS[engine]}</SelectLabel>
                      {engine_models.map((model) => (
                        <SelectItem key={model.model} value={model.model}>
                          {model.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ),
                )}
              </SelectContent>
            </Select>
            <FieldDescription>
              新转录任务默认使用该模型，工作台仍可按任务覆盖。
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="default_transcription_language">
              默认语言
            </FieldLabel>
            <Select
              value={value.language ?? "auto"}
              onValueChange={(language) =>
                on_change({
                  ...value,
                  language: language === "auto" ? null : language,
                })
              }
            >
              <SelectTrigger
                id="default_transcription_language"
                className="w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>音频语言</SelectLabel>
                  {LANGUAGE_OPTIONS.map((language) => (
                    <SelectItem key={language.value} value={language.value}>
                      {language.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <FieldDescription>
              语言明确时固定选择通常比自动检测更稳定。
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="default_transcription_device">
              运行设备
            </FieldLabel>
            <Select
              value={value.device}
              onValueChange={(device) =>
                change_device(device as TranscriptionDevice)
              }
            >
              <SelectTrigger
                id="default_transcription_device"
                className="w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>推理设备</SelectLabel>
                  {Object.entries(DEVICE_LABELS).map(([device, label]) => (
                    <SelectItem key={device} value={device}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>

          <Field>
            <FieldLabel htmlFor="default_transcription_compute_type">
              计算精度
            </FieldLabel>
            <Select
              value={value.compute_type}
              onValueChange={(compute_type) =>
                on_change({
                  ...value,
                  compute_type: compute_type as TranscriptionComputeType,
                })
              }
            >
              <SelectTrigger
                id="default_transcription_compute_type"
                className="w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>推理精度</SelectLabel>
                  {Object.entries(COMPUTE_TYPE_LABELS).map(
                    ([compute_type, label]) => (
                      <SelectItem
                        key={compute_type}
                        value={compute_type}
                        disabled={
                          value.device !== "cuda" && compute_type === "float16"
                        }
                      >
                        {label}
                      </SelectItem>
                    ),
                  )}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        </div>
      </FieldGroup>

      {selected_model ? (
        <Alert>
          <Gauge aria-hidden="true" />
          <AlertTitle className="flex flex-wrap items-center gap-2">
            {selected_model.name}
            {selected_model.recommended ? (
              <Badge variant="secondary">推荐</Badge>
            ) : null}
          </AlertTitle>
          <AlertDescription>
            {selected_model.description} 精度：{selected_model.accuracy}；速度：
            {selected_model.speed}。
          </AlertDescription>
        </Alert>
      ) : null}

      <section className="flex flex-col gap-4" aria-labelledby="asr_models">
        <div className="flex flex-col gap-1">
          <h3 id="asr_models" className="font-medium">
            本地模型
          </h3>
          <p className="text-sm text-muted-foreground">
            模型文件直接从标注的官方仓库下载到模型目录。扩展引擎仍需安装运行适配器才能执行转录。
          </p>
        </div>
        <ul
          className="overflow-hidden rounded-lg border"
          aria-label="本地转录模型列表"
        >
          {models.map((model) => (
            <li
              key={`${model.engine}:${model.model}`}
              className="grid gap-3 border-b px-3 py-3 last:border-b-0 md:grid-cols-[minmax(0,1fr)_10rem] md:items-center"
            >
              <div className="flex min-w-0 flex-col gap-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <strong className="text-sm font-medium">{model.name}</strong>
                  <span className="text-xs text-muted-foreground">
                    {ENGINE_LABELS[model.engine]}
                  </span>
                  {model.recommended ? (
                    <Badge variant="secondary">推荐</Badge>
                  ) : null}
                  <Badge
                    variant={
                      model.installation_status === "installed"
                        ? "secondary"
                        : "outline"
                    }
                  >
                    {INSTALLATION_LABELS[model.installation_status]}
                  </Badge>
                  {model.integration_status === "adapter_required" ? (
                    <Badge variant="outline">待接入</Badge>
                  ) : null}
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  {model.description}
                </p>
                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span>精度 {model.accuracy}</span>
                  <span>速度 {model.speed}</span>
                  <span>{model.languages.join(" / ")}</span>
                  <span className="min-w-0 truncate font-mono">
                    {model.repository}
                  </span>
                </div>
              </div>
              <div className="min-w-0">
                <TranscriptionModelDownloadAction
                  model={model}
                  on_change={on_model_change}
                />
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function group_models_by_engine(
  models: TranscriptionModelDescriptor[],
): [TranscriptionEngine, TranscriptionModelDescriptor[]][] {
  const models_by_engine = new Map<
    TranscriptionEngine,
    TranscriptionModelDescriptor[]
  >();
  for (const model of models) {
    const engine_models = models_by_engine.get(model.engine) ?? [];
    engine_models.push(model);
    models_by_engine.set(model.engine, engine_models);
  }
  return [...models_by_engine.entries()];
}
