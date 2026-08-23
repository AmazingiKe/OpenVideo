import { useState } from "react";
import {
  Activity,
  Bot,
  CircleCheck,
  CircleX,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";

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
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { model_id } from "@/shared/identifiers";
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

const NEW_AI_MODEL: Omit<AiModelConfiguration, "model_id"> = {
  name: "",
  litellm_model: "",
  api_key: null,
  api_base: null,
  api_version: null,
  input_modalities: ["text"],
};

export function AiModelConfigurationList({
  models,
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
              添加 LiteLLM 模型后，分析工作台才能选择模型执行内容任务。
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="flex flex-col gap-3" aria-label="AI 模型列表">
          {models.map((model) => {
            const test_state = test_states[model.model_id];
            const testing = test_state?.phase === "testing";
            const test_status_id = `ai-model-${model.model_id}-test-status`;
            return (
              <li key={model.model_id}>
                <Card size="sm">
                  <CardHeader>
                    <CardTitle>{model.name}</CardTitle>
                    <CardDescription className="font-mono break-all">
                      {model.litellm_model}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-wrap gap-1">
                    {model.input_modalities.map((modality) => (
                      <Badge key={modality} variant="secondary">
                        {INPUT_MODALITY_LABELS[modality]}
                      </Badge>
                    ))}
                  </CardContent>
                  <CardFooter className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <ModelTestFeedback id={test_status_id} state={test_state} />
                    <div className="flex flex-wrap justify-end gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => void test_model(model)}
                        disabled={testing}
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
  const submit_disabled = !model.name.trim() || !model.litellm_model.trim();

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
            配置 LiteLLM 模型标识、连接凭据和模型支持的输入模态。
          </DialogDescription>
        </DialogHeader>
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
              placeholder="可选；Ollama 或兼容网关填写自定义地址"
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
