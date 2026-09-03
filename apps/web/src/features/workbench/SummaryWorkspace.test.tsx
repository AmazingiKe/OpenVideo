import {
  act,
  fireEvent,
  render as testing_render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactElement } from "react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  create_summary_export,
  initialize_summary_document,
  list_agent_definitions,
  list_agent_sessions,
  list_summary_documents,
  subscribe_summary_documents,
  update_summary_document,
} from "@/shared/api";
import { ApiError } from "@/shared/api/client";
import { ApplicationQueryProvider } from "@/app/query_cache";
import { GlobalAssistantProvider } from "@/app/global_assistant";
import type { MediaAsset, SummaryDocument } from "@/shared/types";
import {
  delete_other_summary_drafts,
  load_latest_summary_draft,
  save_summary_draft,
  summary_draft_content_digest,
} from "@/features/summary/summary_draft_storage";
import { SummaryWorkspace } from "./SummaryWorkspace";

const global_assistant_state = vi.hoisted(() => ({
  binding: null as Record<string, unknown> | null,
  open: vi.fn(),
}));

vi.mock("@/app/global_assistant", () => ({
  GlobalAssistantProvider: ({ children }: { children: ReactNode }) => children,
  GlobalAssistantRegistration: ({
    binding,
  }: {
    binding: Record<string, unknown>;
  }) => {
    global_assistant_state.binding = binding;
    return null;
  },
  use_global_assistant_controls: () => ({
    open_assistant: global_assistant_state.open,
  }),
}));

function render(element: ReactElement) {
  return testing_render(element, { wrapper: SummaryTestProviders });
}

function SummaryTestProviders({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter initialEntries={["/summary"]}>
      <ApplicationQueryProvider>
        <GlobalAssistantProvider>{children}</GlobalAssistantProvider>
      </ApplicationQueryProvider>
    </MemoryRouter>
  );
}

const markdown_editor_state = vi.hoisted(() => ({
  failing_document_id: null as string | null,
}));

vi.mock("@/components/MarkdownEditor", () => ({
  MarkdownEditor: ({
    document_key,
    markdown,
    on_change,
    on_selection_change,
  }: {
    document_key: string;
    markdown: string;
    on_change: (markdown: string) => void;
    on_selection_change: (
      selection: {
        start: number;
        end: number;
        text: string;
      } | null,
    ) => void;
  }) => {
    if (markdown_editor_state.failing_document_id === document_key) {
      throw new Error("编辑器初始化失败");
    }
    return (
      <textarea
        aria-label="可视化 Markdown"
        value={markdown}
        onChange={(event) => on_change(event.target.value)}
        onSelect={(event) => {
          const target = event.currentTarget;
          on_selection_change(
            target.selectionStart === target.selectionEnd
              ? null
              : {
                  start: target.selectionStart,
                  end: target.selectionEnd,
                  text: target.value.slice(
                    target.selectionStart,
                    target.selectionEnd,
                  ),
                },
          );
        }}
      />
    );
  },
}));

vi.mock("@/components/MarkdownSourceEditor", () => ({
  MarkdownSourceEditor: ({
    markdown,
    on_change,
  }: {
    markdown: string;
    on_change: (markdown: string) => void;
  }) => (
    <textarea
      aria-label="Markdown 源码"
      value={markdown}
      onChange={(event) => on_change(event.target.value)}
    />
  ),
}));

vi.mock("@/shared/api", async (import_original) => {
  const actual = await import_original<typeof import("@/shared/api")>();
  return {
    ...actual,
    list_agent_definitions: vi.fn(),
    list_agent_sessions: vi.fn(),
    create_summary_child: vi.fn(),
    duplicate_summary_document: vi.fn(),
    create_summary_export: vi.fn(),
    delete_summary_document: vi.fn(),
    initialize_summary_document: vi.fn(),
    list_summary_documents: vi.fn(),
    move_summary_document: vi.fn(),
    subscribe_summary_documents: vi.fn(),
    update_summary_document: vi.fn(),
  };
});

vi.mock("@/features/summary/summary_draft_storage", async (import_original) => {
  const actual =
    await import_original<
      typeof import("@/features/summary/summary_draft_storage")
    >();
  return {
    ...actual,
    delete_other_summary_drafts: vi.fn(),
    delete_summary_draft: vi.fn(),
    load_latest_summary_draft: vi.fn(),
    save_summary_draft: vi.fn(),
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

const CHILD_DOCUMENT: SummaryDocument = {
  ...DOCUMENT,
  document_id: "document-01890f4c7a2b7cc298c4dc0c0c073990",
  parent_document_id: DOCUMENT.document_id,
  title: "第一章",
  markdown: "# 第一章\n\n子文档正文。\n",
  relative_path: "docs/first-chapter.md",
  position: 1,
};

describe("SummaryWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global_assistant_state.binding = null;
    markdown_editor_state.failing_document_id = null;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: true,
    });
    vi.mocked(list_agent_definitions).mockResolvedValue([]);
    vi.mocked(list_agent_sessions).mockResolvedValue([]);
    vi.mocked(subscribe_summary_documents).mockReturnValue(() => undefined);
    vi.mocked(load_latest_summary_draft).mockResolvedValue(null);
    vi.mocked(save_summary_draft).mockResolvedValue(undefined);
    vi.mocked(delete_other_summary_drafts).mockResolvedValue(undefined);
  });

  it("shows a retry state instead of treating a load failure as an empty project", async () => {
    vi.mocked(list_summary_documents)
      .mockRejectedValueOnce(
        new ApiError("总结索引暂时无法恢复，请稍后重试", 503),
      )
      .mockResolvedValueOnce([DOCUMENT]);

    render(<SummaryWorkspace selected_asset={ASSET} />);

    expect(await screen.findByText("总结项目暂时无法加载")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "生成主文档" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));

    expect(
      await screen.findByRole("textbox", { name: "可视化 Markdown" }),
    ).toHaveValue("# 原内容\n");
    expect(list_summary_documents).toHaveBeenCalledTimes(2);
  });

  it("opens a blank Markdown draft without a generation step", async () => {
    const draft = { ...DOCUMENT, title: ASSET.title, markdown: "" };
    vi.mocked(list_summary_documents).mockResolvedValue([]);
    vi.mocked(initialize_summary_document).mockResolvedValue(draft);

    render(<SummaryWorkspace selected_asset={ASSET} />);

    expect(
      await screen.findByRole("textbox", { name: "可视化 Markdown" }),
    ).toHaveValue("");
    expect(initialize_summary_document).toHaveBeenCalledWith(
      ASSET.asset_id,
      expect.any(AbortSignal),
    );
    expect(
      screen.queryByRole("button", { name: "生成主文档" }),
    ).not.toBeInTheDocument();
  });

  it("auto-saves markdown with client sequencing metadata", async () => {
    vi.mocked(list_summary_documents).mockResolvedValue([DOCUMENT]);
    vi.mocked(update_summary_document).mockResolvedValue({
      ...DOCUMENT,
      markdown: "# 新内容\n",
      revision: 2,
    });

    render(<SummaryWorkspace selected_asset={ASSET} />);

    const editor = await screen.findByRole("textbox", {
      name: "可视化 Markdown",
    });
    fireEvent.change(editor, { target: { value: "# 新内容\n" } });

    await waitFor(() =>
      expect(save_summary_draft).toHaveBeenCalledWith(
        expect.objectContaining({
          asset_id: ASSET.asset_id,
          document_id: DOCUMENT.document_id,
          markdown: "# 新内容\n",
        }),
      ),
    );
    await waitFor(
      () =>
        expect(update_summary_document).toHaveBeenCalledWith(
          DOCUMENT.document_id,
          { markdown: "# 新内容\n", title: "课程总结" },
          expect.objectContaining({
            operation_id: expect.stringMatching(/^summary-operation-/),
            client_id: expect.stringMatching(/^summary-client-/),
            client_sequence: expect.any(Number),
          }),
        ),
      { timeout: 2_000 },
    );
    await waitFor(() => expect(update_summary_document).toHaveBeenCalledOnce());
  });

  it("restores the newest valid crash draft and then syncs it", async () => {
    const recovered_markdown = "# 崩溃前最后输入\n";
    vi.mocked(list_summary_documents).mockResolvedValue([DOCUMENT]);
    vi.mocked(load_latest_summary_draft).mockResolvedValue({
      draft_id: "summary-draft-01890f4c7a2b7cc298c4dc0c0c073999",
      asset_id: ASSET.asset_id,
      document_id: DOCUMENT.document_id,
      client_id: "summary-client-01890f4c7a2b7cc298c4dc0c0c073998",
      title: DOCUMENT.title,
      markdown: recovered_markdown,
      updated_at: Date.now(),
      content_digest: summary_draft_content_digest(
        DOCUMENT.title,
        recovered_markdown,
      ),
      confirmed_sequence: 0,
    });
    vi.mocked(update_summary_document).mockResolvedValue({
      ...DOCUMENT,
      markdown: recovered_markdown,
      revision: 2,
    });

    render(<SummaryWorkspace selected_asset={ASSET} />);

    expect(
      await screen.findByRole("textbox", { name: "可视化 Markdown" }),
    ).toHaveValue(recovered_markdown);
    expect(screen.getByText("已恢复未保存内容")).toBeInTheDocument();
    await waitFor(() => expect(update_summary_document).toHaveBeenCalled(), {
      timeout: 2_000,
    });
    expect(delete_other_summary_drafts).toHaveBeenCalledWith(
      ASSET.asset_id,
      "summary-draft-01890f4c7a2b7cc298c4dc0c0c073999",
    );
  });

  it("keeps the local draft visible and retries with the same operation", async () => {
    vi.mocked(list_summary_documents).mockResolvedValue([DOCUMENT]);
    vi.mocked(update_summary_document)
      .mockRejectedValueOnce(new TypeError("network unavailable"))
      .mockResolvedValueOnce({
        ...DOCUMENT,
        markdown: "# 本地草稿\n",
        revision: 2,
      });

    render(<SummaryWorkspace selected_asset={ASSET} />);

    fireEvent.change(
      await screen.findByRole("textbox", { name: "可视化 Markdown" }),
      { target: { value: "# 本地草稿\n" } },
    );
    await waitFor(
      () => expect(update_summary_document).toHaveBeenCalledTimes(2),
      {
        timeout: 3_000,
      },
    );
    const first_metadata = vi.mocked(update_summary_document).mock
      .calls[0]?.[2];
    const second_metadata = vi.mocked(update_summary_document).mock
      .calls[1]?.[2];
    expect(second_metadata).toEqual(first_metadata);
    expect(
      screen.getByRole("textbox", { name: "可视化 Markdown" }),
    ).toHaveValue("# 本地草稿\n");
  });

  it("keeps editing offline and syncs immediately when the network returns", async () => {
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: false,
    });
    vi.mocked(list_summary_documents).mockResolvedValue([DOCUMENT]);
    vi.mocked(update_summary_document)
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce({
        ...DOCUMENT,
        markdown: "# 离线草稿\n",
        revision: 2,
      });
    render(<SummaryWorkspace selected_asset={ASSET} />);

    fireEvent.change(
      await screen.findByRole("textbox", { name: "可视化 Markdown" }),
      { target: { value: "# 离线草稿\n" } },
    );
    expect(
      await screen.findByText("已保存在本机，暂未同步"),
    ).toBeInTheDocument();

    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: true,
    });
    window.dispatchEvent(new Event("online"));
    await waitFor(() =>
      expect(update_summary_document).toHaveBeenCalledTimes(2),
    );
  });

  it("flushes the queue with Ctrl+S and confirms the save", async () => {
    vi.mocked(list_summary_documents).mockResolvedValue([DOCUMENT]);
    vi.mocked(update_summary_document).mockResolvedValue({
      ...DOCUMENT,
      markdown: "# 手动保存\n",
      revision: 2,
    });
    render(<SummaryWorkspace selected_asset={ASSET} />);

    fireEvent.change(
      await screen.findByRole("textbox", { name: "可视化 Markdown" }),
      { target: { value: "# 手动保存\n" } },
    );
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });

    expect(await screen.findByText("系统已保存")).toBeInTheDocument();
  });

  it("adds a selected summary passage as visible AI context", async () => {
    vi.mocked(list_summary_documents).mockResolvedValue([DOCUMENT]);

    render(<SummaryWorkspace selected_asset={ASSET} />);

    const source = await screen.findByRole("textbox", {
      name: "可视化 Markdown",
    });
    fireEvent.select(source, {
      target: { selectionStart: 0, selectionEnd: 6 },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /将课程总结选区添加给 AI/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "助手" }));

    await waitFor(() =>
      expect(global_assistant_state.binding).toMatchObject({
        context_attachments: [
          expect.objectContaining({ label: "课程总结选区" }),
        ],
      }),
    );
    expect(global_assistant_state.open).toHaveBeenCalledOnce();
  });

  it("opens a generated child document with its markdown", async () => {
    vi.mocked(list_summary_documents).mockResolvedValue([
      DOCUMENT,
      CHILD_DOCUMENT,
    ]);

    render(<SummaryWorkspace selected_asset={ASSET} />);

    const editor = await screen.findByRole("textbox", {
      name: "可视化 Markdown",
    });
    fireEvent.click(screen.getByRole("button", { name: "文档" }));
    fireEvent.click(
      await screen.findByRole("treeitem", {
        name: new RegExp(`^${CHILD_DOCUMENT.title}$`),
      }),
    );

    await waitFor(() => expect(editor).toHaveValue(CHILD_DOCUMENT.markdown));
    expect(screen.getByLabelText("文档标题")).toHaveValue(CHILD_DOCUMENT.title);
  });

  it("saves pending edits before opening another document", async () => {
    vi.mocked(list_summary_documents).mockResolvedValue([
      DOCUMENT,
      CHILD_DOCUMENT,
    ]);
    vi.mocked(update_summary_document).mockResolvedValue({
      ...DOCUMENT,
      markdown: "# 尚未自动保存的修改",
      revision: 2,
    });

    render(<SummaryWorkspace selected_asset={ASSET} />);

    const editor = await screen.findByRole("textbox", {
      name: "可视化 Markdown",
    });
    fireEvent.change(editor, {
      target: { value: "# 尚未自动保存的修改" },
    });
    fireEvent.click(screen.getByRole("button", { name: "文档" }));
    fireEvent.click(
      await screen.findByRole("treeitem", {
        name: new RegExp(`^${CHILD_DOCUMENT.title}$`),
      }),
    );

    await waitFor(() =>
      expect(update_summary_document).toHaveBeenLastCalledWith(
        DOCUMENT.document_id,
        {
          markdown: "# 尚未自动保存的修改",
          title: DOCUMENT.title,
        },
        expect.objectContaining({
          operation_id: expect.stringMatching(/^summary-operation-/),
          client_id: expect.stringMatching(/^summary-client-/),
        }),
      ),
    );
    expect(update_summary_document).toHaveBeenCalledOnce();
    await waitFor(() => expect(editor).toHaveValue(CHILD_DOCUMENT.markdown));
  });

  it("keeps the workspace available when the visual editor fails", async () => {
    vi.mocked(list_summary_documents).mockResolvedValue([
      DOCUMENT,
      CHILD_DOCUMENT,
    ]);
    markdown_editor_state.failing_document_id = CHILD_DOCUMENT.document_id;
    const console_error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    render(<SummaryWorkspace selected_asset={ASSET} />);

    fireEvent.click(await screen.findByRole("button", { name: "文档" }));
    fireEvent.click(
      await screen.findByRole("treeitem", {
        name: new RegExp(`^${CHILD_DOCUMENT.title}$`),
      }),
    );

    expect(await screen.findByText("可视化编辑器未能打开")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("region", { name: "Markdown 总结工作台" }),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "使用源码模式" }));
    expect(
      await screen.findByRole("textbox", { name: "Markdown 源码" }),
    ).toHaveValue(CHILD_DOCUMENT.markdown);
    console_error.mockRestore();
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

    render(<SummaryWorkspace selected_asset={ASSET} />);

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

    render(<SummaryWorkspace selected_asset={ASSET} />);

    expect(
      await screen.findByRole("tab", { name: "预览模式" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "源码模式" })).toBeInTheDocument();
    expect(screen.queryByText("所见即所得")).not.toBeInTheDocument();
  });

  it("binds the desktop editor to the single global assistant", async () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    vi.mocked(list_summary_documents).mockResolvedValue([DOCUMENT]);

    render(<SummaryWorkspace selected_asset={ASSET} />);

    await screen.findByRole("region", { name: "Markdown 总结工作台" });
    expect(global_assistant_state.binding).toMatchObject({
      agent_id: "summary",
      asset_id: ASSET.asset_id,
      context_label: "当前视频 · 全部总结章节",
      context: { workspace: "summary" },
      focus_context: {
        workspace: "summary",
        surface: "summary_document",
        label: "总结文档 · 第 1 章 · 课程总结",
        document: {
          document_id: DOCUMENT.document_id,
          index: 1,
          title: DOCUMENT.title,
          revision: DOCUMENT.revision,
        },
      },
    });
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

    render(<SummaryWorkspace selected_asset={ASSET} />);

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
