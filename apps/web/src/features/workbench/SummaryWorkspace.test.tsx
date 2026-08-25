import {
  act,
  fireEvent,
  render as testing_render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  create_summary_agent_session,
  create_summary_export,
  generate_summary_documents,
  get_summary_agent_session,
  list_ai_models,
  list_summary_agent_sessions,
  list_summary_documents,
  subscribe_summary_documents,
  update_summary_document,
} from "@/shared/api";
import { ApplicationQueryProvider } from "@/app/query_cache";
import type { MediaAsset, SummaryDocument, Transcript } from "@/shared/types";
import { reorder_document_ids, SummaryWorkspace } from "./SummaryWorkspace";

function render(element: ReactElement) {
  return testing_render(element, { wrapper: ApplicationQueryProvider });
}

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
    create_summary_agent_message: vi.fn(),
    create_summary_child: vi.fn(),
    create_summary_agent_session: vi.fn(),
    create_summary_export: vi.fn(),
    create_summary_media: vi.fn(),
    delete_summary_document: vi.fn(),
    generate_summary_documents: vi.fn(),
    get_summary_agent_session: vi.fn(),
    list_ai_models: vi.fn(),
    list_summary_agent_sessions: vi.fn(),
    list_summary_documents: vi.fn(),
    reorder_summary_children: vi.fn(),
    resolve_summary_proposal: vi.fn(),
    stream_summary_agent_run: vi.fn(),
    subscribe_summary_documents: vi.fn(),
    update_summary_document: vi.fn(),
  };
});

const ASSET: MediaAsset = {
  asset_id: "01890f4c-7a2b-7cc2-98c4-dc0c0c07398f",
  folder_id: null,
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
  segments: [
    {
      start_seconds: 0,
      end_seconds: 5,
      text: "第一段",
      emotion: null,
      audio_events: [],
    },
  ],
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
    vi.mocked(subscribe_summary_documents).mockReturnValue(() => undefined);
    vi.mocked(get_summary_agent_session).mockResolvedValue({
      session: {
        session_id: "session-01890f4c7a2b7cc298c4dc0c0c07398f",
        agent_type: "summary",
        title: "默认对话",
        created_at: DOCUMENT.created_at,
        updated_at: DOCUMENT.updated_at,
      },
      asset_id: ASSET.asset_id,
      root_document_id: DOCUMENT.document_id,
      events: [],
      proposals: [],
    });
    vi.mocked(list_summary_agent_sessions).mockResolvedValue([
      {
        session: {
          session_id: "session-01890f4c7a2b7cc298c4dc0c0c07398f",
          agent_type: "summary",
          title: "默认对话",
          created_at: DOCUMENT.created_at,
          updated_at: DOCUMENT.updated_at,
        },
        asset_id: ASSET.asset_id,
        root_document_id: DOCUMENT.document_id,
      },
    ]);
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

  it("explains when requested subdocuments are not suitable", async () => {
    vi.mocked(list_summary_documents).mockResolvedValue([]);
    vi.mocked(generate_summary_documents).mockResolvedValue([DOCUMENT]);

    render(
      <SummaryWorkspace
        selected_asset={ASSET}
        segments={[]}
        transcript={TRANSCRIPT}
      />,
    );

    fireEvent.click(
      await screen.findByRole("checkbox", { name: "适合时按章节拆分" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "生成主文档" }));

    expect(
      await screen.findByRole("status", { name: "已保留单一主文档" }),
    ).toHaveTextContent("当前内容不足以形成独立章节");
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

  it("refreshes a clean editor when the document event stream changes", async () => {
    vi.mocked(list_summary_documents).mockResolvedValue([DOCUMENT]);
    let publish_documents: ((documents: SummaryDocument[]) => void) | undefined;
    vi.mocked(subscribe_summary_documents).mockImplementation(
      (_asset_id, on_documents) => {
        publish_documents = on_documents;
        return () => undefined;
      },
    );

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
    act(() =>
      publish_documents?.([
        {
          ...DOCUMENT,
          markdown: "# 外部修改\n",
          revision: 2,
        },
      ]),
    );

    await waitFor(() => expect(editor).toHaveValue("# 外部修改\n"));
  });

  it("uses accessible icons for preview and source modes", async () => {
    vi.mocked(list_summary_documents).mockResolvedValue([DOCUMENT]);

    render(
      <SummaryWorkspace
        selected_asset={ASSET}
        segments={[]}
        transcript={TRANSCRIPT}
      />,
    );

    expect(
      await screen.findByRole("tab", { name: "预览模式" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "源码模式" })).toBeInTheDocument();
    expect(screen.queryByText("所见即所得")).not.toBeInTheDocument();
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

  it("creates a separate Agent history for the selected document", async () => {
    vi.mocked(list_summary_documents).mockResolvedValue([DOCUMENT]);
    vi.mocked(create_summary_agent_session).mockResolvedValue({
      session: {
        session_id: "session-01890f4c7a2b7cc298c4dc0c0c073990",
        agent_type: "summary",
        title: DOCUMENT.title,
        created_at: DOCUMENT.created_at,
        updated_at: DOCUMENT.updated_at,
      },
      asset_id: ASSET.asset_id,
      root_document_id: DOCUMENT.document_id,
      events: [],
      proposals: [],
    });

    render(
      <SummaryWorkspace
        selected_asset={ASSET}
        segments={[]}
        transcript={TRANSCRIPT}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Agent" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "新建 Agent 对话" }),
    );

    await waitFor(() =>
      expect(create_summary_agent_session).toHaveBeenCalledWith(
        ASSET.asset_id,
        DOCUMENT.document_id,
      ),
    );
  });

  it("calculates document drop positions without losing identifiers", () => {
    expect(reorder_document_ids(["a", "b", "c"], "a", "c", "after")).toEqual([
      "b",
      "c",
      "a",
    ]);
    expect(reorder_document_ids(["a", "b", "c"], "c", "a", "before")).toEqual([
      "c",
      "a",
      "b",
    ]);
  });
});
