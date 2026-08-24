import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  create_summary_export,
  generate_summary_documents,
  get_summary_conversation,
  list_ai_models,
  list_summary_documents,
  update_summary_document,
} from "@/shared/api";
import type { MediaAsset, SummaryDocument, Transcript } from "@/shared/types";
import { SummaryWorkspace } from "./SummaryWorkspace";

vi.mock("@/components/MarkdownEditor", () => ({
  MarkdownEditor: ({
    markdown,
    on_change,
  }: {
    markdown: string;
    on_change: (markdown: string) => void;
  }) => (
    <textarea
      aria-label="可视化 Markdown"
      value={markdown}
      onChange={(event) => on_change(event.target.value)}
    />
  ),
}));

vi.mock("@/shared/api", async (import_original) => {
  const actual = await import_original<typeof import("@/shared/api")>();
  return {
    ...actual,
    create_summary_agent_run: vi.fn(),
    create_summary_child: vi.fn(),
    create_summary_export: vi.fn(),
    create_summary_media: vi.fn(),
    delete_summary_document: vi.fn(),
    generate_summary_documents: vi.fn(),
    get_summary_conversation: vi.fn(),
    list_ai_models: vi.fn(),
    list_summary_documents: vi.fn(),
    reorder_summary_children: vi.fn(),
    resolve_summary_proposal: vi.fn(),
    stream_summary_agent_run: vi.fn(),
    update_summary_document: vi.fn(),
  };
});

const ASSET: MediaAsset = {
  asset_id: "01890f4c-7a2b-7cc2-98c4-dc0c0c07398f",
  media_type: "video",
  source_url: "https://example.com/video",
  source_platform: "bilibili",
  source_video_id: "BV1test",
  title: "测试课程",
  author_name: "讲师",
  description: null,
  duration_seconds: 60,
  width: 1920,
  height: 1080,
  video_codec: "h264",
  audio_codec: "aac",
  status: "ready",
  error_message: null,
  playback_url: "/stream",
  thumbnail_url: null,
  thumbnail_storyboard: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const TRANSCRIPT: Transcript = {
  asset_id: ASSET.asset_id,
  language: "zh",
  segments: [{ start_seconds: 0, end_seconds: 5, text: "第一段" }],
  created_at: "2026-01-01T00:00:00Z",
};

const DOCUMENT: SummaryDocument = {
  document_id: "document-01890f4c7a2b7cc298c4dc0c0c07398f",
  asset_id: ASSET.asset_id,
  parent_document_id: null,
  title: "课程总结",
  markdown: "# 原内容\n",
  relative_path: "index.md",
  content_digest: "digest",
  position: 0,
  revision: 1,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

describe("SummaryWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    vi.mocked(list_ai_models).mockResolvedValue([]);
    vi.mocked(get_summary_conversation).mockResolvedValue({
      conversation: {
        conversation_id: "conversation-01890f4c7a2b7cc298c4dc0c0c07398f",
        asset_id: ASSET.asset_id,
        root_document_id: DOCUMENT.document_id,
        created_at: DOCUMENT.created_at,
        updated_at: DOCUMENT.updated_at,
      },
      messages: [],
      proposals: [],
    });
  });

  it("generates the document only after explicit confirmation", async () => {
    vi.mocked(list_summary_documents).mockResolvedValue([]);
    vi.mocked(generate_summary_documents).mockResolvedValue([DOCUMENT]);

    render(
      <SummaryWorkspace
        selected_asset={ASSET}
        segments={[]}
        transcript={TRANSCRIPT}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "生成主文档" }));

    await waitFor(() =>
      expect(generate_summary_documents).toHaveBeenCalledWith(
        ASSET.asset_id,
        expect.objectContaining({
          detail: "standard",
          create_subdocuments: false,
        }),
      ),
    );
  });

  it("auto-saves markdown with the expected revision", async () => {
    vi.mocked(list_summary_documents).mockResolvedValue([DOCUMENT]);
    vi.mocked(update_summary_document).mockResolvedValue({
      ...DOCUMENT,
      markdown: "# 新内容\n",
      revision: 2,
    });

    render(
      <SummaryWorkspace
        selected_asset={ASSET}
        segments={[]}
        transcript={TRANSCRIPT}
      />,
    );

    const editor = await screen.findByRole("textbox", {
      name: "可视化 Markdown",
    });
    fireEvent.change(editor, { target: { value: "# 新内容\n" } });

    await waitFor(
      () =>
        expect(update_summary_document).toHaveBeenCalledWith(
          DOCUMENT.document_id,
          1,
          { markdown: "# 新内容\n", title: "课程总结" },
        ),
      { timeout: 2_000 },
    );
    expect(await screen.findByText("已保存")).toBeInTheDocument();
  });

  it("saves exports in the asset directory without browser download", async () => {
    vi.mocked(list_summary_documents).mockResolvedValue([DOCUMENT]);
    vi.mocked(create_summary_export).mockResolvedValue({
      export_id: "export-01890f4c7a2b7cc298c4dc0c0c07398f",
      relative_path: "summary_output/summary-test.zip",
      file_name: "summary-test.zip",
      size_bytes: 128,
      exported_at: "2026-01-01T00:00:00+08:00",
    });

    render(
      <SummaryWorkspace
        selected_asset={ASSET}
        segments={[]}
        transcript={TRANSCRIPT}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "导出 ZIP" }));

    expect(
      await screen.findByText(/summary_output\/summary-test\.zip/),
    ).toHaveTextContent("summary_output/summary-test.zip");
    expect(create_summary_export).toHaveBeenCalledWith(ASSET.asset_id);
    expect(
      screen.queryByRole("link", { name: "导出 ZIP" }),
    ).not.toBeInTheDocument();
  });
});
