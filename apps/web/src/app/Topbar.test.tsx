import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { Topbar } from "@/app/Topbar";
import type { MediaAsset } from "@/shared/types";

const FIRST_ASSET_ID = "019c0000-0000-7000-8000-000000000001";
const SECOND_ASSET_ID = "019c0000-0000-7000-8000-000000000002";

describe("Topbar", () => {
  it("marks the current workspace link", () => {
    render(
      <MemoryRouter initialEntries={["/markers"]}>
        <Topbar assets={[]} selected_asset_id={null} />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("navigation", { name: "工作区导航" }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "标记" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "下载" })).not.toHaveAttribute(
      "aria-current",
    );
    expect(
      screen
        .getAllByRole("link")
        .filter((link) =>
          ["下载", "视频库", "标记", "解析"].includes(link.textContent ?? ""),
        )
        .map((link) => link.textContent),
    ).toEqual(["下载", "视频库", "标记", "解析"]);
  });

  it("selects a marker video through its UUID route", async () => {
    render(
      <MemoryRouter initialEntries={[`/markers/${FIRST_ASSET_ID}`]}>
        <Topbar
          assets={[
            create_asset(FIRST_ASSET_ID, "第一段视频"),
            create_asset(SECOND_ASSET_ID, "第二段视频"),
          ]}
          selected_asset_id={FIRST_ASSET_ID}
        />
        <LocationPath />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "选择标记视频" }));
    fireEvent.click(screen.getByRole("button", { name: /第二段视频/ }));

    await waitFor(() =>
      expect(screen.getByTestId("location-path")).toHaveTextContent(
        `/markers/${SECOND_ASSET_ID}`,
      ),
    );
  });
});

function LocationPath() {
  return <output data-testid="location-path">{useLocation().pathname}</output>;
}

function create_asset(asset_id: string, title: string): MediaAsset {
  return {
    asset_id,
    folder_id: null,
    media_type: "video",
    source_url: "https://example.com/video",
    source_platform: "bilibili",
    source_video_id: null,
    title,
    author_name: "示例作者",
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
}
