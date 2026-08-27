import {
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type Dispatch,
  type SetStateAction,
} from "react";
import { Flag, SlidersHorizontal, Wrench } from "lucide-react";

import { AiModelSelect } from "@/components/AiModelSelect";
import { AgentPanel } from "@/components/AgentPanel";
import { TranscriptionModelDownloadAction } from "@/features/settings/TranscriptionModelDownloadAction";
import {
  Accordion,
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
import { Spinner } from "@/components/ui/spinner";
import { Slider } from "@/components/ui/slider";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { format_duration, format_time } from "@/shared/format";
import { DEFAULT_ANALYSIS_STRATEGY } from "@/shared/analysis";
import {
  MARKER_RANGE_MAX_SECONDS,
  MARKER_RANGE_MIN_SECONDS,
  MARKER_RANGE_STEP_SECONDS,
} from "@/shared/marker_ranges";
import { transcription_runtime_profile } from "@/shared/transcription";
import {
  IMAGE_INPUT_MODALITY,
  type AnalysisJob,
  type AnalysisMode,
  type AnalysisStrategy,
  type AnalysisStrategyPresetDescriptor,
  type AnalysisWeights,
  type AnalysisToolSection,
  type AiModelSummary,
  type MediaAsset,
  type MediaMarker,
  type TranscriptionModelDescriptor,
  type TranscriptionOptions,
} from "@/shared/types";
import { CollapsiblePanelRail } from "./CollapsiblePanelRail";
import { WorkbenchPanelHeader } from "./WorkbenchPanelHeader";

export const ANALYSIS_TOOL_SECTIONS: AnalysisToolSection[] = [
  "video_information",
  "transcription",
  "transcript_correction",
  "analysis",
];

const SOURCE_LABELS: Record<MediaAsset["source_platform"], string> = {
  bilibili: "哔哩哔哩",
  douyin: "抖音",
  youtube: "YouTube",
};

const DEFAULT_ANALYSIS_PRESET: AnalysisStrategyPresetDescriptor = {
  preset: "course_notes",
  name: "课程笔记",
  description: "突出核心概念、结论与可复习的知识结构。",
  strategy: DEFAULT_ANALYSIS_STRATEGY,
};

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

type AnalysisToolPanelProps = {
  asset: MediaAsset | null;
  markers: MediaMarker[];
  has_transcript: boolean;
  is_transcribing: boolean;
  on_start_transcription: (options: TranscriptionOptions) => void;
  transcription_models: TranscriptionModelDescriptor[];
  default_transcription: TranscriptionOptions | null;
  on_transcription_model_change: (model: TranscriptionModelDescriptor) => void;
  is_analyzing: boolean;
  ai_models: AiModelSummary[];
  analysis_strategies?: AnalysisStrategyPresetDescriptor[];
  analysis_strategy: AnalysisStrategy;
  set_analysis_strategy: Dispatch<SetStateAction<AnalysisStrategy>>;
  on_start_analysis: (
    mode: AnalysisMode,
    marker_ids: string[],
    ai_model_id: string | null,
    strategy: AnalysisStrategy,
  ) => void;
  analysis_proposal: AnalysisJob | null;
  on_resolve_analysis: (action: "approve" | "reject") => void;
  selected_transcript_indices: number[];
  on_transcript_changed: () => void;
  open_sections: AnalysisToolSection[];
  on_open_sections_change: (sections: AnalysisToolSection[]) => void;
  collapsed?: boolean;
  on_collapsed_change?: (collapsed: boolean) => void;
};

export function AnalysisToolPanel({
  asset,
  markers,
  has_transcript,
  is_transcribing,
  on_start_transcription,
  transcription_models,
  default_transcription,
  on_transcription_model_change,
  is_analyzing,
  ai_models,
  analysis_strategies = [],
  analysis_strategy,
  set_analysis_strategy,
  on_start_analysis,
  analysis_proposal,
  on_resolve_analysis,
  selected_transcript_indices,
  on_transcript_changed,
  open_sections,
  on_open_sections_change,
  collapsed = false,
  on_collapsed_change,
}: AnalysisToolPanelProps) {
  const [analysis_mode, set_analysis_mode] = useState<AnalysisMode>("full");
  const [advanced_strategy_open, set_advanced_strategy_open] = useState(false);
  const [transcription_options, set_transcription_options] =
    useState<TranscriptionOptions | null>(default_transcription);
  const [selected_marker_ids, set_selected_marker_ids] = useState<Set<string>>(
    new Set(),
  );
  const [correction_scope, set_correction_scope] = useState<
    "all" | "selection"
  >("all");
  const [image_model_id, set_image_model_id] = useState<string | null>(null);
  const image_input_models = useMemo(
    () =>
      ai_models.filter((model) =>
        model.input_modalities.includes(IMAGE_INPUT_MODALITY),
      ),
    [ai_models],
  );
  const resolved_strategy_presets = useMemo(
    () =>
      analysis_strategies.length > 0
        ? analysis_strategies
        : [DEFAULT_ANALYSIS_PRESET],
    [analysis_strategies],
  );
  const strategy_name =
    analysis_strategy.preset === "custom"
      ? "自定义"
      : (resolved_strategy_presets.find(
          (preset) => preset.preset === analysis_strategy.preset,
        )?.name ?? "课程笔记");
  const available_transcription_models = useMemo(
    () =>
      transcription_models.filter(
        (model) => model.integration_status === "available",
      ),
    [transcription_models],
  );
  const selected_transcription_model = useMemo(
    () =>
      transcription_options
        ? transcription_models.find(
            (model) =>
              model.engine === transcription_options.engine &&
              model.model === transcription_options.model,
          )
        : null,
    [transcription_models, transcription_options],
  );

  useEffect(() => {
    set_selected_marker_ids(new Set(markers.map((marker) => marker.marker_id)));
  }, [asset?.asset_id, markers]);

  useEffect(() => {
    set_transcription_options(default_transcription);
  }, [asset?.asset_id, default_transcription]);

  useEffect(() => {
    set_image_model_id((current) =>
      image_input_models.some((model) => model.model_id === current)
        ? current
        : null,
    );
  }, [ai_models, image_input_models]);

  if (collapsed) {
    return (
      <aside
        className="h-full overflow-hidden bg-card"
        data-slot="analysis-tools"
        aria-label="工具面板"
      >
        <CollapsiblePanelRail
          icon={Wrench}
          label="工具"
          edge="right"
          on_expand={() => on_collapsed_change?.(false)}
        />
      </aside>
    );
  }

  function toggle_all_sections() {
    const all_sections_open =
      open_sections.length === ANALYSIS_TOOL_SECTIONS.length;
    on_open_sections_change(
      all_sections_open ? [] : [...ANALYSIS_TOOL_SECTIONS],
    );
  }

  function handle_trigger_click(event: MouseEvent<HTMLButtonElement>) {
    if (!event.shiftKey) return;
    event.preventDefault();
    toggle_all_sections();
  }

  function handle_trigger_key_down(event: KeyboardEvent<HTMLButtonElement>) {
    if (!event.shiftKey || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    toggle_all_sections();
  }

  function handle_sections_change(sections: string[]) {
    const opened_section = sections.find(
      (section) => !open_sections.includes(section as AnalysisToolSection),
    );
    on_open_sections_change(
      opened_section
        ? [opened_section as AnalysisToolSection]
        : (sections as AnalysisToolSection[]),
    );
  }

  return (
    <aside
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden border-l bg-card"
      data-slot="analysis-tools"
      aria-label="工具面板"
    >
      <WorkbenchPanelHeader
        icon={Wrench}
        title="分析工具"
        collapse_label="收起工具面板"
        on_collapse={
          on_collapsed_change ? () => on_collapsed_change(true) : undefined
        }
      />
      <Accordion
        type="multiple"
        value={open_sections}
        onValueChange={handle_sections_change}
        className="min-h-0 overflow-y-auto px-3 pb-3"
      >
        <AccordionItem value="video_information">
          <AccordionTrigger
            onClick={handle_trigger_click}
            onKeyDown={handle_trigger_key_down}
          >
            视频信息
          </AccordionTrigger>
          <AccordionContent>
            <VideoInformation asset={asset} />
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="transcription">
          <AccordionTrigger
            onClick={handle_trigger_click}
            onKeyDown={handle_trigger_key_down}
          >
            转录
          </AccordionTrigger>
          <AccordionContent>
            <div className="flex flex-col items-stretch gap-4">
              <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>状态</span>
                <Badge variant="secondary">
                  {is_transcribing
                    ? "转录中"
                    : has_transcript
                      ? "已完成"
                      : "未开始"}
                </Badge>
              </div>
              <FieldGroup>
                <Field
                  data-disabled={is_transcribing || is_analyzing || undefined}
                >
                  <FieldLabel htmlFor="transcription_model">模型</FieldLabel>
                  <Select
                    value={transcription_options?.model ?? ""}
                    onValueChange={(model_name) => {
                      const model = available_transcription_models.find(
                        (item) => item.model === model_name,
                      );
                      if (!model || !transcription_options) return;
                      const runtime_profile =
                        transcription_runtime_profile(model);
                      set_transcription_options({
                        ...transcription_options,
                        engine: model.engine,
                        model: model.model,
                        device: runtime_profile.recommended_device,
                        compute_type: runtime_profile.recommended_compute_type,
                      });
                    }}
                    disabled={
                      !transcription_options || is_transcribing || is_analyzing
                    }
                  >
                    <SelectTrigger id="transcription_model" className="w-full">
                      <SelectValue placeholder="正在读取默认模型" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {available_transcription_models.map((model) => (
                          <SelectItem key={model.model} value={model.model}>
                            {model.name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  {selected_transcription_model && transcription_options ? (
                    <FieldDescription>
                      {selected_transcription_model.description} 当前使用
                      {transcription_options.language ?? "自动检测"}、
                      {transcription_options.device.toUpperCase()}、
                      {transcription_options.compute_type}。
                    </FieldDescription>
                  ) : null}
                </Field>
              </FieldGroup>
              {selected_transcription_model &&
              selected_transcription_model.installation_status !==
                "installed" ? (
                <TranscriptionModelDownloadAction
                  model={selected_transcription_model}
                  action_label="下载并使用"
                  on_change={on_transcription_model_change}
                  on_complete={() => {
                    if (transcription_options) {
                      on_start_transcription(transcription_options);
                    }
                  }}
                  disabled={!asset || is_transcribing || is_analyzing}
                />
              ) : (
                <Button
                  className="w-full"
                  type="button"
                  onClick={() => {
                    if (transcription_options)
                      on_start_transcription(transcription_options);
                  }}
                  disabled={
                    !asset ||
                    !transcription_options ||
                    is_transcribing ||
                    is_analyzing
                  }
                >
                  {is_transcribing ? (
                    <Spinner data-icon="inline-start" />
                  ) : null}
                  {is_transcribing
                    ? "转录中…"
                    : has_transcript
                      ? "重新转录"
                      : "生成转录"}
                </Button>
              )}
              <FieldDescription>
                {has_transcript
                  ? "重新转录会在成功后替换当前文字；失败时保留现有结果。"
                  : "转录生成可编辑文字，完成后可继续内容分析。"}
              </FieldDescription>
            </div>
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="transcript_correction">
          <AccordionTrigger
            onClick={handle_trigger_click}
            onKeyDown={handle_trigger_key_down}
          >
            修正转录
          </AccordionTrigger>
          <AccordionContent>
            <div className="flex flex-col items-stretch gap-4">
              <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>时间线选择</span>
                <Badge variant="secondary">
                  {selected_transcript_indices.length > 0
                    ? `已选择 ${selected_transcript_indices.length} 条`
                    : "未选择"}
                </Badge>
              </div>
              <ToggleGroup
                type="single"
                value={correction_scope}
                onValueChange={(value) => {
                  if (value === "all" || value === "selection") {
                    set_correction_scope(value);
                  }
                }}
                className="w-full"
                aria-label="字幕纠错范围"
              >
                <ToggleGroupItem value="all" className="flex-1">
                  全部字幕
                </ToggleGroupItem>
                <ToggleGroupItem
                  value="selection"
                  className="flex-1"
                  disabled={selected_transcript_indices.length === 0}
                >
                  时间线选择
                </ToggleGroupItem>
              </ToggleGroup>
              <FieldDescription>
                正常模式一次提交完整转录，仅写回变化项，时间码保持不变。
              </FieldDescription>
              <AgentPanel
                agent_id="transcript_correction"
                asset_id={has_transcript ? (asset?.asset_id ?? null) : null}
                models={ai_models}
                task_input={{
                  segment_indices:
                    correction_scope === "selection"
                      ? selected_transcript_indices
                      : null,
                  execution_mode: "automatic",
                }}
                on_artifact_change={(artifact) => {
                  if (artifact.status === "approved") on_transcript_changed();
                }}
              />
            </div>
          </AccordionContent>
        </AccordionItem>
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
                          (preset) =>
                            preset.preset === analysis_strategy.preset,
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
                data-disabled={
                  is_analyzing || markers.length === 0 || undefined
                }
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
                    {marker_weight_label(
                      analysis_strategy.weights.user_markers,
                    )}{" "}
                    · {analysis_strategy.weights.user_markers}
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
                <SlidersHorizontal
                  data-icon="inline-start"
                  aria-hidden="true"
                />
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
                          <SelectItem value="balanced">
                            均衡 · 约 70%
                          </SelectItem>
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
                        {
                          field: "marker_range_before_seconds",
                          label: "标记前",
                        },
                        {
                          field: "marker_range_after_seconds",
                          label: "标记后",
                        },
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
                        aria-label={`选择 ${format_time(marker.start_seconds)} 标记`}
                      />
                      <time className="font-mono text-primary">
                        {format_time(marker.start_seconds)}
                      </time>
                      <span className="truncate text-muted-foreground">
                        {marker.tags.join(" / ") || "未分类标记"}
                      </span>
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
                  (analysis_mode === "markers" &&
                    selected_marker_ids.size === 0)
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
      </Accordion>
    </aside>
  );
}

function VideoInformation({ asset }: { asset: MediaAsset | null }) {
  if (!asset)
    return <p className="text-xs text-muted-foreground">尚未选择视频。</p>;

  return (
    <dl className="flex flex-col gap-2 text-xs">
      <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-baseline gap-2">
        <dt className="text-muted-foreground">简介</dt>
        <dd className="m-0 min-w-0 leading-relaxed break-words">
          {asset.description || "暂无简介"}
        </dd>
      </div>
      <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-baseline gap-2">
        <dt className="text-muted-foreground">时长</dt>
        <dd className="m-0 min-w-0">
          {format_duration(asset.duration_seconds)}
        </dd>
      </div>
      <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-baseline gap-2">
        <dt className="text-muted-foreground">来源</dt>
        <dd className="m-0 min-w-0">
          <a
            className="text-primary underline-offset-4 hover:underline"
            href={asset.source_url}
            target="_blank"
            rel="noreferrer"
          >
            {SOURCE_LABELS[asset.source_platform]}
          </a>
        </dd>
      </div>
      <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-baseline gap-2">
        <dt className="text-muted-foreground">分辨率</dt>
        <dd className="m-0 min-w-0">{format_resolution(asset)}</dd>
      </div>
      <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-baseline gap-2">
        <dt className="text-muted-foreground">视频编码</dt>
        <dd className="m-0 min-w-0">{asset.video_codec || "待探测"}</dd>
      </div>
      <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-baseline gap-2">
        <dt className="text-muted-foreground">音频编码</dt>
        <dd className="m-0 min-w-0">{asset.audio_codec || "待探测"}</dd>
      </div>
    </dl>
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

function format_resolution(asset: MediaAsset): string {
  return asset.width && asset.height
    ? `${asset.width} × ${asset.height}`
    : "未知";
}
