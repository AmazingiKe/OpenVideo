import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { RESOURCE_QUERY_KEYS } from "@/app/query_cache";
import {
  get_preferences,
  list_ai_models,
  list_transcription_models,
  update_preferences,
} from "@/shared/api";
import { error_message } from "@/shared/errors";
import type {
  AgentPermissionMode,
  AgentPreferences,
  AiModelSummary,
  Preferences,
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

export function use_agent_preferences(): {
  agent_preferences: AgentPreferences | null;
  permission_mode_saving: boolean;
  set_permission_mode: (permission_mode: AgentPermissionMode) => void;
  error: string | null;
} {
  const query_client = useQueryClient();
  const preferences_query = useQuery({
    queryKey: RESOURCE_QUERY_KEYS.preferences,
    queryFn: ({ signal }) => get_preferences(signal),
  });
  const permission_mode_mutation = useMutation({
    mutationFn: (permission_mode: AgentPermissionMode) => {
      const preferences = query_client.getQueryData<Preferences>(
        RESOURCE_QUERY_KEYS.preferences,
      );
      if (!preferences) throw new Error("助手权限设置尚未加载");
      return update_preferences({
        agent: { ...preferences.agent, permission_mode },
      });
    },
    onMutate: async (permission_mode) => {
      await query_client.cancelQueries({
        queryKey: RESOURCE_QUERY_KEYS.preferences,
      });
      const previous_preferences = query_client.getQueryData<Preferences>(
        RESOURCE_QUERY_KEYS.preferences,
      );
      if (previous_preferences) {
        query_client.setQueryData<Preferences>(
          RESOURCE_QUERY_KEYS.preferences,
          {
            ...previous_preferences,
            agent: { ...previous_preferences.agent, permission_mode },
          },
        );
      }
      return { previous_preferences };
    },
    onError: (_caught, _permission_mode, context) => {
      if (context?.previous_preferences) {
        query_client.setQueryData(
          RESOURCE_QUERY_KEYS.preferences,
          context.previous_preferences,
        );
      }
    },
    onSuccess: (preferences) => {
      query_client.setQueryData(RESOURCE_QUERY_KEYS.preferences, preferences);
    },
  });
  const caught = preferences_query.error ?? permission_mode_mutation.error;
  return {
    agent_preferences: preferences_query.data?.agent ?? null,
    permission_mode_saving: permission_mode_mutation.isPending,
    set_permission_mode: permission_mode_mutation.mutate,
    error: caught ? error_message(caught) : null,
  };
}

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
