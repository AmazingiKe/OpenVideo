import { Badge } from "@/components/ui/badge";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Slider } from "@/components/ui/slider";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  MARKER_RANGE_MAX_SECONDS,
  MARKER_RANGE_MIN_SECONDS,
  MARKER_RANGE_STEP_SECONDS,
} from "@/shared/marker_ranges";

const QUICK_RANGE_SECONDS = [0, 10, 30, 60] as const;

type MarkerRangeFieldProps = {
  id: string;
  label: string;
  value: number | null;
  default_value: number;
  disabled?: boolean;
  on_change: (value: number | null) => void;
};

export function MarkerRangeField({
  id,
  label,
  value,
  default_value,
  disabled = false,
  on_change,
}: MarkerRangeFieldProps) {
  const inherited = value === null;
  const effective_value = value ?? default_value;

  return (
    <Field data-disabled={disabled || undefined}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <FieldLabel htmlFor={id}>{label}</FieldLabel>
          <FieldDescription>
            {inherited ? "跟随当前分析策略" : "仅覆盖这个标记"}
          </FieldDescription>
        </div>
        <Badge variant={inherited ? "secondary" : "outline"}>
          {inherited ? "默认 · " : ""}
          {effective_value} 秒
        </Badge>
      </div>
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        spacing={0}
        value={inherited ? "default" : "custom"}
        onValueChange={(mode) => {
          if (mode === "default") on_change(null);
          if (mode === "custom") on_change(default_value);
        }}
        disabled={disabled}
        aria-label={`${label}设置方式`}
      >
        <ToggleGroupItem value="default" aria-label={`${label}跟随策略`}>
          跟随策略
        </ToggleGroupItem>
        <ToggleGroupItem value="custom" aria-label={`${label}自定义`}>
          自定义
        </ToggleGroupItem>
      </ToggleGroup>
      <Slider
        id={id}
        aria-label={`${label}秒数`}
        min={MARKER_RANGE_MIN_SECONDS}
        max={MARKER_RANGE_MAX_SECONDS}
        step={MARKER_RANGE_STEP_SECONDS}
        value={[effective_value]}
        disabled={disabled || inherited}
        onValueChange={([next_value]) => on_change(next_value)}
      />
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        className="w-full"
        value={
          QUICK_RANGE_SECONDS.includes(
            effective_value as (typeof QUICK_RANGE_SECONDS)[number],
          )
            ? String(effective_value)
            : ""
        }
        onValueChange={(seconds) => {
          if (seconds) on_change(Number(seconds));
        }}
        disabled={disabled || inherited}
        aria-label={`${label}快捷范围`}
      >
        {QUICK_RANGE_SECONDS.map((seconds) => (
          <ToggleGroupItem
            key={seconds}
            value={String(seconds)}
            className="min-w-0 flex-1"
          >
            {seconds} 秒
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </Field>
  );
}
