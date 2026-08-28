import { useEffect, useMemo, useState } from "react";

import { DEFAULT_ANALYSIS_STRATEGY } from "@/shared/analysis";
import {
  IMAGE_INPUT_MODALITY,
  type AiModelSummary,
  type AnalysisMode,
  type AnalysisStrategy,
  type AnalysisStrategyPresetDescriptor,
  type MediaMarker,
  type TranscriptionModelDescriptor,
  type TranscriptionOptions,
} from "@/shared/types";

const DEFAULT_ANALYSIS_PRESET: AnalysisStrategyPresetDescriptor = {
  preset: "course_notes",
  name: "课程笔记",
  description: "突出核心概念、结论与可复习的知识结构。",
  strategy: DEFAULT_ANALYSIS_STRATEGY,
};

type AnalysisToolStateOptions = {
  ai_models: AiModelSummary[];
  analysis_strategies: AnalysisStrategyPresetDescriptor[];
  analysis_strategy: AnalysisStrategy;
  asset_id: string | null;
  default_transcription: TranscriptionOptions | null;
  markers: MediaMarker[];
  transcription_models: TranscriptionModelDescriptor[];
};

export function use_analysis_tool_state({
  ai_models,
  analysis_strategies,
  analysis_strategy,
  asset_id,
  default_transcription,
  markers,
  transcription_models,
}: AnalysisToolStateOptions) {
  const [analysis_mode, set_analysis_mode] = useState<AnalysisMode>("full");
  const [advanced_strategy_open, set_advanced_strategy_open] = useState(false);
  const [transcription_options, set_transcription_options] =
    useState<TranscriptionOptions | null>(default_transcription);
  const [selected_marker_ids, set_selected_marker_ids] = useState<Set<string>>(
    new Set(),
  );
  const [correction_scope, set_correction_scope] = useState<
    "all" | "selection"
  >("all");
  const [image_model_id, set_image_model_id] = useState<string | null>(null);

  const image_input_models = useMemo(
    () =>
      ai_models.filter((model) =>
        model.input_modalities.includes(IMAGE_INPUT_MODALITY),
      ),
    [ai_models],
  );
  const resolved_strategy_presets = useMemo(
    () =>
      analysis_strategies.length > 0
        ? analysis_strategies
        : [DEFAULT_ANALYSIS_PRESET],
    [analysis_strategies],
  );
  const strategy_name =
    analysis_strategy.preset === "custom"
      ? "自定义"
      : (resolved_strategy_presets.find(
          (preset) => preset.preset === analysis_strategy.preset,
        )?.name ?? DEFAULT_ANALYSIS_PRESET.name);
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
    set_selected_marker_ids(new Set(markers.map((marker) => marker.marker_id)));
  }, [asset_id, markers]);

  useEffect(() => {
    set_transcription_options(default_transcription);
  }, [asset_id, default_transcription]);

  useEffect(() => {
    set_image_model_id((current) =>
      image_input_models.some((model) => model.model_id === current)
        ? current
        : null,
    );
  }, [image_input_models]);

  return {
    advanced_strategy_open,
    analysis_mode,
    available_transcription_models,
    correction_scope,
    image_input_models,
    image_model_id,
    resolved_strategy_presets,
    selected_marker_ids,
    selected_transcription_model,
    set_advanced_strategy_open,
    set_analysis_mode,
    set_correction_scope,
    set_image_model_id,
    set_selected_marker_ids,
    set_transcription_options,
    strategy_name,
    transcription_options,
  };
}
