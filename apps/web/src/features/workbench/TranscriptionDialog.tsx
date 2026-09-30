import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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

type TranscriptionDialogProps = {
  open: boolean;
  on_open_change: (open: boolean) => void;
  asset: MediaAsset | null;
  asset_count?: number;
  error?: string | null;
  has_transcript: boolean;
  is_transcribing: boolean;
  on_start_transcription: (
    options: TranscriptionOptions,
    download_model: boolean,
  ) => void;
  transcription_models: TranscriptionModelDescriptor[];
  default_transcription: TranscriptionOptions | null;
};

export function TranscriptionDialog({
  open,
  on_open_change,
  asset,
  asset_count = 1,
  error = null,
  has_transcript,
  is_transcribing,
  on_start_transcription,
  transcription_models,
  default_transcription,
}: TranscriptionDialogProps) {
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
  const needs_model_download =
    selected_transcription_model !== null &&
    selected_transcription_model.installation_status !== "installed";
  return (
    <Dialog open={open} onOpenChange={on_open_change}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{asset_count > 1 ? "批量转写" : "转写"}</DialogTitle>
          <DialogDescription>
            {asset_count > 1
              ? `为所选 ${asset_count} 个视频生成可编辑字幕，任务会在后台排队执行。`
              : "选择本地语音模型，为当前视频生成可编辑字幕。"}
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <Alert variant="destructive">
            <AlertTitle>无法读取转写设置</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>状态</span>
          <Badge variant="secondary">
            {is_transcribing ? "转写中" : has_transcript ? "已完成" : "未开始"}
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
        <Button
          className="w-full"
          type="button"
          onClick={() => {
            if (transcription_options) {
              on_start_transcription(
                transcription_options,
                needs_model_download,
              );
            }
          }}
          disabled={!asset || !transcription_options || is_transcribing}
        >
          {is_transcribing ? <Spinner data-icon="inline-start" /> : null}
          {is_transcribing
            ? "转写中…"
            : needs_model_download
              ? "下载并使用"
              : asset_count > 1
                ? `转写 ${asset_count} 个视频`
                : has_transcript
                  ? "重新转写"
                  : "生成转写"}
        </Button>
        {is_transcribing || needs_model_download ? (
          <FieldDescription>
            模型准备与转写会在后台继续，关闭窗口不会取消任务，可在任务中心查看进度。
          </FieldDescription>
        ) : null}
        <FieldDescription>
          {has_transcript
            ? "重新转写会在成功后替换当前文字；失败时保留现有结果。"
            : "已有转写会在成功后替换，失败时保留原结果；完成后可继续修正文字。"}
        </FieldDescription>
      </DialogContent>
    </Dialog>
  );
}
