import { useEffect, useMemo, useState } from "react";

import {
  type TranscriptionModelDescriptor,
  type TranscriptionOptions,
} from "@/shared/types";

type TranscriptionToolStateOptions = {
  asset_id: string | null;
  default_transcription: TranscriptionOptions | null;
  transcription_models: TranscriptionModelDescriptor[];
};

export function use_transcription_tool_state({
  asset_id,
  default_transcription,
  transcription_models,
}: TranscriptionToolStateOptions) {
  const [transcription_options, set_transcription_options] =
    useState<TranscriptionOptions | null>(default_transcription);
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

  return {
    available_transcription_models,
    selected_transcription_model,
    set_transcription_options,
    transcription_options,
  };
}
