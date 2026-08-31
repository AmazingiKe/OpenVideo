import { useId } from "react";
import { Captions } from "lucide-react";

import { TranscriptionModelDownloadAction } from "@/features/settings/TranscriptionModelDownloadAction";
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
import {
  TRANSCRIPTION_LANGUAGE_OPTIONS,
  transcription_runtime_profile,
} from "@/shared/transcription";
import {
  type MediaAsset,
  type TranscriptionModelDescriptor,
  type TranscriptionOptions,
} from "@/shared/types";
import { use_transcription_tool_state } from "./use_transcription_tool_state";

type TranscriptionToolbarToolsProps = {
  asset: MediaAsset | null;
  has_transcript: boolean;
  is_transcribing: boolean;
  on_start_transcription: (options: TranscriptionOptions) => void;
  transcription_models: TranscriptionModelDescriptor[];
  default_transcription: TranscriptionOptions | null;
  on_transcription_model_change: (model: TranscriptionModelDescriptor) => void;
};

export function TranscriptionToolbarTools({
  asset,
  has_transcript,
  is_transcribing,
  on_start_transcription,
  transcription_models,
  default_transcription,
  on_transcription_model_change,
}: TranscriptionToolbarToolsProps) {
  const transcription_title_id = useId();
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
  return (
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
            {is_transcribing ? "转录中" : has_transcript ? "已完成" : "未开始"}
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
          <Field
            data-disabled={
              !transcription_options || is_transcribing || undefined
            }
          >
            <FieldLabel htmlFor="transcription_language">音频语言</FieldLabel>
            <Select
              value={transcription_options?.language ?? "auto"}
              onValueChange={(language) => {
                if (!transcription_options) return;
                set_transcription_options({
                  ...transcription_options,
                  language: language === "auto" ? null : language,
                });
              }}
              disabled={!transcription_options || is_transcribing}
            >
              <SelectTrigger id="transcription_language" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {TRANSCRIPTION_LANGUAGE_OPTIONS.map((language) => (
                    <SelectItem key={language.value} value={language.value}>
                      {language.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <FieldDescription>
              不确定音频语言时使用自动检测，明确语言时可按本次任务覆盖。
            </FieldDescription>
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
  );
}
