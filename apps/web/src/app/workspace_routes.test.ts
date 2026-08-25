import { describe, expect, it } from "vitest";

import {
  marker_asset_id,
  marker_asset_path,
  workspace_route,
} from "@/app/workspace_routes";

const ASSET_ID = "019c0000-0000-7000-8000-000000000001";

describe("workspace_routes", () => {
  it("recognizes marker UUID routes", () => {
    const path = marker_asset_path(ASSET_ID);

    expect(path).toBe(`/markers/${ASSET_ID}`);
    expect(marker_asset_id(path)).toBe(ASSET_ID);
    expect(workspace_route(path)?.path).toBe("/markers");
  });

  it("rejects nested and malformed marker asset paths", () => {
    expect(marker_asset_id("/markers/asset/extra")).toBeNull();
    expect(marker_asset_id("/markers/%E0%A4%A")).toBeNull();
  });
});
