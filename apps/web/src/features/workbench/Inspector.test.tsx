import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Inspector } from "./Inspector";


const ASSET_ID = "asset-0123456789abcdef0123456789abcdef";

describe("Inspector", () => {
  it("switches to transcript and seeks when a timestamp is selected", () => {
    const seek_to = vi.fn();
    render(
      <Inspector
        asset_id={ASSET_ID}
        transcript={{ asset_id: ASSET_ID, language: "zh", created_at: "2026-01-01", segments: [
          { start_seconds: 12, end_seconds: 18, text: "这一段需要回看。" },
        ] }}
        segments={[]}
        markers={[]}
        marker_error={null}
        on_seek={seek_to}
        on_remove_marker={vi.fn()}
        on_update_marker_tags={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "转写" }));
    fireEvent.click(screen.getByRole("button", { name: /00:12/ }));

    expect(seek_to).toHaveBeenCalledWith(12);
  });

  it("shows visual segments and seeks to the selected segment", () => {
    const seek_to = vi.fn();
    render(
      <Inspector
        asset_id={ASSET_ID}
        transcript={null}
        segments={[{
          segment_id: "segment-0123456789abcdef0123456789abcdef",
          asset_id: ASSET_ID,
          start_seconds: 30,
          end_seconds: 40,
          transcript_text: "画面中的说明。",
          speaker_name: null,
          key_frame_paths: [],
          visual_description: "人物正在演示工具。",
          ocr_text: null,
        }]}
        markers={[]}
        marker_error={null}
        on_seek={seek_to}
        on_remove_marker={vi.fn()}
        on_update_marker_tags={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /人物正在演示工具/ }));

    expect(seek_to).toHaveBeenCalledWith(30);
  });
});
