import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  get_cloud_submission_status,
  resolve_cloud_submission,
  type CloudSubmissionResolution,
  type CloudSubmissionStatus,
} from "@/shared/api/cloud_submission";
import { error_message } from "@/shared/errors";

import {
  type TranscriptionModelDescriptor,
  type TranscriptionOptions,
} from "@/shared/types";

type TranscriptionToolStateOptions = {
  asset_id: string | null;
  default_transcription: TranscriptionOptions | null;
  transcription_models: TranscriptionModelDescriptor[];
  inspect_cloud_submission: boolean;
};

export function use_transcription_tool_state({
  asset_id,
  default_transcription,
  transcription_models,
  inspect_cloud_submission,
}: TranscriptionToolStateOptions) {
  const [transcription_options, set_transcription_options] =
    useState<TranscriptionOptions | null>(default_transcription);
  const [cloud_submission, set_cloud_submission] = useState<{
    asset_id: string;
    status: CloudSubmissionStatus;
  } | null>(null);
  const [cloud_submission_error, set_cloud_submission_error] = useState<
    string | null
  >(null);
  const [resolving_cloud_submission, set_resolving_cloud_submission] =
    useState(false);
  const cloud_controller = useRef<AbortController | null>(null);
  const available_transcription_models = useMemo(
    () =>
      transcription_models.filter(
        (model) => model.integration_status === "available",
      ),
    [transcription_models],
  );
  const selected_transcription_model = useMemo(
    () =>
      transcription_options
        ? (transcription_models.find(
            (model) =>
              model.engine === transcription_options.engine &&
              model.model === transcription_options.model,
          ) ?? null)
        : null,
    [transcription_models, transcription_options],
  );

  useEffect(() => {
    set_transcription_options(default_transcription);
  }, [asset_id, default_transcription]);

  useEffect(() => {
    set_cloud_submission(null);
    set_cloud_submission_error(null);
    set_resolving_cloud_submission(false);
    if (!inspect_cloud_submission || !asset_id) return;
    const controller = new AbortController();
    cloud_controller.current = controller;
    void get_cloud_submission_status(asset_id, controller.signal)
      .then((status) => {
        if (!controller.signal.aborted && status) {
          set_cloud_submission({ asset_id, status });
        }
      })
      .catch(() => undefined);
    return () => {
      controller.abort();
      cloud_controller.current = null;
    };
  }, [asset_id, inspect_cloud_submission]);

  const confirm_cloud_submission = useCallback(
    async (resolution: CloudSubmissionResolution) => {
      const controller = cloud_controller.current;
      if (!asset_id || cloud_submission?.asset_id !== asset_id || !controller)
        return;
      set_resolving_cloud_submission(true);
      set_cloud_submission_error(null);
      try {
        const status = await resolve_cloud_submission(
          asset_id,
          cloud_submission.status.job_id,
          resolution,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        set_cloud_submission({ asset_id, status });
        if (status.cloud_task_id) set_transcription_options(status.options);
      } catch (error) {
        if (!controller.signal.aborted)
          set_cloud_submission_error(error_message(error));
      } finally {
        if (!controller.signal.aborted) set_resolving_cloud_submission(false);
      }
    },
    [asset_id, cloud_submission],
  );

  return {
    available_transcription_models,
    selected_transcription_model,
    set_transcription_options,
    transcription_options,
    cloud_submission:
      cloud_submission?.asset_id === asset_id ? cloud_submission.status : null,
    cloud_submission_error,
    resolving_cloud_submission,
    confirm_cloud_submission,
  };
}
