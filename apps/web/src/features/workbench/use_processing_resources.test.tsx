import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Preferences } from "@/shared/types";
import { use_agent_preferences } from "./use_processing_resources";

const api = vi.hoisted(() => ({
  get_preferences: vi.fn(),
  list_ai_models: vi.fn(),
  list_transcription_models: vi.fn(),
  update_preferences: vi.fn(),
}));

vi.mock("@/shared/api", () => api);

const preferences: Preferences = {
  tools_directory: null,
  models_directory: null,
  download_proxy: null,
  default_transcription: {
    engine: "faster-whisper",
    model: "small",
    language: "zh",
    device: "cpu",
    compute_type: "int8",
  },
  ai_models: [],
  agent: {
    permission_mode: "smart_approval",
    fast_model_id: null,
    complex_model_id: null,
    vision_model_id: null,
    default_thinking_mode: "auto",
    max_concurrent_runs: 4,
    always_allowed_grants: [],
  },
  managed_fields: [],
  library_path_managed: false,
};

describe("use_agent_preferences", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.get_preferences.mockResolvedValue(preferences);
    api.update_preferences.mockImplementation(
      async ({ agent }: Pick<Preferences, "agent">) => ({
        ...preferences,
        agent,
      }),
    );
  });

  it("persists permission changes from the assistant control", async () => {
    const query_client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={query_client}>
        {children}
      </QueryClientProvider>
    );
    const { result } = renderHook(use_agent_preferences, { wrapper });

    await waitFor(() =>
      expect(result.current.agent_preferences?.permission_mode).toBe(
        "smart_approval",
      ),
    );

    act(() => result.current.set_permission_mode("full_access"));

    await waitFor(() =>
      expect(result.current.agent_preferences?.permission_mode).toBe(
        "full_access",
      ),
    );
    await waitFor(() =>
      expect(result.current.permission_mode_saving).toBe(false),
    );
    expect(api.update_preferences).toHaveBeenCalledWith({
      agent: { ...preferences.agent, permission_mode: "full_access" },
    });
  });
});
