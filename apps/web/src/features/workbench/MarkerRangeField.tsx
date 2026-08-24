import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Slider } from "@/components/ui/slider";
import {
  MARKER_RANGE_MAX_SECONDS,
  MARKER_RANGE_MIN_SECONDS,
  MARKER_RANGE_STEP_SECONDS,
} from "@/shared/marker_ranges";

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
    <Field>
      <div className="flex items-center justify-between gap-2">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={disabled}
          aria-label={`${label}：${inherited ? "单独设置" : "使用默认"}`}
          onClick={() => on_change(inherited ? default_value : null)}
        >
          {inherited ? "单独设置" : "使用默认"}
        </Button>
      </div>
      <Slider
        id={id}
        aria-label={label}
        min={MARKER_RANGE_MIN_SECONDS}
        max={MARKER_RANGE_MAX_SECONDS}
        step={MARKER_RANGE_STEP_SECONDS}
        value={[effective_value]}
        disabled={disabled || inherited}
        onValueChange={([next_value]) => on_change(next_value)}
      />
      <FieldDescription>
        {inherited
          ? `使用默认（当前 ${default_value} 秒）`
          : `${effective_value} 秒`}
      </FieldDescription>
    </Field>
  );
}
