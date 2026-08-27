import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import type { AiModelSummary } from "@/shared/types";

const NO_AI_MODEL_VALUE = "no-ai-model";

type AiModelSelectProps = {
  id: string;
  label: string;
  models: AiModelSummary[];
  value: string | null;
  on_change: (model_id: string | null) => void;
  allow_without_model?: boolean;
  disabled?: boolean;
  description?: string;
};

export function AiModelSelect({
  id,
  label,
  models,
  value,
  on_change,
  allow_without_model = false,
  disabled = false,
  description,
}: AiModelSelectProps) {
  const has_options = models.length > 0 || allow_without_model;
  return (
    <Field data-disabled={disabled || !has_options || undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select
        value={value ?? (allow_without_model ? NO_AI_MODEL_VALUE : "")}
        onValueChange={(next_value) =>
          on_change(next_value === NO_AI_MODEL_VALUE ? null : next_value)
        }
        disabled={disabled || !has_options}
      >
        <SelectTrigger id={id} className="w-full min-w-0">
          <SelectValue placeholder="没有可用模型" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {allow_without_model ? (
              <SelectItem value={NO_AI_MODEL_VALUE}>不使用 AI 模型</SelectItem>
            ) : null}
            {models.map((model) => (
              <SelectItem key={model.model_id} value={model.model_id}>
                {model.name} · {model.litellm_model}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {description ? <FieldDescription>{description}</FieldDescription> : null}
    </Field>
  );
}
