import { Flag, ScanSearch, SlidersHorizontal } from "lucide-react";
import {
  useEffect,
  useState,
  type Dispatch,
  type KeyboardEventHandler,
  type MouseEventHandler,
  type SetStateAction,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { format_time } from "@/shared/format";
import { format_marker_label } from "@/shared/marker_labels";
import type {
  AiModelSummary,
  AnalysisDepth,
  AnalysisJob,
  AnalysisStrategy,
  AnalysisStrategyPresetDescriptor,
  EventAnalysisJob,
  FocusSelection,
  MediaMarker,
} from "@/shared/types";

type EventTargetMode = "markers" | "focus_selection";

type AnalysisConfigurationSectionProps = {
  advanced_strategy_open: boolean;
  analysis_proposal: AnalysisJob | null;
  analysis_strategy: AnalysisStrategy;
  event_analysis_job: EventAnalysisJob | null;
  focus_selection: FocusSelection | null;
  handle_trigger_click: MouseEventHandler<HTMLButtonElement>;
  handle_trigger_key_down: KeyboardEventHandler<HTMLButtonElement>;
  has_transcript: boolean;
  models: AiModelSummary[];
  image_input_models: AiModelSummary[];
  image_model_id: string | null;
  is_analyzing: boolean;
  is_transcribing: boolean;
  markers: MediaMarker[];
  on_resolve_analysis: (action: "approve" | "reject") => void;
  on_start_analysis: (
    ai_model_id: string | null,
    strategy: AnalysisStrategy,
  ) => void;
  on_start_event_analysis: (request: {
    marker_ids: string[];
    use_focus_selection: boolean;
    preset_id: string;
    preset_version: number;
    depth: AnalysisDepth;
    user_input: string | null;
    ai_model_id: string;
  }) => void;
  resolved_strategy_presets: AnalysisStrategyPresetDescriptor[];
  selected_marker_ids: Set<string>;
  set_advanced_strategy_open: Dispatch<SetStateAction<boolean>>;
  set_analysis_strategy: Dispatch<SetStateAction<AnalysisStrategy>>;
  set_image_model_id: Dispatch<SetStateAction<string | null>>;
  set_selected_marker_ids: Dispatch<SetStateAction<Set<string>>>;
  strategy_name: string;
};

export function AnalysisConfigurationSection({
  advanced_strategy_open,
  analysis_proposal,
  analysis_strategy,
  event_analysis_job,
  focus_selection,
  handle_trigger_click,
  handle_trigger_key_down,
  has_transcript,
  models,
  image_input_models,
  image_model_id,
  is_analyzing,
  is_transcribing,
  markers,
  on_resolve_analysis,
  on_start_analysis,
  on_start_event_analysis,
  resolved_strategy_presets,
  selected_marker_ids,
  set_advanced_strategy_open,
  set_analysis_strategy,
  set_image_model_id,
  set_selected_marker_ids,
  strategy_name,
}: AnalysisConfigurationSectionProps) {
  const [event_target, set_event_target] = useState<EventTargetMode>("markers");
  const [event_model_id, set_event_model_id] = useState<string | null>(null);
  const [event_preset_id, set_event_preset_id] = useState<string>(
    resolved_strategy_presets[0]?.preset ?? "course_notes",
  );
  const [event_depth, set_event_depth] = useState<AnalysisDepth>("balanced");
  const [event_user_input, set_event_user_input] = useState("");
  const range_markers = markers.filter((marker) => marker.end_seconds !== null);
  const selected_range_marker_ids = range_markers
    .filter((marker) => selected_marker_ids.has(marker.marker_id))
    .map((marker) => marker.marker_id);
  const focus_complete =
    focus_selection?.in_seconds !== null &&
    focus_selection?.out_seconds !== null;
  const focus_in_seconds = focus_selection?.in_seconds ?? null;
  const focus_out_seconds = focus_selection?.out_seconds ?? null;
  const event_running =
    event_analysis_job?.stage === "pending" ||
    event_analysis_job?.stage === "running";

  useEffect(() => {
    set_event_model_id((current) => current ?? models[0]?.model_id ?? null);
  }, [models]);

  return (
    <AccordionItem value="analysis">
      <AccordionTrigger
        onClick={handle_trigger_click}
        onKeyDown={handle_trigger_key_down}
      >
        分析
      </AccordionTrigger>
      <AccordionContent>
        <Tabs defaultValue="full" className="gap-4">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="full">全片分析</TabsTrigger>
            <TabsTrigger value="event">事件分析</TabsTrigger>
          </TabsList>
          <TabsContent value="full" className="grid gap-4">
            <Field>
              <FieldLabel htmlFor="analysis_strategy">分析策略</FieldLabel>
              <Select
                value={analysis_strategy.preset}
                onValueChange={(preset_id) => {
                  const preset = resolved_strategy_presets.find(
                    (item) => item.preset === preset_id,
                  );
                  if (preset)
                    set_analysis_strategy(structuredClone(preset.strategy));
                }}
                disabled={is_analyzing}
              >
                <SelectTrigger id="analysis_strategy" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {analysis_strategy.preset === "custom" ? (
                      <SelectItem value="custom">{strategy_name}</SelectItem>
                    ) : null}
                    {resolved_strategy_presets.map((preset) => (
                      <SelectItem key={preset.preset} value={preset.preset}>
                        {preset.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Button
              type="button"
              variant="ghost"
              className="justify-start"
              aria-expanded={advanced_strategy_open}
              onClick={() => set_advanced_strategy_open((open) => !open)}
            >
              <SlidersHorizontal data-icon="inline-start" aria-hidden="true" />
              高级设置
            </Button>
            {advanced_strategy_open ? (
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="analysis_depth">分析深度</FieldLabel>
                  <Select
                    value={analysis_strategy.depth}
                    onValueChange={(depth) =>
                      set_analysis_strategy((current) => ({
                        ...current,
                        depth: depth as AnalysisDepth,
                      }))
                    }
                  >
                    <SelectTrigger id="analysis_depth" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="quick">快速</SelectItem>
                      <SelectItem value="balanced">均衡</SelectItem>
                      <SelectItem value="deep">深入</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <div className="flex justify-between gap-2">
                    <FieldLabel htmlFor="marker_weight">标记优先级</FieldLabel>
                    <output className="text-xs text-muted-foreground">
                      {analysis_strategy.weights.user_markers}
                    </output>
                  </div>
                  <Slider
                    id="marker_weight"
                    aria-label="标记优先级"
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
                  />
                </Field>
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
              description="不使用模型时仍生成音频时间线与关键帧。"
            />
            <Button
              className="w-full"
              type="button"
              onClick={() =>
                on_start_analysis(image_model_id, analysis_strategy)
              }
              disabled={!has_transcript || is_transcribing || is_analyzing}
            >
              {is_analyzing ? <Spinner data-icon="inline-start" /> : null}
              {is_analyzing
                ? `正在按${strategy_name}分析…`
                : `按${strategy_name}分析全片`}
            </Button>
            {analysis_proposal ? (
              <Card aria-label="全片分析替换预览">
                <CardHeader>
                  <CardTitle>全片分析替换预览</CardTitle>
                  <CardDescription>
                    确认后整体替换机器分析结果，正式标记与事件分析保留。
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <ol className="grid max-h-48 gap-2 overflow-y-auto">
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
                    variant="outline"
                    onClick={() => on_resolve_analysis("reject")}
                  >
                    拒绝替换
                  </Button>
                  <Button onClick={() => on_resolve_analysis("approve")}>
                    接受替换
                  </Button>
                </CardFooter>
              </Card>
            ) : null}
          </TabsContent>
          <TabsContent value="event" className="grid gap-4">
            <Select
              value={event_target}
              onValueChange={(value) =>
                set_event_target(value as EventTargetMode)
              }
            >
              <SelectTrigger className="w-full" aria-label="事件分析目标">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="markers">所选范围标记</SelectItem>
                <SelectItem value="focus_selection">当前焦点选区</SelectItem>
              </SelectContent>
            </Select>
            {event_target === "markers" ? (
              <div className="grid max-h-40 gap-1 overflow-y-auto">
                {range_markers.length === 0 ? (
                  <FieldDescription>
                    先在时间线上创建范围标记。
                  </FieldDescription>
                ) : (
                  range_markers.map((marker) => (
                    <label
                      key={marker.marker_id}
                      className="flex min-h-8 items-center gap-2 rounded-lg border px-2 py-1 text-xs"
                    >
                      <Checkbox
                        checked={selected_marker_ids.has(marker.marker_id)}
                        onCheckedChange={() =>
                          set_selected_marker_ids((current) =>
                            toggle_marker(current, marker.marker_id),
                          )
                        }
                      />
                      <Flag className="size-3" aria-hidden="true" />
                      {format_marker_label(marker)}
                    </label>
                  ))
                )}
              </div>
            ) : (
              <div className="rounded-lg border bg-muted p-3 text-xs">
                {focus_complete
                  ? `${format_time(focus_in_seconds!)}–${format_time(focus_out_seconds!)}`
                  : "需要同时设置 In 与 Out，且 In 早于 Out。"}
              </div>
            )}
            <Field>
              <FieldLabel htmlFor="event_preset">分析预设</FieldLabel>
              <Select
                value={event_preset_id}
                onValueChange={set_event_preset_id}
              >
                <SelectTrigger id="event_preset" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {resolved_strategy_presets.map((preset) => (
                    <SelectItem key={preset.preset} value={preset.preset}>
                      {preset.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="event_depth">分析深度</FieldLabel>
              <Select
                value={event_depth}
                onValueChange={(value) =>
                  set_event_depth(value as AnalysisDepth)
                }
              >
                <SelectTrigger id="event_depth" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="quick">快速</SelectItem>
                  <SelectItem value="balanced">均衡</SelectItem>
                  <SelectItem value="deep">深入</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <AiModelSelect
              id="event-analysis-model"
              label="分析模型"
              models={models}
              value={event_model_id}
              on_change={set_event_model_id}
              disabled={event_running}
            />
            <Field>
              <FieldLabel htmlFor="event_user_input">补充要求</FieldLabel>
              <Textarea
                id="event_user_input"
                value={event_user_input}
                onChange={(event) => set_event_user_input(event.target.value)}
                placeholder="例如：重点解释操作失败的原因"
                disabled={event_running}
              />
            </Field>
            {event_analysis_job ? (
              <div
                className="flex items-center justify-between gap-2 text-xs text-muted-foreground"
                role="status"
              >
                <span>{event_analysis_job.message}</span>
                <Badge variant="secondary">
                  {Math.round(event_analysis_job.progress_percent)}%
                </Badge>
              </div>
            ) : null}
            <Button
              className="w-full"
              type="button"
              disabled={
                !has_transcript ||
                event_running ||
                !event_model_id ||
                (event_target === "markers" &&
                  selected_range_marker_ids.length === 0) ||
                (event_target === "focus_selection" && !focus_complete)
              }
              onClick={() => {
                if (!event_model_id) return;
                on_start_event_analysis({
                  marker_ids:
                    event_target === "markers" ? selected_range_marker_ids : [],
                  use_focus_selection: event_target === "focus_selection",
                  preset_id: event_preset_id,
                  preset_version: 1,
                  depth: event_depth,
                  user_input: event_user_input.trim() || null,
                  ai_model_id: event_model_id,
                });
              }}
            >
              {event_running ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <ScanSearch data-icon="inline-start" />
              )}
              {event_running ? "正在分析事件…" : "生成事件分析"}
            </Button>
          </TabsContent>
        </Tabs>
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
