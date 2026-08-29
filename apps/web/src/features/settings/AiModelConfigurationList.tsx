import { useState } from "react";
import {
  Activity,
  Bot,
  CircleCheck,
  CircleHelp,
  CircleX,
  Cloud,
  Pencil,
  Plus,
  Trash2,
  TriangleAlert,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { model_id } from "@/shared/identifiers";
import { online_ai_model_error } from "@/shared/online_ai_models";
import {
  AI_INPUT_MODALITIES,
  DEFAULT_MODEL_CAPABILITY_OVERRIDES,
  type ModelCapabilityName,
  type ModelCapabilityOverride,
  type ModelCapabilitySource,
  type ModelCapabilitySupport,
  type ModelProfile,
  type AiInputModality,
  type AiModelConfiguration,
  type AiModelTestResult,
} from "@/shared/types";

const INPUT_MODALITY_LABELS: Record<AiInputModality, string> = {
  text: "文本",
  image: "图片",
  audio: "音频",
  video: "视频",
};

const CAPABILITY_LABELS: Partial<Record<ModelCapabilityName, string>> = {
  tools: "工具调用",
  vision: "图片输入",
  reasoning: "推理",
  structured_output: "结构化输出",
  streaming_tools: "流式工具",
  reasoning_tools: "推理 + 工具",
  tool_choice_named: "指定工具",
  vision_tools: "图片 + 工具",
};

const CAPABILITY_SOURCE_LABELS: Record<ModelCapabilitySource, string> = {
  user_override: "用户覆盖",
  runtime_probe: "已实测",
  local_override: "本地规则",
  models_dev: "在线模型目录",
  litellm_metadata: "LiteLLM 辅助",
  unknown: "暂无证据",
};

type AiModelConfigurationListProps = {
  models: AiModelConfiguration[];
  profiles?: Partial<Record<string, ModelProfile>>;
  managed: boolean;
  on_test_model: (model: AiModelConfiguration) => Promise<AiModelTestResult>;
  on_change: (models: AiModelConfiguration[]) => void;
};

type ModelTestState =
  | { phase: "testing" }
  | { phase: "complete"; result: AiModelTestResult }
  | { phase: "request_error"; message: string };

const NEW_AI_MODEL: Omit<AiModelConfiguration, "model_id"> = {
  name: "",
  litellm_model: "",
  api_key: null,
  api_base: null,
  api_version: null,
  input_modalities: ["text"],
  capabilities: { ...DEFAULT_MODEL_CAPABILITY_OVERRIDES },
};

export function AiModelConfigurationList({
  models,
  profiles = {},
  managed,
  on_test_model,
  on_change,
}: AiModelConfigurationListProps) {
  const [test_states, set_test_states] = useState<
    Record<string, ModelTestState>
  >({});
  const [dialog_open, set_dialog_open] = useState(false);
  const [editing_model_id, set_editing_model_id] = useState<string | null>(
    null,
  );
  const [draft, set_draft] = useState<AiModelConfiguration | null>(null);

  function clear_test_state(model_id: string) {
    set_test_states((current) => {
      if (!(model_id in current)) return current;
      const next_states = { ...current };
      delete next_states[model_id];
      return next_states;
    });
  }

  function remove_model(model_id: string) {
    clear_test_state(model_id);
    on_change(models.filter((model) => model.model_id !== model_id));
  }

  function open_add_dialog() {
    set_editing_model_id(null);
    set_draft({ model_id: model_id(), ...NEW_AI_MODEL });
    set_dialog_open(true);
  }

  function open_edit_dialog(model: AiModelConfiguration) {
    set_editing_model_id(model.model_id);
    set_draft({ ...model, input_modalities: [...model.input_modalities] });
    set_dialog_open(true);
  }

  function save_draft(model: AiModelConfiguration) {
    if (editing_model_id) {
      clear_test_state(editing_model_id);
      on_change(
        models.map((current_model) =>
          current_model.model_id === editing_model_id ? model : current_model,
        ),
      );
    } else {
      on_change([...models, model]);
    }
    set_dialog_open(false);
  }

  async function test_model(model: AiModelConfiguration) {
    set_test_states((current) => ({
      ...current,
      [model.model_id]: { phase: "testing" },
    }));
    try {
      const result = await on_test_model(model);
      set_test_states((current) => ({
        ...current,
        [model.model_id]: { phase: "complete", result },
      }));
    } catch (error) {
      set_test_states((current) => ({
        ...current,
        [model.model_id]: {
          phase: "request_error",
          message: error instanceof Error ? error.message : "模型测试请求失败",
        },
      }));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {models.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Bot aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>尚未配置 AI 模型</EmptyTitle>
            <EmptyDescription>
              添加在线 LiteLLM API 后，助手会按已验证能力自动分配模型角色。
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="flex flex-col gap-3" aria-label="AI 模型列表">
          {models.map((model) => {
            const test_state = test_states[model.model_id];
            const testing = test_state?.phase === "testing";
            const configuration_error = online_ai_model_error(model);
            const test_status_id = `ai-model-${model.model_id}-test-status`;
            const profile =
              test_state?.phase === "complete"
                ? test_state.result.profile
                : profiles[model.model_id];
            return (
              <li key={model.model_id}>
                <Card size="sm">
                  <CardHeader>
                    <CardTitle>{model.name}</CardTitle>
                    <CardDescription className="font-mono break-all">
                      {model.litellm_model}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-3">
                    {configuration_error ? (
                      <Alert variant="destructive">
                        <TriangleAlert aria-hidden="true" />
                        <AlertTitle>不能用于助手</AlertTitle>
                        <AlertDescription>
                          {configuration_error}
                        </AlertDescription>
                      </Alert>
                    ) : (
                      <Badge variant="outline" className="w-fit">
                        <Cloud aria-hidden="true" /> 在线 API
                      </Badge>
                    )}
                    <div className="flex flex-wrap gap-1">
                      {model.input_modalities.map((modality) => (
                        <Badge key={modality} variant="secondary">
                          {INPUT_MODALITY_LABELS[modality]}
                        </Badge>
                      ))}
                    </div>
                    {profile ? <ModelCapabilityGrid profile={profile} /> : null}
                  </CardContent>
                  <CardFooter className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <ModelTestFeedback id={test_status_id} state={test_state} />
                    <div className="flex flex-wrap justify-end gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => void test_model(model)}
                        disabled={testing || configuration_error !== null}
                        aria-describedby={test_status_id}
                      >
                        {testing ? (
                          <Spinner data-icon="inline-start" />
                        ) : (
                          <Activity data-icon="inline-start" />
                        )}
                        {testing ? "正在测试" : "测试"}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => open_edit_dialog(model)}
                        disabled={managed || testing}
                      >
                        <Pencil data-icon="inline-start" />
                        编辑
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => remove_model(model.model_id)}
                        disabled={managed || testing}
                      >
                        <Trash2 data-icon="inline-start" />
                        删除
                      </Button>
                    </div>
                  </CardFooter>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex justify-end">
        <Button
          type="button"
          variant="outline"
          onClick={open_add_dialog}
          disabled={managed}
        >
          <Plus data-icon="inline-start" />
          添加模型
        </Button>
      </div>
      <Dialog open={dialog_open} onOpenChange={set_dialog_open}>
        {draft ? (
          <AiModelConfigurationDialog
            mode={editing_model_id ? "edit" : "add"}
            model={draft}
            on_change={set_draft}
            on_submit={save_draft}
          />
        ) : null}
      </Dialog>
    </div>
  );
}

function AiModelConfigurationDialog({
  mode,
  model,
  on_change,
  on_submit,
}: {
  mode: "add" | "edit";
  model: AiModelConfiguration;
  on_change: (model: AiModelConfiguration) => void;
  on_submit: (model: AiModelConfiguration) => void;
}) {
  const field_prefix = `ai-model-dialog-${model.model_id}`;
  const configuration_error = online_ai_model_error(model);
  const submit_disabled =
    !model.name.trim() ||
    !model.litellm_model.trim() ||
    configuration_error !== null;

  function update_model(patch: Partial<AiModelConfiguration>) {
    on_change({ ...model, ...patch });
  }

  return (
    <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
      <form
        className="flex flex-col gap-6"
        onSubmit={(event) => {
          event.preventDefault();
          if (!submit_disabled) on_submit(model);
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {mode === "add" ? "添加 AI 模型" : "编辑 AI 模型"}
          </DialogTitle>
          <DialogDescription>
            配置在线 LiteLLM API、连接凭据和模型支持的输入模态。
          </DialogDescription>
        </DialogHeader>
        <Alert variant={configuration_error ? "destructive" : "default"}>
          {configuration_error ? (
            <TriangleAlert aria-hidden="true" />
          ) : (
            <Cloud aria-hidden="true" />
          )}
          <AlertTitle>
            {configuration_error ? "配置不符合在线模型要求" : "仅使用在线 API"}
          </AlertTitle>
          <AlertDescription>
            {configuration_error ??
              "助手的大语言与视觉推理通过在线 API 执行；转录、OCR、关键帧和检索仍默认在本机完成。"}
          </AlertDescription>
        </Alert>
        <FieldGroup>
          <div className="grid gap-4 md:grid-cols-2">
            <Field>
              <FieldLabel htmlFor={`${field_prefix}-name`}>显示名称</FieldLabel>
              <Input
                id={`${field_prefix}-name`}
                value={model.name}
                onChange={(event) => update_model({ name: event.target.value })}
                placeholder="例如：视觉分析模型"
                autoFocus
                required
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${field_prefix}-model`}>
                LiteLLM 模型
              </FieldLabel>
              <Input
                id={`${field_prefix}-model`}
                value={model.litellm_model}
                onChange={(event) =>
                  update_model({ litellm_model: event.target.value })
                }
                placeholder="例如：anthropic/claude-sonnet-4-5"
                required
              />
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor={`${field_prefix}-api-base`}>
              API 地址
            </FieldLabel>
            <Input
              id={`${field_prefix}-api-base`}
              value={model.api_base ?? ""}
              onChange={(event) =>
                update_model({ api_base: event.target.value || null })
              }
              placeholder="可选；在线兼容网关的 HTTPS 地址"
            />
          </Field>
          <div className="grid gap-4 md:grid-cols-2">
            <Field>
              <FieldLabel htmlFor={`${field_prefix}-api-key`}>
                API 密钥
              </FieldLabel>
              <Input
                id={`${field_prefix}-api-key`}
                type="password"
                value={model.api_key ?? ""}
                onChange={(event) =>
                  update_model({ api_key: event.target.value || null })
                }
                autoComplete="off"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${field_prefix}-api-version`}>
                API 版本
              </FieldLabel>
              <Input
                id={`${field_prefix}-api-version`}
                value={model.api_version ?? ""}
                onChange={(event) =>
                  update_model({ api_version: event.target.value || null })
                }
                placeholder="Azure 等供应商可选"
              />
            </Field>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {(
              [
                ["tools", "工具调用"],
                ["vision", "图片输入"],
                ["reasoning", "推理"],
              ] as const
            ).map(([capability, label]) => (
              <CapabilityOverrideField
                key={capability}
                id={`${field_prefix}-${capability}`}
                label={label}
                value={model.capabilities[capability]}
                on_change={(value) =>
                  update_model({
                    capabilities: {
                      ...model.capabilities,
                      [capability]: value,
                    },
                  })
                }
              />
            ))}
          </div>
          <FieldDescription>
            自动模式综合在线目录、本地规则与真实探测；启用表示允许真实尝试，禁用会明确阻止对应能力。
          </FieldDescription>
          <Field>
            <FieldLabel id={`${field_prefix}-input-modalities`}>
              输入模态
            </FieldLabel>
            <ToggleGroup
              type="multiple"
              variant="outline"
              value={model.input_modalities}
              onValueChange={(input_modalities) =>
                update_model({
                  input_modalities: AI_INPUT_MODALITIES.filter(
                    (modality) =>
                      modality === "text" ||
                      input_modalities.includes(modality),
                  ),
                })
              }
              aria-labelledby={`${field_prefix}-input-modalities`}
              className="flex-wrap justify-start"
            >
              {AI_INPUT_MODALITIES.map((modality) => (
                <ToggleGroupItem
                  key={modality}
                  value={modality}
                  disabled={modality === "text"}
                >
                  {INPUT_MODALITY_LABELS[modality]}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <FieldDescription>
              文本为基础输入；按模型能力补充图片、音频或视频。
            </FieldDescription>
          </Field>
        </FieldGroup>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              取消
            </Button>
          </DialogClose>
          <Button type="submit" disabled={submit_disabled}>
            {mode === "add" ? "确认添加" : "保存修改"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function CapabilityOverrideField({
  id,
  label,
  value,
  on_change,
}: {
  id: string;
  label: string;
  value: ModelCapabilityOverride;
  on_change: (value: ModelCapabilityOverride) => void;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select
        value={value}
        onValueChange={(next_value) =>
          on_change(next_value as ModelCapabilityOverride)
        }
      >
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="auto">自动</SelectItem>
            <SelectItem value="enabled">启用</SelectItem>
            <SelectItem value="disabled">禁用</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  );
}

function ModelCapabilityGrid({ profile }: { profile: ModelProfile }) {
  return (
    <div
      className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4"
      aria-label="模型能力"
    >
      {Object.entries(CAPABILITY_LABELS).map(([capability, label]) => {
        const capability_name = capability as ModelCapabilityName;
        const support = profile.capabilities[capability_name];
        const source = profile.capability_sources[capability_name] ?? "unknown";
        return (
          <div
            key={capability}
            className="flex min-w-0 items-center justify-between gap-2 rounded-md border p-2"
          >
            <span className="truncate text-xs font-medium">{label}</span>
            <Badge
              variant={
                support === "yes"
                  ? "secondary"
                  : support === "no"
                    ? "destructive"
                    : "outline"
              }
              aria-label={`${label}：${support_label(support)}，${CAPABILITY_SOURCE_LABELS[source]}`}
              title={CAPABILITY_SOURCE_LABELS[source]}
            >
              {support === "yes" ? (
                <CircleCheck data-icon="inline-start" />
              ) : support === "no" ? (
                <CircleX data-icon="inline-start" />
              ) : (
                <CircleHelp data-icon="inline-start" />
              )}
              {support_label(support)}
            </Badge>
          </div>
        );
      })}
    </div>
  );
}

function support_label(support: ModelCapabilitySupport): string {
  return {
    yes: "已确认",
    no: "不支持",
    unknown: "未知",
  }[support];
}

function ModelTestFeedback({
  id,
  state,
}: {
  id: string;
  state: ModelTestState | undefined;
}) {
  if (!state) {
    return (
      <p id={id} className="text-sm text-muted-foreground">
        测试会分别探测文本、工具和已声明的图片输入，不会保存当前修改。
      </p>
    );
  }
  if (state.phase === "testing") {
    return (
      <div id={id} role="status" aria-live="polite">
        <Badge variant="outline">
          <Spinner data-icon="inline-start" />
          正在测试
        </Badge>
      </div>
    );
  }
  if (state.phase === "request_error") {
    return (
      <div id={id} role="alert" className="flex flex-col gap-2">
        <Badge variant="destructive">
          <CircleX data-icon="inline-start" />
          请求失败
        </Badge>
        <p className="text-sm break-words text-destructive">{state.message}</p>
      </div>
    );
  }

  const result = state.result;
  return (
    <div
      id={id}
      className="flex min-w-0 flex-1 flex-col gap-2"
      role="status"
      aria-live="polite"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={result.available ? "secondary" : "destructive"}>
          {result.available ? (
            <CircleCheck data-icon="inline-start" />
          ) : (
            <CircleX data-icon="inline-start" />
          )}
          {result.available ? "可用" : "不可用"}
        </Badge>
        <span className="text-sm text-muted-foreground">
          延迟 {result.latency_ms} ms
        </span>
      </div>
      <p
        className={cn(
          "text-sm",
          result.available
            ? "text-muted-foreground"
            : "break-words text-destructive",
        )}
      >
        {result.message}
      </p>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {Object.entries({
          text: "文本",
          ...CAPABILITY_LABELS,
        }).map(([capability, label]) => {
          const probe =
            result.capabilities[capability as keyof typeof result.capabilities];
          if (!probe) return null;
          return (
            <div key={capability} className="rounded-md border p-2 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{label}</span>
                <Badge
                  variant={
                    probe.support === "yes"
                      ? "secondary"
                      : probe.support === "no"
                        ? "destructive"
                        : "outline"
                  }
                >
                  {support_label(probe.support)}
                </Badge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {probe.message} · {CAPABILITY_SOURCE_LABELS[probe.source]}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
