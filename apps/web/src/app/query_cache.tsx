import {
  QueryClient,
  QueryClientProvider,
  type QueryKey,
} from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

const QUERY_STALE_TIME_MS = 60_000;
const QUERY_CACHE_RETENTION_MS = 30 * 60_000;

export const RESOURCE_QUERY_KEYS = {
  assets: ["assets"] as const,
  library_folders: ["library_folders"] as const,
  asset_analysis: (asset_id: string | null) =>
    ["asset_analysis", asset_id] as const,
  asset_markers: (asset_id: string | null) =>
    ["asset_markers", asset_id] as const,
  markers_page_settings: ["markers_page_settings"] as const,
  ai_models: ["ai_models"] as const,
  preferences: ["preferences"] as const,
  transcription_resources: ["transcription_resources"] as const,
  download_health: ["download_health"] as const,
  download_accounts: ["download_accounts"] as const,
  summary_project: (asset_id: string | null) =>
    ["summary_project", asset_id] as const,
} satisfies Record<string, QueryKey | ((value: string | null) => QueryKey)>;

export function ApplicationQueryProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [query_client] = useState(create_query_client);
  return (
    <QueryClientProvider client={query_client}>{children}</QueryClientProvider>
  );
}

function create_query_client(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: QUERY_STALE_TIME_MS,
        gcTime: QUERY_CACHE_RETENTION_MS,
        refetchOnWindowFocus: false,
        retry: false,
      },
    },
  });
}
