import { useEffect, useRef, useState } from "react";
import { Check, Download, RotateCcw, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { error_message, is_abort_error } from "@/shared/errors";
import type { ModelDownloadJob, ModelInstallationStatus } from "@/shared/types";

const MODEL_DOWNLOAD_POLL_INTERVAL_MS = 500;
const ACTIVE_DOWNLOAD_STAGES = new Set<ModelDownloadJob["stage"]>([
  "pending",
  "resolving",
  "downloading",
]);

type ModelDownloadActionProps = {
  name: string;
  installation_status: ModelInstallationStatus;
  job: ModelDownloadJob | null;
  start_download: () => Promise<ModelDownloadJob>;
  poll_download: (
    job_id: string,
    signal?: AbortSignal,
  ) => Promise<ModelDownloadJob>;
  on_change: (
    installation_status: ModelInstallationStatus,
    job: ModelDownloadJob,
  ) => void;
  action_label?: string;
  disabled?: boolean;
};

export function ModelDownloadAction({
  name,
  installation_status,
  job: external_job,
  start_download,
  poll_download,
  on_change,
  action_label = "下载",
  disabled = false,
}: ModelDownloadActionProps) {
  const [job, set_job] = useState(external_job);
  const [error, set_error] = useState<string | null>(
    external_job?.error_message ?? null,
  );
  const start_download_ref = useRef(start_download);
  const poll_download_ref = useRef(poll_download);
  const on_change_ref = useRef(on_change);
  start_download_ref.current = start_download;
  poll_download_ref.current = poll_download;
  on_change_ref.current = on_change;

  useEffect(() => {
    set_job(external_job);
    set_error(external_job?.error_message ?? null);
  }, [external_job]);

  useEffect(() => {
    if (!job || !ACTIVE_DOWNLOAD_STAGES.has(job.stage)) return;
    const controller = new AbortController();
    const timeout_id = window.setTimeout(() => {
      void poll_download_ref
        .current(job.job_id, controller.signal)
        .then((next_job) => {
          set_job(next_job);
          if (next_job.stage === "complete") {
            on_change_ref.current("installed", next_job);
          } else if (next_job.stage === "failed") {
            set_error(next_job.error_message ?? "模型下载失败");
            on_change_ref.current("failed", next_job);
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
  }, [job]);

  async function begin_download() {
    set_error(null);
    try {
      const created_job = await start_download_ref.current();
      set_job(created_job);
      on_change_ref.current("downloading", created_job);
    } catch (download_error) {
      set_error(error_message(download_error));
    }
  }

  const downloading = job ? ACTIVE_DOWNLOAD_STAGES.has(job.stage) : false;
  const installed = installation_status === "installed";
  const progress = job?.progress_percent ?? 0;

  return (
    <div className="flex w-full flex-col gap-2">
      <Button
        type="button"
        variant={installed ? "outline" : "default"}
        onClick={() => void begin_download()}
        disabled={disabled || downloading || installed}
        className="w-full"
      >
        {downloading ? (
          <Spinner data-icon="inline-start" />
        ) : installed ? (
          <Check data-icon="inline-start" aria-hidden="true" />
        ) : installation_status === "failed" ? (
          <RotateCcw data-icon="inline-start" aria-hidden="true" />
        ) : (
          <Download data-icon="inline-start" aria-hidden="true" />
        )}
        {downloading
          ? `下载中 ${Math.round(progress)}%`
          : installed
            ? "已安装"
            : installation_status === "failed"
              ? "重新下载"
              : action_label}
      </Button>
      {downloading ? (
        <Progress value={progress} aria-label={`${name} 下载进度`} />
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
