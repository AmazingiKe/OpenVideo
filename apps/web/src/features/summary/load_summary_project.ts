import {
  initialize_summary_document,
  list_summary_documents,
} from "@/shared/api";
import type { SummaryDocument } from "@/shared/types";

export type SummaryProjectSnapshot = {
  documents: SummaryDocument[];
};

export async function load_summary_project(
  asset_id: string,
  signal?: AbortSignal,
): Promise<SummaryProjectSnapshot> {
  const documents = await list_summary_documents(asset_id, signal);
  if (documents.length > 0) return { documents };
  return { documents: [await initialize_summary_document(asset_id, signal)] };
}
