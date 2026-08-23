import { useEffect, useState } from "react";
import { Check, Download, RotateCcw, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import {
  download_transcription_model,
  get_transcription_model_download,
} from "@/shared/api";
import { error_message, is_abort_error } from "@/shared/errors";
import type {
  TranscriptionModelDescriptor,
  TranscriptionModelDownloadJob,
} from "@/shared/types";

const MODEL_DOWNLOAD_POLL_INTERVAL_MS = 500;
const ACTIVE_DOWNLOAD_STAGES = new Set<TranscriptionModelDownloadJob["stage"]>([
  "pending",
  "resolving",
  "downloading",
]);

type TranscriptionModelDownloadActionProps = {
  model: TranscriptionModelDescriptor;
  on_change: (model: TranscriptionModelDescriptor) => void;
  on_complete?: () => void;
  action_label?: string;
  disabled?: boolean;
};

export function TranscriptionModelDownloadAction({
  model,
  on_change,
  on_complete,
  action_label = "下载",
  disabled = false,
}: TranscriptionModelDownloadActionProps) {
  const [job, set_job] = useState(model.download_job);
  const [error, set_error] = useState<string | null>(
    model.download_job?.error_message ?? null,
  );

  useEffect(() => {
    set_job(model.download_job);
    set_error(model.download_job?.error_message ?? null);
  }, [model.download_job]);

  useEffect(() => {
    if (!job || !ACTIVE_DOWNLOAD_STAGES.has(job.stage)) return;
    const controller = new AbortController();
    const timeout_id = window.setTimeout(() => {
      void get_transcription_model_download(job.job_id, controller.signal)
        .then((next_job) => {
          set_job(next_job);
          if (next_job.stage === "complete") {
            on_change({
              ...model,
              installation_status: "installed",
              download_job: next_job,
            });
            on_complete?.();
          } else if (next_job.stage === "failed") {
            const failure = next_job.error_message ?? "模型下载失败";
            set_error(failure);
            on_change({
              ...model,
              installation_status: "failed",
              download_job: next_job,
            });
          }
        })
        .catch((poll_error: unknown) => {
          if (!is_abort_error(poll_error)) set_error(error_message(poll_error));
        });
    }, MODEL_DOWNLOAD_POLL_INTERVAL_MS);
    return () => {
      controller.abort();
      window.clearTimeout(timeout_id);
    };
  }, [job, model, on_change, on_complete]);

  async function start_download() {
    set_error(null);
    try {
      const created_job = await download_transcription_model(
        model.engine,
        model.model,
      );
      set_job(created_job);
      on_change({
        ...model,
        installation_status: "downloading",
        download_job: created_job,
      });
    } catch (download_error) {
      set_error(error_message(download_error));
    }
  }

  const downloading = job ? ACTIVE_DOWNLOAD_STAGES.has(job.stage) : false;
  const installed = model.installation_status === "installed";
  const progress = job?.progress_percent ?? 0;

  return (
    <div className="flex w-full flex-col gap-2">
      <Button
        type="button"
        variant={installed ? "outline" : "default"}
        onClick={() => void start_download()}
        disabled={disabled || downloading || installed}
        className="w-full"
      >
        {downloading ? (
          <Spinner data-icon="inline-start" />
        ) : installed ? (
          <Check data-icon="inline-start" aria-hidden="true" />
        ) : model.installation_status === "failed" ? (
          <RotateCcw data-icon="inline-start" aria-hidden="true" />
        ) : (
          <Download data-icon="inline-start" aria-hidden="true" />
        )}
        {downloading
          ? `下载中 ${Math.round(progress)}%`
          : installed
            ? "已安装"
            : model.installation_status === "failed"
              ? "重新下载"
              : action_label}
      </Button>
      {downloading ? (
        <Progress value={progress} aria-label={`${model.name} 下载进度`} />
      ) : null}
      {error ? (
        <p
          className="flex items-start gap-1 text-xs text-destructive"
          role="alert"
        >
          <TriangleAlert aria-hidden="true" />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}
