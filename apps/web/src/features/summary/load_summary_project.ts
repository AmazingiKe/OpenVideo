import { list_summary_documents } from "@/shared/api";
import type { SummaryDocument } from "@/shared/types";

export type SummaryProject = {
  documents: SummaryDocument[];
};

export async function load_summary_project(
  asset_id: string,
  signal?: AbortSignal,
): Promise<SummaryProject> {
  const documents = await list_summary_documents(asset_id, signal);
  return { documents };
}
