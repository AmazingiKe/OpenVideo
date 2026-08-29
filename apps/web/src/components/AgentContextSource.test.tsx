import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AGENT_CONTEXT_ATTACHMENT_MIME } from "./agent_context";
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

    fireEvent.click(screen.getByRole("button", { name: /添加给 AI/ }));

    expect(on_add).toHaveBeenCalledOnce();
    expect(on_add.mock.calls[0]?.[0]).toMatchObject({
      kind: "time_range",
      asset_id: ATTACHMENT.asset_id,
    });
    expect(on_add.mock.calls[0]?.[0].draft_id).not.toBe(ATTACHMENT.draft_id);
  });

  it("writes the attachment protocol when dragged", () => {
    const values = new Map<string, string>();
    const data_transfer = {
      effectAllowed: "none",
      setData: vi.fn((type: string, value: string) => values.set(type, value)),
    } as unknown as DataTransfer;
    render(<AgentContextSource attachment={ATTACHMENT} on_add={vi.fn()} />);

    fireEvent.dragStart(screen.getByRole("button", { name: /添加给 AI/ }), {
      dataTransfer: data_transfer,
    });

    const encoded = values.get(AGENT_CONTEXT_ATTACHMENT_MIME);
    expect(JSON.parse(encoded ?? "{}")).toMatchObject({
      kind: "time_range",
      asset_id: ATTACHMENT.asset_id,
    });
    expect(data_transfer.effectAllowed).toBe("copy");
  });
});
