import { Flag, SlidersHorizontal } from "lucide-react";
import type {
  Dispatch,
  KeyboardEventHandler,
  MouseEventHandler,
  SetStateAction,
} from "react";

import { AiModelSelect } from "@/components/AiModelSelect";
import {
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
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
import { Checkbox } from "@/components/ui/checkbox";
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
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { format_time } from "@/shared/format";
import { format_marker_label } from "@/shared/marker_labels";
import {
  MARKER_RANGE_MAX_SECONDS,
  MARKER_RANGE_MIN_SECONDS,
  MARKER_RANGE_STEP_SECONDS,
} from "@/shared/marker_ranges";
import type {
  AiModelSummary,
  AnalysisJob,
  AnalysisMode,
  AnalysisStrategy,
  AnalysisStrategyPresetDescriptor,
  AnalysisWeights,
  MediaMarker,
} from "@/shared/types";

const CONTENT_WEIGHT_FIELDS: {
  field: keyof AnalysisWeights;
  label: string;
}[] = [
  { field: "core_concepts", label: "核心概念" },
  { field: "formula_derivation", label: "公式推导" },
  { field: "case_demonstration", label: "案例演示" },
  { field: "questions_conclusions", label: "疑问结论" },
  { field: "visual_content", label: "视觉内容" },
];

const ANALYSIS_WEIGHT_FIELDS = [
  ...CONTENT_WEIGHT_FIELDS,
  { field: "user_markers" as const, label: "用户标记" },
];

const MARKER_WEIGHT_PRESETS = [
  { value: 25, label: "较低" },
  { value: 50, label: "均衡" },
  { value: 75, label: "较高" },
  { value: 100, label: "最高" },
] as const;

type AnalysisConfigurationSectionProps = {
  advanced_strategy_open: boolean;
  analysis_mode: AnalysisMode;
  analysis_proposal: AnalysisJob | null;
  analysis_strategy: AnalysisStrategy;
  handle_trigger_click: MouseEventHandler<HTMLButtonElement>;
  handle_trigger_key_down: KeyboardEventHandler<HTMLButtonElement>;
  has_transcript: boolean;
  image_input_models: AiModelSummary[];
  image_model_id: string | null;
  is_analyzing: boolean;
  is_transcribing: boolean;
  markers: MediaMarker[];
  on_resolve_analysis: (action: "approve" | "reject") => void;
  on_start_analysis: (
    mode: AnalysisMode,
    marker_ids: string[],
    ai_model_id: string | null,
    strategy: AnalysisStrategy,
  ) => void;
  resolved_strategy_presets: AnalysisStrategyPresetDescriptor[];
  selected_marker_ids: Set<string>;
  set_advanced_strategy_open: Dispatch<SetStateAction<boolean>>;
  set_analysis_mode: Dispatch<SetStateAction<AnalysisMode>>;
  set_analysis_strategy: Dispatch<SetStateAction<AnalysisStrategy>>;
  set_image_model_id: Dispatch<SetStateAction<string | null>>;
  set_selected_marker_ids: Dispatch<SetStateAction<Set<string>>>;
  strategy_name: string;
};

export function AnalysisConfigurationSection({
  advanced_strategy_open,
  analysis_mode,
  analysis_proposal,
  analysis_strategy,
  handle_trigger_click,
  handle_trigger_key_down,
  has_transcript,
  image_input_models,
  image_model_id,
  is_analyzing,
  is_transcribing,
  markers,
  on_resolve_analysis,
  on_start_analysis,
  resolved_strategy_presets,
  selected_marker_ids,
  set_advanced_strategy_open,
  set_analysis_mode,
  set_analysis_strategy,
  set_image_model_id,
  set_selected_marker_ids,
  strategy_name,
}: AnalysisConfigurationSectionProps) {
  return (
    <AccordionItem value="analysis">
      <AccordionTrigger
        onClick={handle_trigger_click}
        onKeyDown={handle_trigger_key_down}
      >
        分析
      </AccordionTrigger>
      <AccordionContent>
        <div className="flex flex-col items-stretch gap-4">
          <ToggleGroup
            type="single"
            variant="outline"
            value={analysis_mode}
            onValueChange={(value) => {
              if (value) set_analysis_mode(value as AnalysisMode);
            }}
            aria-label="分析范围"
          >
            <ToggleGroupItem value="full" disabled={!has_transcript}>
              全片
            </ToggleGroupItem>
            <ToggleGroupItem
              value="markers"
              disabled={!has_transcript || markers.length === 0}
            >
              标记
            </ToggleGroupItem>
          </ToggleGroup>
          <FieldGroup>
            <Field data-disabled={is_analyzing || undefined}>
              <FieldLabel htmlFor="analysis_strategy">分析策略</FieldLabel>
              <Select
                value={analysis_strategy.preset}
                onValueChange={(preset_name) => {
                  const preset = resolved_strategy_presets.find(
                    (item) => item.preset === preset_name,
                  );
                  if (preset) {
                    set_analysis_strategy(structuredClone(preset.strategy));
                  }
                }}
                disabled={is_analyzing}
              >
                <SelectTrigger id="analysis_strategy" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {resolved_strategy_presets.map((preset) => (
                      <SelectItem key={preset.preset} value={preset.preset}>
                        {preset.name}
                      </SelectItem>
                    ))}
                    {analysis_strategy.preset === "custom" ? (
                      <SelectItem value="custom">自定义</SelectItem>
                    ) : null}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription>
                {analysis_strategy.preset === "custom"
                  ? "按当前自定义权重决定重点片段与分析详细度。"
                  : resolved_strategy_presets.find(
                      (preset) => preset.preset === analysis_strategy.preset,
                    )?.description}
              </FieldDescription>
            </Field>
          </FieldGroup>
          <div className="flex flex-wrap gap-1" aria-label="策略权重摘要">
            {ANALYSIS_WEIGHT_FIELDS.filter(
              ({ field }) => analysis_strategy.weights[field] >= 80,
            ).map(({ field, label }) => (
              <Badge key={field} variant="secondary">
                {label} {analysis_strategy.weights[field]}
              </Badge>
            ))}
          </div>
          <Field
            className="rounded-lg border bg-surface-muted p-3"
            data-disabled={is_analyzing || markers.length === 0 || undefined}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 gap-2">
                <Flag
                  className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                  aria-hidden
                />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <FieldLabel htmlFor="analysis_weight_user_markers">
                    标记优先级
                  </FieldLabel>
                  <FieldDescription>
                    {markers.length === 0
                      ? "添加标记后可调整"
                      : "控制标记片段相对其他内容的重要程度"}
                  </FieldDescription>
                </div>
              </div>
              <Badge variant="secondary">
                {marker_weight_label(analysis_strategy.weights.user_markers)} ·{" "}
                {analysis_strategy.weights.user_markers}
              </Badge>
            </div>
            <Slider
              id="analysis_weight_user_markers"
              min={0}
              max={100}
              step={5}
              value={[analysis_strategy.weights.user_markers]}
              onValueChange={([value]) =>
                set_analysis_strategy((current) => ({
                  ...current,
                  preset: "custom",
                  weights: {
                    ...current.weights,
                    user_markers: value ?? current.weights.user_markers,
                  },
                }))
              }
              disabled={is_analyzing || markers.length === 0}
              aria-label="标记优先级"
            />
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              className="w-full"
              value={String(analysis_strategy.weights.user_markers)}
              onValueChange={(value) => {
                if (!value) return;
                set_analysis_strategy((current) => ({
                  ...current,
                  preset: "custom",
                  weights: {
                    ...current.weights,
                    user_markers: Number(value),
                  },
                }));
              }}
              disabled={is_analyzing || markers.length === 0}
              aria-label="标记优先级快捷设置"
            >
              {MARKER_WEIGHT_PRESETS.map((preset) => (
                <ToggleGroupItem
                  key={preset.value}
                  value={String(preset.value)}
                  className="min-w-0 flex-1"
                >
                  {preset.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Field>
          <Button
            type="button"
            variant="ghost"
            className="justify-start"
            aria-expanded={advanced_strategy_open}
            onClick={() => set_advanced_strategy_open((open) => !open)}
            disabled={is_analyzing}
          >
            <SlidersHorizontal data-icon="inline-start" aria-hidden="true" />
            高级设置
          </Button>
          {analysis_proposal ? (
            <Card aria-label="分析替换预览">
              <CardHeader>
                <CardTitle>分析替换预览</CardTitle>
                <CardDescription>
                  {analysis_proposal.mode === "full"
                    ? "确认后整体替换机器分析结果，人工标记及引用会保留。"
                    : "确认后只替换所选人工标记的精确时间范围。"}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ol className="flex max-h-48 flex-col gap-2 overflow-y-auto">
                  {analysis_proposal.proposed_segments.map((segment) => (
                    <li
                      key={segment.segment_id}
                      className="rounded-md border p-2 text-xs"
                    >
                      <p className="font-medium">{segment.title}</p>
                      <p className="text-muted-foreground">
                        {format_time(segment.start_seconds)}–
                        {format_time(segment.end_seconds)}
                      </p>
                    </li>
                  ))}
                </ol>
              </CardContent>
              <CardFooter className="justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => on_resolve_analysis("reject")}
                >
                  拒绝替换
                </Button>
                <Button
                  type="button"
                  onClick={() => on_resolve_analysis("approve")}
                >
                  接受替换
                </Button>
              </CardFooter>
            </Card>
          ) : null}
          {advanced_strategy_open ? (
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="analysis_depth">分析深度</FieldLabel>
                <Select
                  value={analysis_strategy.depth}
                  onValueChange={(depth) =>
                    set_analysis_strategy((current) => ({
                      ...current,
                      depth: depth as AnalysisStrategy["depth"],
                    }))
                  }
                  disabled={is_analyzing}
                >
                  <SelectTrigger id="analysis_depth" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="quick">快速 · 约 40%</SelectItem>
                      <SelectItem value="balanced">均衡 · 约 70%</SelectItem>
                      <SelectItem value="deep">深入 · 100%</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              {CONTENT_WEIGHT_FIELDS.map(({ field, label }) => (
                <Field key={field}>
                  <div className="flex items-center justify-between gap-2">
                    <FieldLabel htmlFor={`analysis_weight_${field}`}>
                      {label}
                    </FieldLabel>
                    <output
                      className="text-xs text-muted-foreground tabular-nums"
                      htmlFor={`analysis_weight_${field}`}
                    >
                      {analysis_strategy.weights[field]}
                    </output>
                  </div>
                  <Slider
                    id={`analysis_weight_${field}`}
                    min={0}
                    max={100}
                    step={5}
                    value={[analysis_strategy.weights[field]]}
                    onValueChange={([value]) =>
                      set_analysis_strategy((current) => ({
                        ...current,
                        preset: "custom",
                        weights: {
                          ...current.weights,
                          [field]: value ?? current.weights[field],
                        },
                      }))
                    }
                    disabled={is_analyzing}
                    aria-label={`${label}权重`}
                  />
                </Field>
              ))}
              <FieldGroup className="gap-4">
                <FieldDescription>标记影响范围</FieldDescription>
                {(
                  [
                    { field: "marker_range_before_seconds", label: "标记前" },
                    { field: "marker_range_after_seconds", label: "标记后" },
                  ] as const
                ).map(({ field, label }) => (
                  <Field key={field}>
                    <div className="flex items-center justify-between gap-2">
                      <FieldLabel htmlFor={field}>{label}</FieldLabel>
                      <output
                        className="text-xs text-muted-foreground tabular-nums"
                        htmlFor={field}
                      >
                        {analysis_strategy[field]} 秒
                      </output>
                    </div>
                    <Slider
                      id={field}
                      min={MARKER_RANGE_MIN_SECONDS}
                      max={MARKER_RANGE_MAX_SECONDS}
                      step={MARKER_RANGE_STEP_SECONDS}
                      value={[analysis_strategy[field]]}
                      onValueChange={([value]) =>
                        set_analysis_strategy((current) => ({
                          ...current,
                          [field]: value ?? current[field],
                        }))
                      }
                      disabled={is_analyzing}
                      aria-label={`${label}范围秒数`}
                    />
                  </Field>
                ))}
                <FieldDescription>
                  标记本身优先级最高，超出标记的内容向两侧边缘逐渐减弱。
                </FieldDescription>
              </FieldGroup>
            </FieldGroup>
          ) : null}
          <AiModelSelect
            id="image-analysis-model"
            label="图片分析模型"
            models={image_input_models}
            value={image_model_id}
            on_change={set_image_model_id}
            allow_without_model
            disabled={is_analyzing}
            description="不使用模型时仍会生成音频时间轴与关键帧。"
          />
          {analysis_mode === "markers" ? (
            <div className="grid max-h-32 gap-1 overflow-y-auto">
              {markers.map((marker) => (
                <label
                  className="flex min-h-8 items-center gap-2 rounded-lg border bg-background px-2 py-1 text-xs"
                  key={marker.marker_id}
                >
                  <Checkbox
                    checked={selected_marker_ids.has(marker.marker_id)}
                    onCheckedChange={() =>
                      set_selected_marker_ids((current) =>
                        toggle_marker(current, marker.marker_id),
                      )
                    }
                    aria-label={`选择 ${format_marker_label(marker)} 标记`}
                  />
                  <time className="font-mono text-primary">
                    {format_marker_label(marker)}
                  </time>
                </label>
              ))}
            </div>
          ) : null}
          <Button
            className="w-full"
            type="button"
            onClick={() =>
              on_start_analysis(
                analysis_mode,
                [...selected_marker_ids],
                image_model_id,
                analysis_strategy,
              )
            }
            disabled={
              !has_transcript ||
              is_transcribing ||
              is_analyzing ||
              (analysis_mode === "markers" && selected_marker_ids.size === 0)
            }
          >
            {is_analyzing ? <Spinner data-icon="inline-start" /> : null}
            {is_analyzing
              ? `正在按${strategy_name}分析…`
              : analysis_mode === "full"
                ? `按${strategy_name}分析全片`
                : `按${strategy_name}分析 ${selected_marker_ids.size} 个标记`}
          </Button>
        </div>
      </AccordionContent>
    </AccordionItem>
  );
}

function toggle_marker(current: Set<string>, marker_id: string): Set<string> {
  const next = new Set(current);
  if (next.has(marker_id)) next.delete(marker_id);
  else next.add(marker_id);
  return next;
}

function marker_weight_label(weight: number): string {
  if (weight === 0) return "忽略";
  if (weight < 40) return "较低";
  if (weight < 70) return "均衡";
  if (weight < 100) return "较高";
  return "最高";
}
