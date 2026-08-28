import {
  type KeyboardEvent,
  type MouseEvent,
  type Dispatch,
  type SetStateAction,
} from "react";
import { Wrench } from "lucide-react";

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
import { format_duration } from "@/shared/format";
import { transcription_runtime_profile } from "@/shared/transcription";
import {
  type AnalysisJob,
  type AnalysisMode,
  type AnalysisStrategy,
  type AnalysisStrategyPresetDescriptor,
  type AnalysisToolSection,
  type AiModelSummary,
  type MediaAsset,
  type MediaMarker,
  type TranscriptionModelDescriptor,
  type TranscriptionOptions,
} from "@/shared/types";
import { CollapsiblePanelRail } from "./CollapsiblePanelRail";
import { AnalysisConfigurationSection } from "./AnalysisConfigurationSection";
import { WorkbenchPanelHeader } from "./WorkbenchPanelHeader";
import { use_analysis_tool_state } from "./use_analysis_tool_state";

const ANALYSIS_TOOL_SECTIONS: AnalysisToolSection[] = [
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
  const {
    advanced_strategy_open,
    analysis_mode,
    available_transcription_models,
    correction_scope,
    image_input_models,
    image_model_id,
    resolved_strategy_presets,
    selected_marker_ids,
    selected_transcription_model,
    set_advanced_strategy_open,
    set_analysis_mode,
    set_correction_scope,
    set_image_model_id,
    set_selected_marker_ids,
    set_transcription_options,
    strategy_name,
    transcription_options,
  } = use_analysis_tool_state({
    ai_models,
    analysis_strategies,
    analysis_strategy,
    asset_id: asset?.asset_id ?? null,
    default_transcription,
    markers,
    transcription_models,
  });

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
        <AnalysisConfigurationSection
          advanced_strategy_open={advanced_strategy_open}
          analysis_mode={analysis_mode}
          analysis_proposal={analysis_proposal}
          analysis_strategy={analysis_strategy}
          handle_trigger_click={handle_trigger_click}
          handle_trigger_key_down={handle_trigger_key_down}
          has_transcript={has_transcript}
          image_input_models={image_input_models}
          image_model_id={image_model_id}
          is_analyzing={is_analyzing}
          is_transcribing={is_transcribing}
          markers={markers}
          on_resolve_analysis={on_resolve_analysis}
          on_start_analysis={on_start_analysis}
          resolved_strategy_presets={resolved_strategy_presets}
          selected_marker_ids={selected_marker_ids}
          set_advanced_strategy_open={set_advanced_strategy_open}
          set_analysis_mode={set_analysis_mode}
          set_analysis_strategy={set_analysis_strategy}
          set_image_model_id={set_image_model_id}
          set_selected_marker_ids={set_selected_marker_ids}
          strategy_name={strategy_name}
        />
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

function format_resolution(asset: MediaAsset): string {
  return asset.width && asset.height
    ? `${asset.width} × ${asset.height}`
    : "未知";
}
