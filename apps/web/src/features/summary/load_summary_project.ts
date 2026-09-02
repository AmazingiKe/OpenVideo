import { list_summary_documents } from "@/shared/api";
import type { SummaryDocument } from "@/shared/types";

export type SummaryProjectSnapshot = {
  documents: SummaryDocument[];
};

export async function load_summary_project(
  asset_id: string,
  signal?: AbortSignal,
): Promise<SummaryProjectSnapshot> {
  return { documents: await list_summary_documents(asset_id, signal) };
}
