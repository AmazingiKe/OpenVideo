import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AgentComposer } from "./AgentComposer";
import { AGENT_CONTEXT_ATTACHMENT_MIME } from "./agent_context";

describe("AgentComposer", () => {
  it("shows an explicit removable time-range attachment", () => {
    const on_remove = vi.fn();
    render(
      <AgentComposer
        value="分析这一段"
        on_change={vi.fn()}
        on_submit={vi.fn()}
        thinking_mode="auto"
        on_thinking_mode_change={vi.fn()}
        thinking_modes_enabled={false}
        retrieval_scope="current_asset"
        on_retrieval_scope_change={vi.fn()}
        library_scope_enabled={false}
        scope_pinned={false}
        on_scope_pinned_change={vi.fn()}
        attachments={[
          {
            draft_id: "range-1",
            kind: "time_range",
            asset_id: "asset-1",
            label: "时间线理解范围",
            start_seconds: 12,
            end_seconds: 28,
          },
        ]}
        on_remove_attachment={on_remove}
      />,
    );

    expect(screen.getByText("00:12–00:28 · 按需读取证据")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "移除时间线理解范围" }));
    expect(on_remove).toHaveBeenCalledWith("range-1");
  });

  it("does not expose unimplemented routing and library controls as usable", () => {
    render(
      <AgentComposer
        value="问题"
        on_change={vi.fn()}
        on_submit={vi.fn()}
        thinking_mode="auto"
        on_thinking_mode_change={vi.fn()}
        thinking_modes_enabled={false}
        retrieval_scope="current_asset"
        on_retrieval_scope_change={vi.fn()}
        library_scope_enabled={false}
        scope_pinned={false}
        on_scope_pinned_change={vi.fn()}
        attachments={[]}
        on_remove_attachment={vi.fn()}
      />,
    );

    expect(screen.getByRole("radio", { name: "复杂思考" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "资料库" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "将资料库范围固定到当前对话" }),
    ).toBeDisabled();
    expect(
      screen.getByText(
        "当前服务仅支持自动模式和当前视频；更多能力接通后解锁。",
      ),
    ).toBeVisible();
  });

  it("shows a copy target and accepts a dragged context attachment", () => {
    const on_attachment_drop = vi.fn();
    render(
      <AgentComposer
        value="问题"
        on_change={vi.fn()}
        on_submit={vi.fn()}
        thinking_mode="auto"
        on_thinking_mode_change={vi.fn()}
        thinking_modes_enabled
        retrieval_scope="current_asset"
        on_retrieval_scope_change={vi.fn()}
        library_scope_enabled
        scope_pinned={false}
        on_scope_pinned_change={vi.fn()}
        attachments={[]}
        on_remove_attachment={vi.fn()}
        on_attachment_drop={on_attachment_drop}
      />,
    );
    const form = screen.getByRole("textbox").closest("form");
    const attachment = {
      draft_id: "attachment-draft-0198d12345677890abcdef1234567890",
      kind: "summary_selection",
      asset_id: "asset-0198d12345677890abcdef1234567890",
      label: "总结选区",
      snapshot_text: "选中的正文",
    };
    const data_transfer = {
      types: [AGENT_CONTEXT_ATTACHMENT_MIME],
      dropEffect: "none",
      getData: vi.fn((type: string) =>
        type === AGENT_CONTEXT_ATTACHMENT_MIME
          ? JSON.stringify(attachment)
          : "",
      ),
    } as unknown as DataTransfer;

    fireEvent.dragOver(form!, { dataTransfer: data_transfer });
    expect(screen.getByRole("status")).toHaveTextContent(
      "松开即可添加为可见上下文",
    );
    fireEvent.drop(form!, { dataTransfer: data_transfer });

    expect(on_attachment_drop).toHaveBeenCalledWith(attachment);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
