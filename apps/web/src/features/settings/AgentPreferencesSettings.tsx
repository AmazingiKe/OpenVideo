import { TriangleAlert } from "lucide-react";
import { useId } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type {
  AgentPermissionMode,
  AgentPreferences,
  AgentThinkingMode,
  AiModelConfiguration,
} from "@/shared/types";

const AUTOMATIC_MODEL_VALUE = "automatic";
const MINIMUM_CONCURRENT_RUNS = 1;
const MAXIMUM_CONCURRENT_RUNS = 32;

const PERMISSION_DESCRIPTIONS: Record<AgentPermissionMode, string> = {
  request_approval: "编辑外部文件或使用互联网等工具操作都会先请求批准。",
  smart_approval:
    "正常读取直接执行，只在检测到写入、删除或外部操作风险时询问。",
  full_access: "工具操作不再逐次询问。仅在你完全信任当前环境时使用。",
};

const THINKING_DESCRIPTIONS: Record<AgentThinkingMode, string> = {
  auto: "由 Agent 根据任务复杂度选择快速或复杂模型。",
  fast: "默认优先较低延迟，适合检索、提取与简短问答。",
  complex: "默认优先深度分析，适合多步推理与复杂任务。",
};

export function AgentPreferencesSettings({
  value,
  models,
  on_change,
}: {
  value: AgentPreferences;
  models: AiModelConfiguration[];
  on_change: (value: AgentPreferences) => void;
}) {
  const control_id = useId();

  function update_preference<Key extends keyof AgentPreferences>(
    key: Key,
    next_value: AgentPreferences[Key],
  ) {
    on_change({ ...value, [key]: next_value });
  }

  return (
    <FieldGroup>
      <Field>
        <FieldLabel id={`${control_id}-permission`}>权限控制</FieldLabel>
        <ToggleGroup
          type="single"
          variant="outline"
          spacing={0}
          value={value.permission_mode}
          onValueChange={(permission_mode) => {
            if (is_permission_mode(permission_mode)) {
              update_preference("permission_mode", permission_mode);
            }
          }}
          aria-labelledby={`${control_id}-permission`}
          aria-describedby={`${control_id}-permission-description`}
          className="w-full flex-wrap sm:flex-nowrap"
        >
          <ToggleGroupItem className="min-w-28 flex-1" value="request_approval">
            始终询问
          </ToggleGroupItem>
          <ToggleGroupItem className="min-w-28 flex-1" value="smart_approval">
            仅风险询问
          </ToggleGroupItem>
          <ToggleGroupItem className="min-w-28 flex-1" value="full_access">
            完全访问
          </ToggleGroupItem>
        </ToggleGroup>
        <FieldDescription id={`${control_id}-permission-description`}>
          {PERMISSION_DESCRIPTIONS[value.permission_mode]}
        </FieldDescription>
        {value.permission_mode === "full_access" ? (
          <Alert variant="destructive">
            <TriangleAlert aria-hidden="true" />
            <AlertTitle>完全访问会跳过逐次批准</AlertTitle>
            <AlertDescription>
              Agent
              可直接写入文件、访问互联网和执行已启用工具，请确认运行环境可信。
            </AlertDescription>
          </Alert>
        ) : null}
      </Field>

      <Field>
        <FieldLabel id={`${control_id}-thinking`}>默认思考模式</FieldLabel>
        <ToggleGroup
          type="single"
          variant="outline"
          spacing={0}
          value={value.default_thinking_mode}
          onValueChange={(thinking_mode) => {
            if (is_thinking_mode(thinking_mode)) {
              update_preference("default_thinking_mode", thinking_mode);
            }
          }}
          aria-labelledby={`${control_id}-thinking`}
          aria-describedby={`${control_id}-thinking-description`}
          className="w-full flex-wrap sm:w-fit sm:flex-nowrap"
        >
          <ToggleGroupItem className="min-w-24 flex-1" value="auto">
            自动
          </ToggleGroupItem>
          <ToggleGroupItem className="min-w-24 flex-1" value="fast">
            快速
          </ToggleGroupItem>
          <ToggleGroupItem className="min-w-24 flex-1" value="complex">
            复杂
          </ToggleGroupItem>
        </ToggleGroup>
        <FieldDescription id={`${control_id}-thinking-description`}>
          {THINKING_DESCRIPTIONS[value.default_thinking_mode]}
        </FieldDescription>
      </Field>

      <div className="grid gap-6 lg:grid-cols-3">
        <AgentRoleModelSelect
          control_id={`${control_id}-fast-model`}
          label="快速模型"
          description="用于低延迟文本任务。"
          value={value.fast_model_id}
          models={models}
          on_change={(model_id) => update_preference("fast_model_id", model_id)}
        />
        <AgentRoleModelSelect
          control_id={`${control_id}-complex-model`}
          label="复杂模型"
          description="用于深度推理与多步任务。"
          value={value.complex_model_id}
          models={models}
          on_change={(model_id) =>
            update_preference("complex_model_id", model_id)
          }
        />
        <AgentRoleModelSelect
          control_id={`${control_id}-vision-model`}
          label="视觉模型"
          description="用于理解视频画面，每次只调用一个模型。"
          value={value.vision_model_id}
          models={models}
          on_change={(model_id) =>
            update_preference("vision_model_id", model_id)
          }
        />
      </div>

      <Field className="sm:max-w-xs">
        <FieldLabel htmlFor={`${control_id}-concurrency`}>
          最大并行任务数
        </FieldLabel>
        <Input
          id={`${control_id}-concurrency`}
          type="number"
          min={MINIMUM_CONCURRENT_RUNS}
          max={MAXIMUM_CONCURRENT_RUNS}
          value={value.max_concurrent_runs}
          onChange={(event) => {
            const max_concurrent_runs = Number(event.target.value);
            if (
              Number.isInteger(max_concurrent_runs) &&
              max_concurrent_runs >= MINIMUM_CONCURRENT_RUNS &&
              max_concurrent_runs <= MAXIMUM_CONCURRENT_RUNS
            ) {
              update_preference("max_concurrent_runs", max_concurrent_runs);
            }
          }}
        />
        <FieldDescription>
          同时运行 1–32 个任务；默认 4 个可兼顾速度与资源占用。
        </FieldDescription>
      </Field>
    </FieldGroup>
  );
}

function AgentRoleModelSelect({
  control_id,
  label,
  description,
  value,
  models,
  on_change,
}: {
  control_id: string;
  label: string;
  description: string;
  value: string | null;
  models: AiModelConfiguration[];
  on_change: (model_id: string | null) => void;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={control_id}>{label}</FieldLabel>
      <Select
        value={value ?? AUTOMATIC_MODEL_VALUE}
        onValueChange={(model_id) =>
          on_change(model_id === AUTOMATIC_MODEL_VALUE ? null : model_id)
        }
      >
        <SelectTrigger id={control_id} className="w-full">
          <SelectValue placeholder="选择已注册模型" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value={AUTOMATIC_MODEL_VALUE}>
              未指定 · 沿用任务模型
            </SelectItem>
            {models.map((model) => (
              <SelectItem key={model.model_id} value={model.model_id}>
                {model.name}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <FieldDescription>
        {models.length > 0 ? description : "请先在上方注册一个 AI 模型。"}
      </FieldDescription>
    </Field>
  );
}

function is_permission_mode(value: string): value is AgentPermissionMode {
  return (
    value === "request_approval" ||
    value === "smart_approval" ||
    value === "full_access"
  );
}

function is_thinking_mode(value: string): value is AgentThinkingMode {
  return value === "auto" || value === "fast" || value === "complex";
}
