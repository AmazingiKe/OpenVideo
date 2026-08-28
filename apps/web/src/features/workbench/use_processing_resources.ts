import { useQuery } from "@tanstack/react-query";

import { RESOURCE_QUERY_KEYS } from "@/app/query_cache";
import {
  get_preferences,
  list_ai_models,
  list_transcription_models,
} from "@/shared/api";
import { error_message } from "@/shared/errors";
import type {
  AiModelSummary,
  TranscriptionModelDescriptor,
  TranscriptionOptions,
} from "@/shared/types";

type TranscriptionResources = {
  transcription_models: TranscriptionModelDescriptor[];
  default_transcription: TranscriptionOptions | null;
};

const EMPTY_TRANSCRIPTION_RESOURCES: TranscriptionResources = {
  transcription_models: [],
  default_transcription: null,
};

export function use_ai_models(): {
  models: AiModelSummary[];
  error: string | null;
} {
  const models_query = useQuery({
    queryKey: RESOURCE_QUERY_KEYS.ai_models,
    queryFn: ({ signal }) => list_ai_models(signal),
  });
  return {
    models: models_query.data ?? [],
    error: models_query.error ? error_message(models_query.error) : null,
  };
}

export function use_transcription_resources(): TranscriptionResources & {
  error: string | null;
} {
  const resources_query = useQuery({
    queryKey: RESOURCE_QUERY_KEYS.transcription_resources,
    queryFn: async ({ signal }) => {
      const [transcription_models, preferences] = await Promise.all([
        list_transcription_models(signal),
        get_preferences(signal),
      ]);
      return {
        transcription_models,
        default_transcription: preferences.default_transcription,
      };
    },
  });
  return {
    ...(resources_query.data ?? EMPTY_TRANSCRIPTION_RESOURCES),
    error: resources_query.error ? error_message(resources_query.error) : null,
  };
}
