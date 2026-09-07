import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, waitFor, within } from "storybook/test";

import { unknown_model_profile, type AiModelSummary } from "@/shared/types";
import { AgentComposer } from "./AgentComposer";
import {
  renew_context_attachment_draft,
  type AgentContextAttachmentDraft,
} from "./agent_context";
import { MarkdownEditor, type MarkdownSelection } from "./MarkdownEditor";
import { MarkdownSourceEditor } from "./MarkdownSourceEditor";

const MODEL_ID = "model-019c012345677abc8123456789abcdef";
const SECONDARY_MODEL_ID = "model-019c012345677abc8123456789abcdee";
const MODEL: AiModelSummary = {
  model_id: MODEL_ID,
  name: "5.6 Sol",
  litellm_model: "openai/gpt-5.6-sol",
  input_modalities: ["text", "image"],
  capabilities: {
    tools: "auto",
    reasoning: "auto",
    vision: "auto",
    structured_output: "auto",
    streaming_tools: "auto",
    reasoning_tools: "auto",
    tool_choice_auto: "auto",
    tool_choice_required: "auto",
    tool_choice_named: "auto",
    parallel_tools: "auto",
    vision_tools: "auto",
  },
  profile: unknown_model_profile("openai", "gpt-5.6-sol"),
};
const MODELS: AiModelSummary[] = [
  MODEL,
  {
    ...MODEL,
    model_id: SECONDARY_MODEL_ID,
    name: "5.6 Terra",
    litellm_model: "openai/gpt-5.6-terra",
    profile: unknown_model_profile("openai", "gpt-5.6-terra"),
  },
];

const meta = {
  title: "Assistant/AgentComposer",
  component: AgentComposer,
  args: {
    value: "",
    on_change: fn(),
    on_submit: fn(),
    models: MODELS,
    model_id: MODEL_ID,
    on_model_change: fn(),
    thinking_mode: "auto",
    on_thinking_mode_change: fn(),
    thinking_modes_enabled: true,
    retrieval_scope: "current_asset",
    on_retrieval_scope_change: fn(),
    library_scope_enabled: true,
    scope_pinned: false,
    on_scope_pinned_change: fn(),
    permission_mode: "smart_approval",
    on_permission_mode_change: fn(),
    attachments: [],
    on_remove_attachment: fn(),
    on_add_attachment: fn(),
    placeholder: "随心输入",
  },
  decorators: [
    (Story) => (
      <div className="flex min-h-160 w-full max-w-96 items-end bg-background p-4 text-foreground">
        <div className="w-full">
          <Story />
        </div>
      </div>
    ),
  ],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof AgentComposer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvas }) => {
    const scope_status = canvas.getByText("当前视频", {
      selector: '[data-slot="badge"]',
    });
    const permission_status = canvas.getByLabelText("权限状态：仅风险询问");
    const composer = canvas.getByRole("textbox", { name: "助手指令" });
    await expect(
      scope_status.compareDocumentPosition(permission_status) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await expect(
      scope_status.compareDocumentPosition(composer) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await expect(
      canvas.getByRole("button", {
        name: "检索与权限：当前视频，仅风险询问",
      }),
    ).toBeVisible();
  },
};

export const WithContext: Story = {
  args: {
    value: "分析这段内容并整理关键结论",
    thinking_mode: "complex",
    retrieval_scope: "library",
    scope_pinned: true,
    attachments: [
      {
        draft_id: "range-019c012345677abc8123456789abcdef",
        kind: "time_range",
        asset_id: "019c0123-4567-7abc-8123-456789abcdef",
        label: "时间线理解范围",
        start_seconds: 12,
        end_seconds: 28,
      },
    ],
  },
};

export const AddSelectedContext: Story = {
  render: function SelectedContextComposer(args) {
    const [attachments, set_attachments] = useState(args.attachments);
    return (
      <AgentComposer
        {...args}
        attachments={attachments}
        on_add_attachment={(attachment) =>
          set_attachments((current) => [...current, attachment])
        }
        on_remove_attachment={(draft_id) =>
          set_attachments((current) =>
            current.filter((item) => item.draft_id !== draft_id),
          )
        }
      />
    );
  },
  args: {
    context_sources: [
      {
        draft_id: "transcript-selection-preview",
        kind: "transcript_selection",
        asset_id: "asset-019c012345677abc8123456789abcdef",
        label: "字幕选区（2 条）",
        snapshot_text: "介绍数据结构。继续说明顺序存储。",
        start_seconds: 12,
        end_seconds: 20,
      },
    ],
  },
  play: async ({ canvasElement, userEvent }) => {
    const story = within(canvasElement.ownerDocument.body);
    await userEvent.click(story.getByRole("button", { name: "添加上下文" }));
    await userEvent.click(
      story.getByRole("button", { name: "添加字幕选区（2 条）上下文" }),
    );
    expect(
      story.getByRole("button", { name: "移除字幕选区（2 条）" }),
    ).toBeVisible();
    await waitFor(() =>
      expect(
        story.queryByRole("button", { name: "添加字幕选区（2 条）上下文" }),
      ).toBeNull(),
    );
    await userEvent.click(
      story.getByRole("button", { name: "移除字幕选区（2 条）" }),
    );
    await userEvent.click(story.getByRole("button", { name: "添加上下文" }));
    await userEvent.click(
      story.getByRole("button", { name: "添加字幕选区（2 条）上下文" }),
    );
    expect(
      story.getByRole("button", { name: "移除字幕选区（2 条）" }),
    ).toBeVisible();
  },
};

export const SummarySelectionContext: Story = {
  render: function SummaryContextComposer(args, context) {
    const [selection, set_selection] = useState<MarkdownSelection | null>(null);
    const [attachments, set_attachments] = useState<
      AgentContextAttachmentDraft[]
    >([]);
    const source: AgentContextAttachmentDraft | null = selection?.text.trim()
      ? {
          draft_id: "summary-selection-preview",
          asset_id: "asset-019c012345677abc8123456789abcdef",
          kind: "summary_selection",
          label: "总结文字选区",
          snapshot_text: selection.text,
          selection_start: selection.start,
          selection_end: selection.end,
        }
      : null;
    function add_context(attachment: AgentContextAttachmentDraft) {
      args.on_add_attachment?.(attachment);
      set_attachments((current) => [...current, attachment]);
    }
    const on_add_context = source
      ? () => add_context(renew_context_attachment_draft(source))
      : undefined;
    return (
      <div className="flex flex-col gap-4">
        <div className="flex h-48 overflow-hidden rounded-lg border">
          {context.parameters.source_mode ? (
            <MarkdownSourceEditor
              markdown="数据结构决定数据的组织方式。"
              on_change={() => undefined}
              on_selection_change={set_selection}
              on_add_context={on_add_context}
            />
          ) : (
            <MarkdownEditor
              document_key="summary-context-story"
              markdown="数据结构决定数据的组织方式。"
              on_change={() => undefined}
              on_selection_change={set_selection}
              on_add_context={on_add_context}
            />
          )}
        </div>
        <AgentComposer
          {...args}
          attachments={attachments}
          context_sources={source ? [source] : []}
          on_add_attachment={add_context}
          on_remove_attachment={(draft_id) =>
            set_attachments((current) =>
              current.filter((item) => item.draft_id !== draft_id),
            )
          }
        />
      </div>
    );
  },
  play: async ({ args, canvasElement, userEvent, parameters }) => {
    const story = within(canvasElement.ownerDocument.body);
    const editor = parameters.source_mode
      ? canvasElement.querySelector<HTMLElement>(".cm-content")!
      : await story.findByLabelText("Markdown 文档编辑器");
    await userEvent.click(editor);
    await userEvent.keyboard("{Control>}a{/Control}");
    await userEvent.click(story.getByRole("button", { name: "添加上下文" }));
    await userEvent.click(
      story.getByRole("button", { name: "添加总结文字选区上下文" }),
    );
    expect(args.on_add_attachment).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshot_text: "数据结构决定数据的组织方式。",
      }),
    );
    await userEvent.click(
      story.getByRole("button", { name: "移除总结文字选区" }),
    );
    await userEvent.click(editor);
    await userEvent.keyboard("{Control>}a{/Control}");
    await userEvent.pointer({ target: editor, keys: "[MouseRight]" });
    await userEvent.click(story.getByRole("menuitem", { name: "添加上下文" }));
    expect(
      await story.findByRole("button", { name: "移除总结文字选区" }),
    ).toBeVisible();
    expect(args.on_add_attachment).toHaveBeenCalledTimes(2);
  },
};

export const SummarySourceSelectionContext: Story = {
  ...SummarySelectionContext,
  parameters: { source_mode: true },
};

export const Streaming: Story = {
  args: {
    value: "继续补充一个例子",
    pending: true,
    on_cancel: fn(),
  },
};

export const FullAccessStatus: Story = {
  args: {
    permission_mode: "full_access",
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByLabelText("权限状态：完全访问")).toHaveAttribute(
      "data-variant",
      "destructive",
    );
  },
};

export const SlashCommands: Story = {
  render: function CommandComposer(args) {
    const [value, set_value] = useState(args.value);
    return <AgentComposer {...args} value={value} on_change={set_value} />;
  },
  args: {
    value: "/",
    commands: [
      {
        name: "修正选中字幕",
        label: "快速修正选中字幕",
        description: "结合整段上下文修正错字、漏字和专业术语",
        task_input: { intent: "transcript_edit", segment_indices: [3, 4] },
      },
      {
        name: "处理全部字幕",
        label: "处理全部字幕",
        description: "在命令后说明修正、翻译或术语统一要求",
        task_input: { intent: "transcript_edit", segment_indices: null },
        instruction_required: true,
      },
    ],
  },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await waitFor(() =>
      expect(canvas.getByRole("listbox", { name: "助手命令" })).toBeVisible(),
    );
    await expect(
      canvas.getByRole("option", { name: /修正选中字幕/ }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("option", { name: /处理全部字幕/ }),
    ).toBeVisible();
    const composer = canvas.getByRole("textbox", { name: "助手指令" });
    await userEvent.click(composer);
    await userEvent.clear(composer);
    await userEvent.type(composer, "/模型");
    await userEvent.keyboard("{Enter}");
    await waitFor(() =>
      expect(
        canvas.getByRole("dialog", { name: "模型与思考强度" }),
      ).toBeVisible(),
    );
    await expect(composer).toHaveValue("");
  },
};

export const SlashCommandsEmpty: Story = {
  args: { value: "/不存在的指令" },
  render: SlashCommands.render,
};

export const CompactControls: Story = {
  args: {
    thinking_modes_enabled: false,
    library_scope_enabled: false,
  },
  play: async ({ canvas, canvasElement, userEvent }) => {
    const trigger = canvas.getByRole("button", {
      name: "模型与思考强度：5.6 Sol，自动",
    });
    await userEvent.click(trigger);
    const page = within(canvasElement.ownerDocument.body);
    const popover = page.getByRole("dialog", { name: "模型与思考强度" });
    const slider = within(popover).getByRole("slider", { name: "思考强度" });
    await expect(slider).toHaveAttribute("data-disabled");
    await expect(slider).toHaveAttribute("aria-valuetext", "自动");
  },
};

export const StrengthSelector: Story = {
  args: { thinking_mode: "auto" },
  play: async ({ canvas, canvasElement, userEvent }) => {
    const trigger = canvas.getByRole("button", {
      name: "模型与思考强度：5.6 Sol，自动",
    });
    await expect(trigger).toHaveTextContent("5.6 Sol自动");
    await userEvent.click(trigger);
    const page = within(canvasElement.ownerDocument.body);
    const popover = page.getByRole("dialog", { name: "模型与思考强度" });
    await expect(popover).toHaveTextContent("5.6 Sol");
    const model_select = within(popover).getByRole("combobox", {
      name: "执行模型",
    });
    await userEvent.click(model_select);
    await userEvent.click(
      await page.findByRole("option", { name: /5\.6 Terra/ }),
    );
    await expect(meta.args.on_model_change).toHaveBeenCalledWith(
      SECONDARY_MODEL_ID,
    );
    await expect(
      within(popover).getByRole("slider", { name: "思考强度" }),
    ).toHaveAttribute("aria-valuetext", "自动");
  },
};

export const RetrievalPermissions: Story = {
  args: {
    retrieval_scope: "library",
    scope_pinned: true,
  },
  play: async ({ canvas, canvasElement, userEvent }) => {
    const trigger = canvas.getByRole("button", {
      name: "检索与权限：资料库，仅风险询问",
    });
    await expect(
      canvas.getByText("资料库", { selector: '[data-slot="badge"]' }),
    ).toBeVisible();
    await userEvent.click(trigger);
    const page = within(canvasElement.ownerDocument.body);
    const popover = page.getByRole("dialog", { name: "检索与权限" });
    await expect(
      within(popover).getByRole("slider", { name: "检索范围" }),
    ).toHaveAttribute("aria-valuetext", "资料库");
    await expect(
      within(popover).getByRole("slider", { name: "权限控制" }),
    ).toHaveAttribute("aria-valuetext", "仅风险询问");
    await expect(
      within(popover).getByRole("button", {
        name: "将资料库范围固定到当前对话",
      }),
    ).toHaveAttribute("aria-pressed", "true");
  },
};
