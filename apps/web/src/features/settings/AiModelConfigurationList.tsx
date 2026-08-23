import { Bot, Trash2 } from "lucide-react";

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
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  AI_INPUT_MODALITIES,
  type AiInputModality,
  type AiModelConfiguration,
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
  on_change: (models: AiModelConfiguration[]) => void;
};

export function AiModelConfigurationList({
  models,
  managed,
  on_change,
}: AiModelConfigurationListProps) {
  function update_model(
    model_id: string,
    patch: Partial<AiModelConfiguration>,
  ) {
    on_change(
      models.map((model) =>
        model.model_id === model_id ? { ...model, ...patch } : model,
      ),
    );
  }

  function remove_model(model_id: string) {
    on_change(models.filter((model) => model.model_id !== model_id));
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
                  <Field data-disabled={managed || undefined}>
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
                      disabled={managed}
                    />
                  </Field>
                  <Field data-disabled={managed || undefined}>
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
                      disabled={managed}
                    />
                  </Field>
                </div>
                <Field data-disabled={managed || undefined}>
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
                    disabled={managed}
                  />
                </Field>
                <div className="grid gap-5 md:grid-cols-2">
                  <Field data-disabled={managed || undefined}>
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
                      disabled={managed}
                    />
                  </Field>
                  <Field data-disabled={managed || undefined}>
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
                      disabled={managed}
                    />
                  </Field>
                </div>
                <Field data-disabled={managed || undefined}>
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
                    disabled={managed}
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
            <CardFooter className="justify-end">
              <Button
                type="button"
                variant="outline"
                onClick={() => remove_model(model.model_id)}
                disabled={managed}
              >
                <Trash2 data-icon="inline-start" />
                删除模型
              </Button>
            </CardFooter>
          </Card>
        );
      })}
    </div>
  );
}
