import {
  download_transcription_model,
  get_transcription_model_download,
} from "@/shared/api";
import type {
  ModelDownloadJob,
  TranscriptionModelDescriptor,
  TranscriptionModelDownloadJob,
} from "@/shared/types";
import { ModelDownloadAction } from "./ModelDownloadAction";

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
  return (
    <ModelDownloadAction
      name={model.name}
      installation_status={model.installation_status}
      job={model.download_job}
      start_download={() =>
        download_transcription_model(model.engine, model.model)
      }
      poll_download={get_transcription_model_download}
      on_change={(installation_status, job: ModelDownloadJob) => {
        on_change({
          ...model,
          installation_status,
          download_job: job as TranscriptionModelDownloadJob,
        });
        if (installation_status === "installed") on_complete?.();
      }}
      action_label={action_label}
      disabled={disabled}
    />
  );
}
