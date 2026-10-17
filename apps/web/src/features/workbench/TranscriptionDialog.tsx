import { useEffect, useState } from "react";

import { TranscriptionModelDownloadAction } from "@/features/settings/TranscriptionModelDownloadAction";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
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
import { TranscriptHistory } from "./TranscriptHistory";
import { use_transcription_preflight } from "./use_transcription_preflight";
import { use_transcription_tool_state } from "./use_transcription_tool_state";

type TranscriptionDialogProps = {
  open: boolean;
  on_open_change: (open: boolean) => void;
  asset: MediaAsset | null;
  asset_count?: number;
  asset_ids?: string[];
  error?: string | null;
  has_transcript: boolean;
  on_transcript_restored?: () => void;
  is_transcribing: boolean;
  on_start_transcription: (options: TranscriptionOptions) => void;
  transcription_models: TranscriptionModelDescriptor[];
  default_transcription: TranscriptionOptions | null;
  on_transcription_model_change: (model: TranscriptionModelDescriptor) => void;
};

export function TranscriptionDialog({
  open,
  on_open_change,
  asset,
  asset_count = 1,
  asset_ids,
  error = null,
  has_transcript,
  on_transcript_restored,
  is_transcribing,
  on_start_transcription,
  transcription_models,
  default_transcription,
  on_transcription_model_change,
}: TranscriptionDialogProps) {
  const {
    available_transcription_models,
    selected_transcription_model,
    set_transcription_options,
    transcription_options,
    cloud_submission,
    cloud_submission_error,
    resolving_cloud_submission,
    confirm_cloud_submission,
  } = use_transcription_tool_state({
    asset_id: asset?.asset_id ?? null,
    default_transcription,
    transcription_models,
    inspect_cloud_submission: open && asset_count === 1,
  });
  const preflight = use_transcription_preflight(
    open && !is_transcribing && !cloud_submission?.uncertain,
    asset_ids ?? (asset ? [asset.asset_id] : []),
    transcription_options,
  );
  const [cloud_task_id, set_cloud_task_id] = useState("");
  const [confirm_not_submitted, set_confirm_not_submitted] = useState(false);
  useEffect(() => {
    set_cloud_task_id("");
    set_confirm_not_submitted(false);
  }, [asset?.asset_id, open]);
  const submission_blocked = Boolean(cloud_submission?.uncertain);
  return (
    <Dialog open={open} onOpenChange={on_open_change}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{asset_count > 1 ? "批量转写" : "转写"}</DialogTitle>
          <DialogDescription>
            {asset_count > 1
              ? `为所选 ${asset_count} 个视频生成可编辑字幕，任务会在后台排队执行。`
              : "选择本地或云端语音模型，为当前视频生成可编辑字幕。"}
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <Alert variant="destructive">
            <AlertTitle>无法读取转写设置</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {submission_blocked ? (
          <Alert>
            <AlertTitle>上次云端提交结果待确认</AlertTitle>
            <AlertDescription>
              <p>
                请先到百炼控制台核实，避免重复提交和计费。恢复操作只保存核实结果，不会提交转写。
              </p>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="cloud_task_id">
                    已有百炼任务号
                  </FieldLabel>
                  <Input
                    id="cloud_task_id"
                    value={cloud_task_id}
                    onChange={(event) => set_cloud_task_id(event.target.value)}
                    disabled={resolving_cloud_submission || is_transcribing}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    disabled={
                      !cloud_task_id.trim() ||
                      resolving_cloud_submission ||
                      is_transcribing
                    }
                    onClick={() =>
                      void confirm_cloud_submission({
                        cloud_task_id: cloud_task_id.trim(),
                      })
                    }
                  >
                    关联已有任务
                  </Button>
                </Field>
                <Field className="flex-row items-start">
                  <Checkbox
                    id="confirm_not_submitted"
                    checked={confirm_not_submitted}
                    onCheckedChange={(checked) =>
                      set_confirm_not_submitted(checked === true)
                    }
                    disabled={resolving_cloud_submission || is_transcribing}
                  />
                  <FieldLabel htmlFor="confirm_not_submitted">
                    已核实未生成云端任务，允许下次重新提交
                  </FieldLabel>
                </Field>
                <Button
                  type="button"
                  variant="outline"
                  disabled={
                    !confirm_not_submitted ||
                    resolving_cloud_submission ||
                    is_transcribing
                  }
                  onClick={() =>
                    void confirm_cloud_submission({
                      confirm_not_submitted: true,
                    })
                  }
                >
                  解除提交锁定
                </Button>
                <FieldDescription>
                  解除锁定后，再次选择云端转写可能产生费用。
                </FieldDescription>
              </FieldGroup>
              {cloud_submission_error ? (
                <p role="alert">{cloud_submission_error}</p>
              ) : null}
            </AlertDescription>
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
                {selected_transcription_model.description}
                {selected_transcription_model.engine !== "bailian" ? (
                  <>
                    {" "}
                    当前使用
                    {transcription_options.language ?? "自动检测"}、
                    {transcription_options.device.toUpperCase()}、
                    {transcription_options.compute_type}。
                  </>
                ) : null}
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
        {selected_transcription_model?.engine === "bailian" ? (
          <Alert>
            <AlertTitle>云端转写 · 按量计费</AlertTitle>
            <AlertDescription>
              本次{asset_count > 1 ? `所选 ${asset_count} 个视频的` : "视频的"}
              音频将上传至阿里云百炼。请先在设置中保存对应区域的 API
              Key，费用按音频时长由百炼计收。
            </AlertDescription>
          </Alert>
        ) : null}
        {!is_transcribing ? (
          <Alert
            variant={
              preflight.error || preflight.check?.issues.length
                ? "destructive"
                : "default"
            }
          >
            <AlertTitle>
              {preflight.check?.ready ? "开始前检查通过" : "开始前检查"}
            </AlertTitle>
            <AlertDescription>
              {preflight.checking ? (
                <p className="flex items-center gap-2">
                  <Spinner aria-hidden="true" />
                  正在检查素材、模型与运行配置…
                </p>
              ) : null}
              {preflight.error ? <p role="alert">{preflight.error}</p> : null}
              {preflight.check?.issues.length ? (
                <ul className="flex list-disc flex-col gap-2 pl-4">
                  {preflight.check.issues.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              ) : null}
              {preflight.check?.notes.map((note) => (
                <p key={note}>{note}</p>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={preflight.checking}
                onClick={preflight.recheck}
              >
                重新检查
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
        {selected_transcription_model &&
        selected_transcription_model.engine !== "bailian" &&
        selected_transcription_model.installation_status !== "installed" ? (
          <TranscriptionModelDownloadAction
            model={selected_transcription_model}
            action_label="下载模型"
            on_change={on_transcription_model_change}
            on_complete={preflight.recheck}
            disabled={!asset || is_transcribing || submission_blocked}
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
            disabled={
              !asset ||
              !transcription_options ||
              is_transcribing ||
              submission_blocked ||
              !preflight.check?.ready
            }
          >
            {is_transcribing ? <Spinner data-icon="inline-start" /> : null}
            {is_transcribing
              ? "转写中…"
              : asset_count > 1
                ? `转写 ${asset_count} 个视频`
                : has_transcript
                  ? "重新转写"
                  : "生成转写"}
          </Button>
        )}
        <FieldDescription>
          {has_transcript
            ? "重新转写成功前会备份当前字幕，可在字幕历史中恢复；失败时保留现有结果。"
            : "已有字幕替换前会自动备份；失败时保留原结果，完成后可继续修正文字。"}
        </FieldDescription>
        {open && asset && asset_count === 1 && has_transcript ? (
          <TranscriptHistory
            key={asset.asset_id}
            asset_id={asset.asset_id}
            disabled={is_transcribing}
            on_restored={on_transcript_restored}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
