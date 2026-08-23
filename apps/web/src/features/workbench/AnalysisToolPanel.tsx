import {
  useEffect,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { ChevronRight, Wrench } from "lucide-react";

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
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { format_duration, format_time } from "@/shared/format";
import type {
  AnalysisMode,
  AnalysisToolSection,
  MediaAsset,
  MediaMarker,
  TranscriptionOptions,
} from "@/shared/types";
import { CollapsiblePanelRail } from "./CollapsiblePanelRail";

export const ANALYSIS_TOOL_SECTIONS: AnalysisToolSection[] = [
  "video_information",
  "transcription",
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
  is_analyzing: boolean;
  on_start_analysis: (mode: AnalysisMode, marker_ids: string[]) => void;
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
  is_analyzing,
  on_start_analysis,
  open_sections,
  on_open_sections_change,
  collapsed = false,
  on_collapsed_change,
}: AnalysisToolPanelProps) {
  const [analysis_mode, set_analysis_mode] = useState<AnalysisMode>("full");
  const [transcription_options, set_transcription_options] =
    useState<TranscriptionOptions>({
      model: "small",
      language: "zh",
      compute_type: "int8",
    });
  const [selected_marker_ids, set_selected_marker_ids] = useState<Set<string>>(
    new Set(),
  );

  useEffect(() => {
    set_selected_marker_ids(new Set(markers.map((marker) => marker.marker_id)));
  }, [asset?.asset_id, markers]);

  if (collapsed) {
    return (
      <aside
        className="analysis_tools analysis_tools_collapsed"
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
    <aside className="analysis_tools" aria-label="工具面板">
      <header className="analysis_tools_header">
        <div>
          <Wrench aria-hidden="true" />
          <h2>工具</h2>
        </div>
        {on_collapsed_change ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => on_collapsed_change(true)}
            aria-label="收起工具面板"
          >
            <ChevronRight data-icon="inline-start" aria-hidden="true" />
          </Button>
        ) : null}
      </header>
      <Accordion
        type="multiple"
        value={open_sections}
        onValueChange={(sections) =>
          on_open_sections_change(sections as AnalysisToolSection[])
        }
        className="analysis_tools_accordion"
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
            <div className="processing_actions">
              <div className="tool_status_row">
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
                  <Input
                    id="transcription_model"
                    value={transcription_options.model}
                    onChange={(event) =>
                      set_transcription_options((current) => ({
                        ...current,
                        model: event.target.value,
                      }))
                    }
                    disabled={is_transcribing || is_analyzing || has_transcript}
                  />
                </Field>
                <Field
                  data-disabled={
                    is_transcribing ||
                    is_analyzing ||
                    has_transcript ||
                    undefined
                  }
                >
                  <FieldLabel htmlFor="transcription_language">语言</FieldLabel>
                  <Input
                    id="transcription_language"
                    value={transcription_options.language ?? ""}
                    onChange={(event) =>
                      set_transcription_options((current) => ({
                        ...current,
                        language: event.target.value || null,
                      }))
                    }
                    disabled={is_transcribing || is_analyzing || has_transcript}
                  />
                </Field>
                <Field
                  data-disabled={
                    is_transcribing ||
                    is_analyzing ||
                    has_transcript ||
                    undefined
                  }
                >
                  <FieldLabel htmlFor="transcription_compute_type">
                    计算精度
                  </FieldLabel>
                  <Input
                    id="transcription_compute_type"
                    value={transcription_options.compute_type}
                    onChange={(event) =>
                      set_transcription_options((current) => ({
                        ...current,
                        compute_type: event.target.value,
                      }))
                    }
                    disabled={is_transcribing || is_analyzing || has_transcript}
                  />
                </Field>
              </FieldGroup>
              <Button
                className="w-full"
                type="button"
                onClick={() => on_start_transcription(transcription_options)}
                disabled={
                  !asset || is_transcribing || is_analyzing || has_transcript
                }
              >
                {is_transcribing ? <Spinner data-icon="inline-start" /> : null}
                {is_transcribing
                  ? "转录中…"
                  : has_transcript
                    ? "转录已完成"
                    : "生成转录"}
              </Button>
              <FieldDescription>
                转录生成可编辑文字，完成后可继续内容分析。
              </FieldDescription>
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
            <div className="processing_actions">
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
              {analysis_mode === "markers" ? (
                <div className="analysis_marker_options">
                  {markers.map((marker) => (
                    <label key={marker.marker_id}>
                      <Checkbox
                        checked={selected_marker_ids.has(marker.marker_id)}
                        onCheckedChange={() =>
                          set_selected_marker_ids((current) =>
                            toggle_marker(current, marker.marker_id),
                          )
                        }
                        aria-label={`选择 ${format_time(marker.time_seconds)} 标记`}
                      />
                      <time>{format_time(marker.time_seconds)}</time>
                      <span>{marker.tags.join(" / ") || "未分类标记"}</span>
                    </label>
                  ))}
                </div>
              ) : null}
              <Button
                className="w-full"
                type="button"
                onClick={() =>
                  on_start_analysis(analysis_mode, [...selected_marker_ids])
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
  if (!asset) return <p className="tool_empty_state">尚未选择视频。</p>;

  return (
    <dl className="video_information">
      <div>
        <dt>简介</dt>
        <dd>{asset.description || "暂无简介"}</dd>
      </div>
      <div>
        <dt>时长</dt>
        <dd>{format_duration(asset.duration_seconds)}</dd>
      </div>
      <div>
        <dt>来源</dt>
        <dd>
          <a href={asset.source_url} target="_blank" rel="noreferrer">
            {SOURCE_LABELS[asset.source_platform]}
          </a>
        </dd>
      </div>
      <div>
        <dt>分辨率</dt>
        <dd>{format_resolution(asset)}</dd>
      </div>
      <div>
        <dt>视频编码</dt>
        <dd>{asset.video_codec || "待探测"}</dd>
      </div>
      <div>
        <dt>音频编码</dt>
        <dd>{asset.audio_codec || "待探测"}</dd>
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
