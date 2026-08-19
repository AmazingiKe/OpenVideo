import { describe, expect, it } from "vitest";

import { uuid7 } from "./identifiers";


const uuid7_pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("uuid7", () => {
  it("produces RFC 9562 v7 formatted identifiers", () => {
    for (let index = 0; index < 200; index += 1) {
      expect(uuid7()).toMatch(uuid7_pattern);
    }
  });

  it("is unique across bulk generation", () => {
    const values = new Set(Array.from({ length: 2000 }, () => uuid7()));
    expect(values.size).toBe(2000);
  });
});
