import { uuid7 } from "@/shared/identifiers";
import type { SummarySaveMetadata } from "@/shared/types";

export const SUMMARY_CLIENT_ID = `summary-client-${uuid7().replaceAll("-", "")}`;
let client_sequence = 0;

export function create_summary_save_metadata(): SummarySaveMetadata {
  client_sequence += 1;
  return {
    operation_id: `summary-operation-${uuid7().replaceAll("-", "")}`,
    client_id: SUMMARY_CLIENT_ID,
    client_sequence,
  };
}
