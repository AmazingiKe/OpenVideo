import { useQuery } from "@tanstack/react-query";

import { RESOURCE_QUERY_KEYS } from "@/app/query_cache";
import {
  get_preferences,
  list_ai_models,
  list_analysis_strategies,
  list_transcription_models,
} from "@/shared/api";
import { error_message } from "@/shared/errors";
import type {
  AiModelSummary,
  AnalysisStrategyPresetDescriptor,
  TranscriptionModelDescriptor,
  TranscriptionOptions,
} from "@/shared/types";

type AnalysisResources = {
  transcription_models: TranscriptionModelDescriptor[];
  default_transcription: TranscriptionOptions | null;
  analysis_strategies: AnalysisStrategyPresetDescriptor[];
};

const EMPTY_ANALYSIS_RESOURCES: AnalysisResources = {
  transcription_models: [],
  default_transcription: null,
  analysis_strategies: [],
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

export function use_analysis_resources(): AnalysisResources & {
  error: string | null;
} {
  const resources_query = useQuery({
    queryKey: RESOURCE_QUERY_KEYS.analysis_resources,
    queryFn: async ({ signal }) => {
      const [transcription_models, preferences, analysis_strategies] =
        await Promise.all([
          list_transcription_models(signal),
          get_preferences(signal),
          list_analysis_strategies(signal),
        ]);
      return {
        transcription_models,
        default_transcription: preferences.default_transcription,
        analysis_strategies,
      };
    },
  });
  return {
    ...(resources_query.data ?? EMPTY_ANALYSIS_RESOURCES),
    error: resources_query.error ? error_message(resources_query.error) : null,
  };
}
