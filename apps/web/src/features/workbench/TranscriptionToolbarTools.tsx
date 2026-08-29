import { useId } from "react";
import { Captions, WandSparkles } from "lucide-react";

import { TranscriptionModelDownloadAction } from "@/features/settings/TranscriptionModelDownloadAction";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
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
  type MediaAsset,
  type TranscriptionModelDescriptor,
  type TranscriptionOptions,
} from "@/shared/types";
import { use_transcription_tool_state } from "./use_transcription_tool_state";

export type TranscriptCorrectionScope = "all" | "selection";

type TranscriptionToolbarToolsProps = {
  asset: MediaAsset | null;
  has_transcript: boolean;
  is_transcribing: boolean;
  on_start_transcription: (options: TranscriptionOptions) => void;
  transcription_models: TranscriptionModelDescriptor[];
  default_transcription: TranscriptionOptions | null;
  on_transcription_model_change: (model: TranscriptionModelDescriptor) => void;
  selected_transcript_indices: number[];
  correction_open: boolean;
  correction_scope: TranscriptCorrectionScope;
  on_correction_open_change: (open: boolean) => void;
  on_correction_scope_change: (scope: TranscriptCorrectionScope) => void;
};

export function TranscriptionToolbarTools({
  asset,
  has_transcript,
  is_transcribing,
  on_start_transcription,
  transcription_models,
  default_transcription,
  on_transcription_model_change,
  selected_transcript_indices,
  correction_open,
  correction_scope,
  on_correction_open_change,
  on_correction_scope_change,
}: TranscriptionToolbarToolsProps) {
  const transcription_title_id = useId();
  const correction_title_id = useId();
  const {
    available_transcription_models,
    selected_transcription_model,
    set_transcription_options,
    transcription_options,
  } = use_transcription_tool_state({
    asset_id: asset?.asset_id ?? null,
    default_transcription,
    transcription_models,
  });

  function change_correction_open(open: boolean) {
    if (open) {
      on_correction_scope_change(
        selected_transcript_indices.length > 0 ? "selection" : "all",
      );
    }
    on_correction_open_change(open);
  }

  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <Button type="button" size="sm" variant="ghost" aria-label="转录">
            <Captions data-icon="inline-start" aria-hidden="true" />
            <span className="media_timeline_tool_label">转录</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          className="w-80 gap-4 p-4"
          aria-labelledby={transcription_title_id}
        >
          <PopoverHeader>
            <PopoverTitle id={transcription_title_id}>转录</PopoverTitle>
            <PopoverDescription>
              选择本地语音模型，为当前视频生成可编辑字幕。
            </PopoverDescription>
          </PopoverHeader>
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
                  const runtime_profile = transcription_runtime_profile(model);
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
          selected_transcription_model.installation_status !== "installed" ? (
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
                if (transcription_options) {
                  on_start_transcription(transcription_options);
                }
              }}
              disabled={!asset || !transcription_options || is_transcribing}
            >
              {is_transcribing ? <Spinner data-icon="inline-start" /> : null}
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
              : "转录生成可编辑文字，完成后可继续修正内容。"}
          </FieldDescription>
        </PopoverContent>
      </Popover>

      <Popover open={correction_open} onOpenChange={change_correction_open}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={!has_transcript}
            aria-label="字幕修正"
          >
            <WandSparkles data-icon="inline-start" aria-hidden="true" />
            <span className="media_timeline_tool_label">字幕修正</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="end"
          className="max-h-[calc(100dvh-4rem)] w-96 max-w-[calc(100vw-2rem)] gap-4 overflow-y-auto p-4"
          aria-labelledby={correction_title_id}
        >
          <PopoverHeader>
            <PopoverTitle id={correction_title_id}>字幕修正</PopoverTitle>
            <PopoverDescription>
              校对字幕文字并预览变化；时间边界保持不变。
            </PopoverDescription>
          </PopoverHeader>
          <div className="flex min-h-0 flex-col gap-4">
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>处理范围</span>
              <Badge variant="secondary">
                {selected_transcript_indices.length > 0
                  ? `已选择 ${selected_transcript_indices.length} 条`
                  : "未选择字幕"}
              </Badge>
            </div>
            <ToggleGroup
              type="single"
              value={correction_scope}
              onValueChange={(value) => {
                if (value === "all" || value === "selection") {
                  on_correction_scope_change(value);
                }
              }}
              className="w-full"
              aria-label="字幕修正范围"
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
            <Alert>
              <WandSparkles aria-hidden="true" />
              <AlertTitle>已切换到全局助手</AlertTitle>
              <AlertDescription>
                确认处理范围后，在全局助手中启动字幕修正任务；结果仍需审批才会应用。
              </AlertDescription>
            </Alert>
          </div>
        </PopoverContent>
      </Popover>
    </>
  );
}
