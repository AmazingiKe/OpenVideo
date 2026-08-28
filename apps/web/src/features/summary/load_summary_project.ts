import { list_summary_documents, list_summary_versions } from "@/shared/api";
import type { SummaryDocument, SummaryVersion } from "@/shared/types";

export type SummaryProject = {
  documents: SummaryDocument[];
  versions: SummaryVersion[];
  current_version_id: string | null;
};

export async function load_summary_project(
  asset_id: string,
  signal?: AbortSignal,
): Promise<SummaryProject> {
  const [versions, documents] = await Promise.all([
    list_summary_versions(asset_id, signal),
    list_summary_documents(asset_id, null, signal),
  ]);
  return {
    documents,
    versions,
    current_version_id: documents[0]?.version_id ?? null,
  };
}
