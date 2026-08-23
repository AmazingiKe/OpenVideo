import {
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { Sparkles, Wrench } from "lucide-react";

import { AiModelSelect } from "@/components/AiModelSelect";
import { TranscriptionModelDownloadAction } from "@/features/settings/TranscriptionModelDownloadAction";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { format_duration, format_time } from "@/shared/format";
import { transcription_runtime_profile } from "@/shared/transcription";
import {
  IMAGE_INPUT_MODALITY,
  type AgentJob,
  type AgentQuestionAction,
  type AnalysisMode,
  type AnalysisToolSection,
  type AiModelSummary,
  type MediaAsset,
  type MediaMarker,
  type TranscriptCorrectionScope,
  type TranscriptionModelDescriptor,
  type TranscriptionOptions,
} from "@/shared/types";
import { CollapsiblePanelRail } from "./CollapsiblePanelRail";
import { WorkbenchPanelHeader } from "./WorkbenchPanelHeader";
import { TranscriptCorrectionAgentStatus } from "./TranscriptCorrectionAgentStatus";

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
  on_start_analysis: (
    mode: AnalysisMode,
    marker_ids: string[],
    ai_model_id: string | null,
  ) => void;
  selected_transcript_count: number;
  active_correction_scope: TranscriptCorrectionScope | null;
  correction_agent_job: AgentJob | null;
  on_start_correction_agent: (
    scope: TranscriptCorrectionScope,
    ai_model_id: string,
  ) => void;
  on_agent_response: (
    action: AgentQuestionAction,
    ai_model_id?: string | null,
  ) => void;
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
  on_start_analysis,
  selected_transcript_count,
  active_correction_scope,
  correction_agent_job,
  on_start_correction_agent,
  on_agent_response,
  open_sections,
  on_open_sections_change,
  collapsed = false,
  on_collapsed_change,
}: AnalysisToolPanelProps) {
  const [analysis_mode, set_analysis_mode] = useState<AnalysisMode>("full");
  const [transcription_options, set_transcription_options] =
    useState<TranscriptionOptions | null>(default_transcription);
  const [selected_marker_ids, set_selected_marker_ids] = useState<Set<string>>(
    new Set(),
  );
  const [correction_model_id, set_correction_model_id] = useState<
    string | null
  >(null);
  const [image_model_id, set_image_model_id] = useState<string | null>(null);
  const image_input_models = useMemo(
    () =>
      ai_models.filter((model) =>
        model.input_modalities.includes(IMAGE_INPUT_MODALITY),
      ),
    [ai_models],
  );
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
    set_correction_model_id((current) =>
      ai_models.some((model) => model.model_id === current)
        ? current
        : (ai_models[0]?.model_id ?? null),
    );
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
          expand_direction="left"
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

  return (
    <aside
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden border-l bg-card"
      data-slot="analysis-tools"
      aria-label="工具面板"
    >
      <WorkbenchPanelHeader
        icon={Wrench}
        title="分析工具"
        collapse_direction="right"
        collapse_label="收起工具面板"
        on_collapse={
          on_collapsed_change ? () => on_collapsed_change(true) : undefined
        }
      />
      <Accordion
        type="multiple"
        value={open_sections}
        onValueChange={(sections) =>
          on_open_sections_change(sections as AnalysisToolSection[])
        }
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
                  data-disabled={
                    is_transcribing ||
                    is_analyzing ||
                    has_transcript ||
                    undefined
                  }
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
                      !transcription_options ||
                      is_transcribing ||
                      is_analyzing ||
                      has_transcript
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
                  disabled={
                    !asset || is_transcribing || is_analyzing || has_transcript
                  }
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
                    is_analyzing ||
                    has_transcript
                  }
                >
                  {is_transcribing ? (
                    <Spinner data-icon="inline-start" />
                  ) : null}
                  {is_transcribing
                    ? "转录中…"
                    : has_transcript
                      ? "转录已完成"
                      : "生成转录"}
                </Button>
              )}
              <FieldDescription>
                转录生成可编辑文字，完成后可继续内容分析。
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
                  {selected_transcript_count > 0
                    ? `已选择 ${selected_transcript_count} 条`
                    : "未选择"}
                </Badge>
              </div>
              <AiModelSelect
                id="transcript-correction-model"
                label="执行模型"
                models={ai_models}
                value={correction_model_id}
                on_change={set_correction_model_id}
                disabled={active_correction_scope !== null}
                description="可在设置中添加 OpenAI、Anthropic、Gemini、Ollama 等模型。"
              />
              <Button
                className="w-full"
                type="button"
                onClick={() => {
                  if (correction_model_id)
                    on_start_correction_agent("all", correction_model_id);
                }}
                disabled={
                  !has_transcript ||
                  !correction_model_id ||
                  is_transcribing ||
                  is_analyzing ||
                  active_correction_scope !== null
                }
              >
                {active_correction_scope === "all" ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <Sparkles data-icon="inline-start" aria-hidden="true" />
                )}
                {active_correction_scope === "all"
                  ? "正在修正全部…"
                  : "自动全部修正"}
              </Button>
              <Button
                className="w-full"
                type="button"
                variant="outline"
                onClick={() => {
                  if (correction_model_id)
                    on_start_correction_agent("selection", correction_model_id);
                }}
                disabled={
                  !has_transcript ||
                  !correction_model_id ||
                  selected_transcript_count === 0 ||
                  is_transcribing ||
                  is_analyzing ||
                  active_correction_scope !== null
                }
              >
                {active_correction_scope === "selection" ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <Sparkles data-icon="inline-start" aria-hidden="true" />
                )}
                {active_correction_scope === "selection"
                  ? "正在修正选择…"
                  : "选择修正"}
              </Button>
              <FieldDescription>
                正常模式一次提交完整转录，仅写回变化项，时间码保持不变。
              </FieldDescription>
              {correction_agent_job ? (
                <TranscriptCorrectionAgentStatus
                  job={correction_agent_job}
                  models={ai_models}
                  replacement_model_id={correction_model_id}
                  on_replacement_model_change={set_correction_model_id}
                  on_response={on_agent_response}
                />
              ) : null}
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
                        aria-label={`选择 ${format_time(marker.time_seconds)} 标记`}
                      />
                      <time className="font-mono text-primary">
                        {format_time(marker.time_seconds)}
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
                  ? "分析中…"
                  : analysis_mode === "full"
                    ? "分析全片"
                    : `分析 ${selected_marker_ids.size} 个标记`}
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

function format_resolution(asset: MediaAsset): string {
  return asset.width && asset.height
    ? `${asset.width} × ${asset.height}`
    : "未知";
}
