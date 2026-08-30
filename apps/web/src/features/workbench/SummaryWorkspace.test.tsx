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
  generate_summary_documents,
  list_agent_definitions,
  list_agent_sessions,
  list_ai_models,
  list_summary_documents,
  list_summary_presets,
  list_summary_versions,
  subscribe_summary_documents,
  update_summary_document,
} from "@/shared/api";
import { ApiError } from "@/shared/api/client";
import { ApplicationQueryProvider } from "@/app/query_cache";
import { GlobalAssistantProvider } from "@/app/global_assistant";
import type {
  AiModelSummary,
  MediaAsset,
  SummaryDocument,
  SummaryVersion,
  Transcript,
} from "@/shared/types";
import {
  DEFAULT_MODEL_CAPABILITY_OVERRIDES,
  unknown_model_profile,
} from "@/shared/types";
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
    create_summary_media: vi.fn(),
    delete_summary_document: vi.fn(),
    generate_summary_documents: vi.fn(),
    list_ai_models: vi.fn(),
    list_summary_documents: vi.fn(),
    list_summary_presets: vi.fn(),
    list_summary_versions: vi.fn(),
    move_summary_document: vi.fn(),
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
  scrub_preview_url: null,
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
  version_id: "summary-version-01890f4c7a2b7cc298c4dc0c0c07398f",
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

const SUMMARY_VERSION: SummaryVersion = {
  version_id: DOCUMENT.version_id,
  asset_id: ASSET.asset_id,
  preset_id: "knowledge_notes",
  preset_version: 1,
  user_input: null,
  ai_model_id: "model-1",
  detail: "standard",
  output_language: "zh-CN",
  context_summary: {
    transcript_digest: "transcript",
    marker_digest: "markers",
    event_analysis_digest: "events",
  },
  relative_path: `summary/versions/${DOCUMENT.version_id}`,
  created_at: "2026-01-01T00:00:00Z",
};

const SUMMARY_MODEL: AiModelSummary = {
  model_id: "model-1",
  name: "总结模型",
  litellm_model: "openai/test-model",
  input_modalities: ["text"],
  capabilities: { ...DEFAULT_MODEL_CAPABILITY_OVERRIDES },
  profile: unknown_model_profile("openai", "test-model"),
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
    vi.mocked(list_ai_models).mockResolvedValue([SUMMARY_MODEL]);
    vi.mocked(list_summary_versions).mockResolvedValue([SUMMARY_VERSION]);
    vi.mocked(list_summary_presets).mockResolvedValue([
      {
        preset_id: "knowledge_notes",
        title: "知识笔记",
        description: "整理完整知识结构。",
        prompt: "生成知识笔记。",
        minimum_context_tokens: 8_000,
        version: 1,
      },
    ]);
    vi.mocked(list_agent_definitions).mockResolvedValue([]);
    vi.mocked(list_agent_sessions).mockResolvedValue([]);
    vi.mocked(subscribe_summary_documents).mockReturnValue(() => undefined);
  });

  it("generates the document only after explicit confirmation", async () => {
    vi.mocked(list_summary_documents).mockResolvedValue([]);
    vi.mocked(generate_summary_documents).mockResolvedValue({
      version: SUMMARY_VERSION,
      documents: [DOCUMENT],
      context_capacity_unknown: false,
      illustration_job: null,
    });

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
          ai_model_id: "model-1",
          preset_id: "knowledge_notes",
          output_language: "zh-CN",
        }),
      ),
    );
  });

  it("reports an unknown model capacity after a successful attempt", async () => {
    vi.mocked(list_summary_documents).mockResolvedValue([]);
    vi.mocked(generate_summary_documents).mockResolvedValue({
      version: SUMMARY_VERSION,
      documents: [DOCUMENT],
      context_capacity_unknown: true,
      illustration_job: null,
    });

    render(
      <SummaryWorkspace
        selected_asset={ASSET}
        segments={[]}
        transcript={TRANSCRIPT}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "生成主文档" }));

    expect(
      await screen.findByRole("status", { name: "生成提示" }),
    ).toHaveTextContent("模型容量未知");
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

  it("keeps the local draft visible and retries from the remote revision", async () => {
    const remote_document = {
      ...DOCUMENT,
      markdown: "# 远端内容\n",
      revision: 2,
    };
    vi.mocked(list_summary_documents)
      .mockResolvedValueOnce([DOCUMENT])
      .mockResolvedValueOnce([remote_document]);
    vi.mocked(update_summary_document)
      .mockRejectedValueOnce(new ApiError("版本冲突", 409))
      .mockResolvedValueOnce({
        ...remote_document,
        markdown: "# 本地草稿\n",
        revision: 3,
      });

    render(
      <SummaryWorkspace
        selected_asset={ASSET}
        segments={[]}
        transcript={TRANSCRIPT}
      />,
    );

    fireEvent.change(
      await screen.findByRole("textbox", { name: "可视化 Markdown" }),
      { target: { value: "# 本地草稿\n" } },
    );
    expect(
      await screen.findByRole(
        "heading",
        { name: "选择要保留的文档版本" },
        { timeout: 2_500 },
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByText("# 本地草稿")).toHaveLength(2);
    expect(screen.getByText("# 远端内容")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "保留本地草稿并覆盖" }));
    await waitFor(
      () =>
        expect(update_summary_document).toHaveBeenLastCalledWith(
          DOCUMENT.document_id,
          2,
          { markdown: "# 本地草稿\n", title: DOCUMENT.title },
        ),
      { timeout: 2_000 },
    );
  });

  it("adds a selected summary passage as visible AI context", async () => {
    vi.mocked(list_summary_documents).mockResolvedValue([DOCUMENT]);

    render(
      <SummaryWorkspace
        selected_asset={ASSET}
        segments={[]}
        transcript={TRANSCRIPT}
      />,
    );

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
      markdown: "# 尚未自动保存的修改\n",
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
    fireEvent.change(editor, {
      target: { value: "# 尚未自动保存的修改\n" },
    });
    fireEvent.click(screen.getByRole("button", { name: "文档" }));
    fireEvent.click(
      await screen.findByRole("treeitem", {
        name: new RegExp(`^${CHILD_DOCUMENT.title}$`),
      }),
    );

    await waitFor(() =>
      expect(update_summary_document).toHaveBeenCalledWith(
        DOCUMENT.document_id,
        1,
        {
          markdown: "# 尚未自动保存的修改\n",
          title: DOCUMENT.title,
        },
      ),
    );
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

    render(
      <SummaryWorkspace
        selected_asset={ASSET}
        segments={[]}
        transcript={TRANSCRIPT}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "文档" }));
    fireEvent.click(
      await screen.findByRole("treeitem", {
        name: new RegExp(`^${CHILD_DOCUMENT.title}$`),
      }),
    );

    expect(await screen.findByText("可视化编辑器未能打开")).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Markdown 总结工作台" }),
    ).toBeInTheDocument();
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

    render(
      <SummaryWorkspace
        selected_asset={ASSET}
        segments={[]}
        transcript={TRANSCRIPT}
      />,
    );

    await screen.findByRole("region", { name: "Markdown 总结工作台" });
    expect(global_assistant_state.binding).toMatchObject({
      agent_id: "summary",
      asset_id: ASSET.asset_id,
      context_label: "总结文档 · 课程总结",
      context: {
        document_id: DOCUMENT.document_id,
        version_id: DOCUMENT.version_id,
      },
    });
  });

  it("saves exports in the asset directory without browser download", async () => {
    vi.mocked(list_summary_documents).mockResolvedValue([DOCUMENT]);
    vi.mocked(create_summary_export).mockResolvedValue({
      export_id: "export-01890f4c7a2b7cc298c4dc0c0c07398f",
      relative_path: "summary_output/summary-test.zip",
      version_id: DOCUMENT.version_id,
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
    expect(create_summary_export).toHaveBeenCalledWith(
      ASSET.asset_id,
      SUMMARY_VERSION.version_id,
    );
    expect(
      screen.queryByRole("link", { name: "导出 ZIP" }),
    ).not.toBeInTheDocument();
  });
});
