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

    const thinking_mode_trigger = screen.getByRole("button", {
      name: "思考强度：自动",
    });
    fireEvent.click(thinking_mode_trigger);
    const thinking_mode_slider = screen.getByRole("slider", {
      name: "思考强度",
    });
    expect(thinking_mode_slider).toHaveAttribute("data-disabled");
    expect(thinking_mode_slider).toHaveAttribute("aria-valuetext", "自动");
    expect(
      screen.getByText("模型角色路由尚未接通，仅支持自动模式。"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "检索范围：当前视频" }));
    const retrieval_scope_slider = screen.getByRole("slider", {
      name: "检索范围",
    });
    expect(retrieval_scope_slider).toHaveAttribute("data-disabled");
    expect(retrieval_scope_slider).toHaveAttribute(
      "aria-valuetext",
      "当前视频",
    );
    expect(
      screen.getByRole("button", { name: "将资料库范围固定到当前对话" }),
    ).toBeDisabled();
    expect(
      screen.getByText("资料库检索尚未接通；仍可调整操作授权方式。"),
    ).toBeVisible();
  });

  it("keeps context, routing, and submit actions in one composer surface", () => {
    render(
      <AgentComposer
        value="问题"
        on_change={vi.fn()}
        on_submit={vi.fn()}
        thinking_mode="complex"
        on_thinking_mode_change={vi.fn()}
        thinking_modes_enabled
        retrieval_scope="library"
        on_retrieval_scope_change={vi.fn()}
        library_scope_enabled
        scope_pinned
        on_scope_pinned_change={vi.fn()}
        attachments={[]}
        on_remove_attachment={vi.fn()}
      />,
    );

    expect(
      document.querySelector('[data-slot="agent-composer-surface"]'),
    ).toContainElement(screen.getByRole("textbox", { name: "助手指令" }));
    expect(screen.getByRole("button", { name: "添加上下文" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "检索范围：资料库" }),
    ).toHaveTextContent("资料库");
    expect(
      screen.getByRole("button", { name: "思考强度：高" }),
    ).toHaveTextContent("高");
    expect(screen.getByRole("button", { name: "发送指令" })).toBeEnabled();
  });

  it("changes thinking mode along a horizontal slider", () => {
    const on_thinking_mode_change = vi.fn();
    render(
      <AgentComposer
        value="问题"
        on_change={vi.fn()}
        on_submit={vi.fn()}
        thinking_mode="auto"
        on_thinking_mode_change={on_thinking_mode_change}
        thinking_modes_enabled
        retrieval_scope="current_asset"
        on_retrieval_scope_change={vi.fn()}
        library_scope_enabled
        scope_pinned={false}
        on_scope_pinned_change={vi.fn()}
        attachments={[]}
        on_remove_attachment={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "思考强度：自动" }));
    fireEvent.keyDown(screen.getByRole("slider", { name: "思考强度" }), {
      key: "ArrowRight",
    });
    expect(on_thinking_mode_change).toHaveBeenCalledWith("complex");
  });

  it("adjusts retrieval permission and conversation persistence in one popover", () => {
    const on_retrieval_scope_change = vi.fn();
    const on_scope_pinned_change = vi.fn();
    const on_permission_mode_change = vi.fn();
    render(
      <AgentComposer
        value="问题"
        on_change={vi.fn()}
        on_submit={vi.fn()}
        thinking_mode="auto"
        on_thinking_mode_change={vi.fn()}
        thinking_modes_enabled
        retrieval_scope="library"
        on_retrieval_scope_change={on_retrieval_scope_change}
        library_scope_enabled
        scope_pinned={false}
        on_scope_pinned_change={on_scope_pinned_change}
        permission_mode="smart_approval"
        on_permission_mode_change={on_permission_mode_change}
        attachments={[]}
        on_remove_attachment={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "检索范围：资料库" }));
    fireEvent.click(
      screen.getByRole("button", { name: "将资料库范围固定到当前对话" }),
    );
    expect(on_scope_pinned_change).toHaveBeenCalledWith(true);

    fireEvent.keyDown(screen.getByRole("slider", { name: "检索范围" }), {
      key: "ArrowLeft",
    });
    expect(on_retrieval_scope_change).toHaveBeenCalledWith("current_asset");

    fireEvent.keyDown(screen.getByRole("slider", { name: "权限控制" }), {
      key: "ArrowRight",
    });
    expect(on_permission_mode_change).toHaveBeenCalledWith("full_access");
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
