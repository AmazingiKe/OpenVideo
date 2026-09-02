import type {
  AgentAnswerStatus,
  AgentCitationValidation,
  AgentConfidence,
  AgentContextAttachment,
  AgentEvidenceBundle,
  AgentEvidenceConflict,
  AgentEvidenceReference,
  AgentRetrievalScope,
  AgentRun,
  AgentRunMetrics,
  AgentThinkingMode,
} from "@/shared/types";

export function parse_run_metrics(value: unknown): AgentRunMetrics | undefined {
  if (!is_record(value)) return undefined;
  const metrics: AgentRunMetrics = {};
  assign_number(metrics, "total_ms", value.total_ms);
  assign_number(
    metrics,
    "time_to_first_token_ms",
    value.time_to_first_token_ms,
  );
  assign_number(metrics, "routing_ms", value.routing_ms);
  assign_number(metrics, "retrieval_ms", value.retrieval_ms);
  assign_number(metrics, "vision_ms", value.vision_ms);
  assign_number(metrics, "model_wait_ms", value.model_wait_ms);
  assign_number(metrics, "tool_ms", value.tool_ms);
  assign_number(metrics, "generation_ms", value.generation_ms);
  assign_number(metrics, "retry_count", value.retry_count);
  assign_number(metrics, "tool_count", value.tool_count);

  const model_role = parse_model_role(value.model_role);
  if (model_role !== undefined) metrics.model_role = model_role;
  const selected_model_id = optional_nullable_string(value.selected_model_id);
  if (selected_model_id !== undefined)
    metrics.selected_model_id = selected_model_id;
  const final_status = optional_nullable_string(value.final_status);
  if (final_status !== undefined) metrics.final_status = final_status;
  if (is_record(value.tool_durations_ms)) {
    const tool_durations_ms = Object.fromEntries(
      Object.entries(value.tool_durations_ms).filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === "number" && entry[1] >= 0,
      ),
    );
    if (Object.keys(tool_durations_ms).length > 0) {
      metrics.tool_durations_ms = tool_durations_ms;
    }
  }

  return Object.keys(metrics).length > 0 ? metrics : undefined;
}

export function run_duration_metrics(
  runs: AgentRun[],
  run_id: string,
): AgentRunMetrics | undefined {
  const run = runs.find((item) => item.run_id === run_id);
  if (!run?.started_at || !run.completed_at) return undefined;
  const total_ms =
    new Date(run.completed_at).getTime() - new Date(run.started_at).getTime();
  return Number.isFinite(total_ms) && total_ms >= 0 ? { total_ms } : undefined;
}

export function parse_confidence(value: unknown): AgentConfidence | undefined {
  return value === "high" || value === "medium" || value === "low"
    ? value
    : undefined;
}

export function parse_answer_status(
  value: unknown,
): AgentAnswerStatus | undefined {
  return value === "final" ||
    value === "provisional" ||
    value === "insufficient"
    ? value
    : undefined;
}

export function parse_citation_validation(
  value: unknown,
): AgentCitationValidation | undefined {
  if (
    !is_record(value) ||
    typeof value.valid !== "boolean" ||
    typeof value.missing_citations !== "boolean" ||
    !Array.isArray(value.invalid_citations) ||
    !value.invalid_citations.every((item) => typeof item === "string")
  ) {
    return undefined;
  }
  return {
    valid: value.valid,
    invalid_citations: value.invalid_citations,
    missing_citations: value.missing_citations,
  };
}

export function parse_thinking_mode(
  value: unknown,
): AgentThinkingMode | undefined {
  return value === "auto" || value === "fast" || value === "complex"
    ? value
    : undefined;
}

export function parse_retrieval_scope(
  value: unknown,
): AgentRetrievalScope | undefined {
  return value === "current_asset" || value === "library" ? value : undefined;
}

export function parse_context_attachments(
  value: unknown,
): AgentContextAttachment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const attachments = value.flatMap((item) => {
    const parsed = parse_context_attachment(item);
    return parsed ? [parsed] : [];
  });
  return attachments.length > 0 ? attachments : undefined;
}

export function parse_evidence_bundle(
  value: unknown,
): AgentEvidenceBundle | undefined {
  if (!is_record(value) || !is_record(value.coverage)) return undefined;
  if (
    typeof value.coverage.temporal !== "number" ||
    !Array.isArray(value.coverage.source_types) ||
    !value.coverage.source_types.every((item) => typeof item === "string")
  ) {
    return undefined;
  }
  return {
    items: parse_evidence_list(value.items),
    conflicts: parse_conflicts(value.conflicts),
    coverage: {
      temporal: value.coverage.temporal,
      source_types: value.coverage.source_types,
    },
  };
}

function parse_context_attachment(
  value: unknown,
): AgentContextAttachment | null {
  if (
    !is_record(value) ||
    typeof value.attachment_id !== "string" ||
    !(
      value.kind === "summary_selection" ||
      value.kind === "transcript_selection" ||
      value.kind === "time_range"
    ) ||
    typeof value.asset_id !== "string" ||
    typeof value.label !== "string"
  ) {
    return null;
  }
  return {
    attachment_id: value.attachment_id,
    kind: value.kind,
    asset_id: value.asset_id,
    label: value.label,
    reference_id: optional_string(value.reference_id),
    start_seconds: optional_number(value.start_seconds),
    end_seconds: optional_number(value.end_seconds),
    snapshot_text: optional_string(value.snapshot_text),
    content_digest: optional_string(value.content_digest),
    selection_start: optional_number(value.selection_start),
    selection_end: optional_number(value.selection_end),
  };
}

function parse_evidence_list(value: unknown): AgentEvidenceReference[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (
      !is_record(item) ||
      typeof item.evidence_id !== "string" ||
      typeof item.citation_key !== "string" ||
      typeof item.source_type !== "string" ||
      typeof item.source_version !== "string" ||
      typeof item.asset_id !== "string" ||
      typeof item.start_seconds !== "number" ||
      typeof item.end_seconds !== "number" ||
      typeof item.excerpt !== "string" ||
      !(item.relation === "supports" || item.relation === "conflicts") ||
      !is_retrieval_relation(item.retrieval_relation)
    ) {
      return [];
    }
    return [
      {
        evidence_id: item.evidence_id,
        citation_key: item.citation_key,
        source_type: item.source_type,
        source_version: item.source_version,
        asset_id: item.asset_id,
        start_seconds: item.start_seconds,
        end_seconds: item.end_seconds,
        excerpt: item.excerpt,
        relation: item.relation,
        retrieval_relation: item.retrieval_relation,
      },
    ];
  });
}

function parse_conflicts(value: unknown): AgentEvidenceConflict[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (
      !is_record(item) ||
      !Array.isArray(item.evidence_ids) ||
      !item.evidence_ids.every(
        (evidence_id) => typeof evidence_id === "string",
      ) ||
      typeof item.reason !== "string"
    ) {
      return [];
    }
    return [{ evidence_ids: item.evidence_ids, reason: item.reason }];
  });
}

function parse_model_role(value: unknown): AgentRunMetrics["model_role"] {
  return value === "fast" ||
    value === "complex" ||
    value === "vision" ||
    value === null
    ? value
    : undefined;
}

function is_retrieval_relation(
  value: unknown,
): value is AgentEvidenceReference["retrieval_relation"] {
  return (
    value === undefined ||
    value === "direct" ||
    value === "neighbor" ||
    value === "overview" ||
    value === "corroborated"
  );
}

function optional_string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optional_nullable_string(value: unknown): string | null | undefined {
  return typeof value === "string" || value === null ? value : undefined;
}

function optional_number(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function assign_number(
  metrics: AgentRunMetrics,
  key: keyof Pick<
    AgentRunMetrics,
    | "total_ms"
    | "time_to_first_token_ms"
    | "routing_ms"
    | "retrieval_ms"
    | "vision_ms"
    | "model_wait_ms"
    | "tool_ms"
    | "generation_ms"
    | "retry_count"
    | "tool_count"
  >,
  value: unknown,
) {
  const parsed = optional_number(value);
  if (parsed !== undefined) metrics[key] = parsed;
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
