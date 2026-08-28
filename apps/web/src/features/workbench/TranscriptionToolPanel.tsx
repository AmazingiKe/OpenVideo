import { type KeyboardEvent, type MouseEvent } from "react";
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
import { transcription_runtime_profile } from "@/shared/transcription";
import {
  type AiModelSummary,
  type MediaAsset,
  type ToolPanelSection,
  type TranscriptionModelDescriptor,
  type TranscriptionOptions,
} from "@/shared/types";
import { CollapsiblePanelRail } from "./CollapsiblePanelRail";
import { WorkbenchPanelHeader } from "./WorkbenchPanelHeader";
import { use_transcription_tool_state } from "./use_transcription_tool_state";

const TOOL_PANEL_SECTIONS: ToolPanelSection[] = [
  "transcription",
  "transcript_correction",
];

type TranscriptionToolPanelProps = {
  asset: MediaAsset | null;
  has_transcript: boolean;
  is_transcribing: boolean;
  on_start_transcription: (options: TranscriptionOptions) => void;
  transcription_models: TranscriptionModelDescriptor[];
  default_transcription: TranscriptionOptions | null;
  on_transcription_model_change: (model: TranscriptionModelDescriptor) => void;
  ai_models: AiModelSummary[];
  selected_transcript_indices: number[];
  on_transcript_changed: () => void;
  open_sections: ToolPanelSection[];
  on_open_sections_change: (sections: ToolPanelSection[]) => void;
  collapsed?: boolean;
  on_collapsed_change?: (collapsed: boolean) => void;
};

export function TranscriptionToolPanel({
  asset,
  has_transcript,
  is_transcribing,
  on_start_transcription,
  transcription_models,
  default_transcription,
  on_transcription_model_change,
  ai_models,
  selected_transcript_indices,
  on_transcript_changed,
  open_sections,
  on_open_sections_change,
  collapsed = false,
  on_collapsed_change,
}: TranscriptionToolPanelProps) {
  const {
    available_transcription_models,
    correction_scope,
    selected_transcription_model,
    set_correction_scope,
    set_transcription_options,
    transcription_options,
  } = use_transcription_tool_state({
    asset_id: asset?.asset_id ?? null,
    default_transcription,
    transcription_models,
  });

  if (collapsed) {
    return (
      <aside
        className="h-full overflow-hidden bg-card"
        data-slot="transcription-tools"
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
      open_sections.length === TOOL_PANEL_SECTIONS.length;
    on_open_sections_change(all_sections_open ? [] : [...TOOL_PANEL_SECTIONS]);
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
      (section) => !open_sections.includes(section as ToolPanelSection),
    );
    on_open_sections_change(
      opened_section
        ? [opened_section as ToolPanelSection]
        : (sections as ToolPanelSection[]),
    );
  }

  return (
    <aside
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden border-l bg-card"
      data-slot="transcription-tools"
      aria-label="工具面板"
    >
      <WorkbenchPanelHeader
        icon={Wrench}
        title="转录工具"
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
                <Field data-disabled={is_transcribing || undefined}>
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
                    disabled={!transcription_options || is_transcribing}
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
                  disabled={!asset || is_transcribing}
                />
              ) : (
                <Button
                  className="w-full"
                  type="button"
                  onClick={() => {
                    if (transcription_options)
                      on_start_transcription(transcription_options);
                  }}
                  disabled={!asset || !transcription_options || is_transcribing}
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
                  : "转录生成可编辑文字，完成后可继续校正内容。"}
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
      </Accordion>
    </aside>
  );
}
