import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LibraryPage } from "@/pages/LibraryPage";
import {
  list_assets,
  list_folders,
  list_summary_documents,
} from "@/shared/api";
import type { MediaAsset, SummaryDocument } from "@/shared/types";

const ASSET_ID = "019c0000-0000-7000-8000-000000000001";
const ASSET: MediaAsset = {
  asset_id: ASSET_ID,
  folder_id: null,
  media_type: "video",
  source_url: "https://example.com/video",
  source_platform: "bilibili",
  source_video_id: "video-1",
  title: "镜头语言入门",
  author_name: "开放影像课",
  description: null,
  duration_seconds: 120,
  width: 1920,
  height: 1080,
  video_codec: "h264",
  audio_codec: "aac",
  status: "ready",
  error_message: null,
  playback_url: "/stream",
  scrub_preview_url: null,
  thumbnail_url: null,
  thumbnail_storyboard: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const select_asset = vi.fn();

vi.mock("@/app/asset_catalog", () => ({
  use_asset_catalog: () => ({
    assets: [ASSET],
    select_asset,
  }),
}));

vi.mock("@/shared/api", () => ({
  create_folder: vi.fn(),
  delete_asset: vi.fn(),
  delete_folder: vi.fn(),
  list_assets: vi.fn(),
  list_folders: vi.fn(),
  list_summary_documents: vi.fn(),
  media_url: (path: string) => path,
  move_assets: vi.fn(),
  move_folder: vi.fn(),
  rename_folder: vi.fn(),
}));

describe("LibraryPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(list_folders).mockResolvedValue([]);
    vi.mocked(list_assets).mockResolvedValue([ASSET]);
  });

  it("opens the summary workspace when the cached project has documents", async () => {
    vi.mocked(list_summary_documents).mockResolvedValue([summary_document()]);
    render_page();

    fireEvent.doubleClick(
      await screen.findByRole("button", { name: /镜头语言入门/ }),
    );

    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent("/summary"),
    );
    expect(select_asset).toHaveBeenCalledWith(ASSET_ID);
    expect(list_summary_documents).toHaveBeenCalledTimes(1);
  });

  it("opens the marker UUID route when no summary document exists", async () => {
    vi.mocked(list_summary_documents).mockResolvedValue([]);
    render_page();

    fireEvent.doubleClick(
      await screen.findByRole("button", { name: /镜头语言入门/ }),
    );

    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(
        `/markers/${ASSET_ID}`,
      ),
    );
    expect(select_asset).toHaveBeenCalledWith(ASSET_ID);
  });

  it("stays on the library page and reports a project query failure", async () => {
    vi.mocked(list_summary_documents).mockRejectedValue(
      new Error("摘要不可用"),
    );
    render_page();

    fireEvent.doubleClick(
      await screen.findByRole("button", { name: /镜头语言入门/ }),
    );

    expect(await screen.findByText("摘要不可用")).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/library");
    expect(select_asset).not.toHaveBeenCalled();
  });
});

function render_page() {
  const query_client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
  });
  return render(
    <QueryClientProvider client={query_client}>
      <MemoryRouter initialEntries={["/library"]}>
        <Routes>
          <Route path="/library" element={<LibraryPage />} />
          <Route path="/summary" element={<span>解析页</span>} />
          <Route path="/markers/:asset_id" element={<span>标记页</span>} />
        </Routes>
        <Location />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function Location() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}

function summary_document(): SummaryDocument {
  return {
    document_id: "document-019c0000000070008000000000000001",
    asset_id: ASSET_ID,
    parent_document_id: null,
    title: "课程总结",
    markdown: "# 总结",
    relative_path: "summary.md",
    content_digest: "digest",
    position: 0,
    revision: 1,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}
