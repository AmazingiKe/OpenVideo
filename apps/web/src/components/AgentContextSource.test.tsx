import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AgentContextSource } from "./AgentContextSource";

const ATTACHMENT = {
  draft_id: "attachment-draft-0198d12345677890abcdef1234567890",
  kind: "time_range" as const,
  asset_id: "asset-0198d12345677890abcdef1234567890",
  label: "时间线理解范围",
  start_seconds: 12,
  end_seconds: 20,
};

describe("AgentContextSource", () => {
  it("adds a renewed visible attachment by click", () => {
    const on_add = vi.fn();
    render(<AgentContextSource attachment={ATTACHMENT} on_add={on_add} />);

    fireEvent.click(
      screen.getByRole("button", { name: "添加时间线理解范围上下文" }),
    );

    expect(on_add).toHaveBeenCalledOnce();
    expect(on_add.mock.calls[0]?.[0]).toMatchObject({
      kind: "time_range",
      asset_id: ATTACHMENT.asset_id,
    });
    expect(on_add.mock.calls[0]?.[0].draft_id).not.toBe(ATTACHMENT.draft_id);
  });
});
