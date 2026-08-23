import { useState } from "react";
import { Activity, Bot, CircleCheck, CircleX, Trash2 } from "lucide-react";

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
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import {
  AI_INPUT_MODALITIES,
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

type AiModelConfigurationListProps = {
  models: AiModelConfiguration[];
  managed: boolean;
  on_test_model: (model: AiModelConfiguration) => Promise<AiModelTestResult>;
  on_change: (models: AiModelConfiguration[]) => void;
};

type ModelTestState =
  | { phase: "testing" }
  | { phase: "complete"; result: AiModelTestResult }
  | { phase: "request_error"; message: string };

export function AiModelConfigurationList({
  models,
  managed,
  on_test_model,
  on_change,
}: AiModelConfigurationListProps) {
  const [test_states, set_test_states] = useState<
    Record<string, ModelTestState>
  >({});

  function clear_test_state(model_id: string) {
    set_test_states((current) => {
      if (!(model_id in current)) return current;
      const next_states = { ...current };
      delete next_states[model_id];
      return next_states;
    });
  }

  function update_model(
    model_id: string,
    patch: Partial<AiModelConfiguration>,
  ) {
    clear_test_state(model_id);
    on_change(
      models.map((model) =>
        model.model_id === model_id ? { ...model, ...patch } : model,
      ),
    );
  }

  function remove_model(model_id: string) {
    clear_test_state(model_id);
    on_change(models.filter((model) => model.model_id !== model_id));
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

  if (models.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Bot aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>尚未配置 AI 模型</EmptyTitle>
          <EmptyDescription>
            添加 LiteLLM 模型后，分析工作台才能选择模型执行内容任务。
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {models.map((model) => {
        const field_prefix = `ai-model-${model.model_id}`;
        const test_state = test_states[model.model_id];
        const testing = test_state?.phase === "testing";
        const fields_disabled = managed || testing;
        const test_disabled =
          testing || !model.name.trim() || !model.litellm_model.trim();
        const test_status_id = `${field_prefix}-test-status`;
        return (
          <Card key={model.model_id}>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center justify-between gap-2">
                <span>{model.name || "未命名模型"}</span>
                <span className="flex flex-wrap justify-end gap-1">
                  {model.input_modalities.map((modality) => (
                    <Badge key={modality} variant="secondary">
                      {INPUT_MODALITY_LABELS[modality]}
                    </Badge>
                  ))}
                </span>
              </CardTitle>
              <CardDescription>{model.litellm_model}</CardDescription>
            </CardHeader>
            <CardContent>
              <FieldGroup>
                <div className="grid gap-5 md:grid-cols-2">
                  <Field data-disabled={fields_disabled || undefined}>
                    <FieldLabel htmlFor={`${field_prefix}-name`}>
                      显示名称
                    </FieldLabel>
                    <Input
                      id={`${field_prefix}-name`}
                      value={model.name}
                      onChange={(event) =>
                        update_model(model.model_id, {
                          name: event.target.value,
                        })
                      }
                      disabled={fields_disabled}
                    />
                  </Field>
                  <Field data-disabled={fields_disabled || undefined}>
                    <FieldLabel htmlFor={`${field_prefix}-model`}>
                      LiteLLM 模型
                    </FieldLabel>
                    <Input
                      id={`${field_prefix}-model`}
                      value={model.litellm_model}
                      onChange={(event) =>
                        update_model(model.model_id, {
                          litellm_model: event.target.value,
                        })
                      }
                      placeholder="例如 anthropic/claude-sonnet-4-5"
                      disabled={fields_disabled}
                    />
                  </Field>
                </div>
                <Field data-disabled={fields_disabled || undefined}>
                  <FieldLabel htmlFor={`${field_prefix}-api-base`}>
                    API 地址
                  </FieldLabel>
                  <Input
                    id={`${field_prefix}-api-base`}
                    value={model.api_base ?? ""}
                    onChange={(event) =>
                      update_model(model.model_id, {
                        api_base: event.target.value || null,
                      })
                    }
                    placeholder="可选；Ollama 或兼容网关填写自定义地址"
                    disabled={fields_disabled}
                  />
                </Field>
                <div className="grid gap-5 md:grid-cols-2">
                  <Field data-disabled={fields_disabled || undefined}>
                    <FieldLabel htmlFor={`${field_prefix}-api-key`}>
                      API 密钥
                    </FieldLabel>
                    <Input
                      id={`${field_prefix}-api-key`}
                      type="password"
                      value={model.api_key ?? ""}
                      onChange={(event) =>
                        update_model(model.model_id, {
                          api_key: event.target.value || null,
                        })
                      }
                      disabled={fields_disabled}
                    />
                  </Field>
                  <Field data-disabled={fields_disabled || undefined}>
                    <FieldLabel htmlFor={`${field_prefix}-api-version`}>
                      API 版本
                    </FieldLabel>
                    <Input
                      id={`${field_prefix}-api-version`}
                      value={model.api_version ?? ""}
                      onChange={(event) =>
                        update_model(model.model_id, {
                          api_version: event.target.value || null,
                        })
                      }
                      placeholder="Azure 等供应商可选"
                      disabled={fields_disabled}
                    />
                  </Field>
                </div>
                <Field data-disabled={fields_disabled || undefined}>
                  <FieldLabel id={`${field_prefix}-input-modalities`}>
                    输入模态
                  </FieldLabel>
                  <ToggleGroup
                    type="multiple"
                    variant="outline"
                    value={model.input_modalities}
                    onValueChange={(input_modalities) =>
                      update_model(model.model_id, {
                        input_modalities: AI_INPUT_MODALITIES.filter(
                          (modality) =>
                            modality === "text" ||
                            input_modalities.includes(modality),
                        ),
                      })
                    }
                    disabled={fields_disabled}
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
                    文本是当前任务的基础输入；图片用于关键帧分析，音频和视频用于登记原生多模态能力。
                  </FieldDescription>
                </Field>
              </FieldGroup>
            </CardContent>
            <CardFooter className="flex flex-col items-stretch gap-4 sm:flex-row sm:items-end sm:justify-between">
              <ModelTestFeedback id={test_status_id} state={test_state} />
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void test_model(model)}
                  disabled={test_disabled}
                  aria-describedby={test_status_id}
                >
                  {testing ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <Activity data-icon="inline-start" />
                  )}
                  {testing ? "正在测试" : "测试模型"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => remove_model(model.model_id)}
                  disabled={fields_disabled}
                >
                  <Trash2 data-icon="inline-start" />
                  删除模型
                </Button>
              </div>
            </CardFooter>
          </Card>
        );
      })}
    </div>
  );
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
        测试会发送一条最小文本请求，不会保存当前修改。
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

  const result =
    state.phase === "complete"
      ? state.result
      : {
          available: false,
          latency_ms: null,
          message: state.message,
        };
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
        {result.latency_ms !== null ? (
          <span className="text-sm text-muted-foreground">
            延迟 {result.latency_ms} ms
          </span>
        ) : null}
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
    </div>
  );
}
