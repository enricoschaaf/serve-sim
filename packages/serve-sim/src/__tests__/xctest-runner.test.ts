import { describe, expect, test } from "bun:test";
import { xctestTypeTextRequest } from "../xctest-runner";

describe("XCTest text requests", () => {
  test("keeps normalized target coordinates as JSON numbers", () => {
    expect(xctestTypeTextRequest("com.green-got.dev", "azerty é", 0.25, 0.75)).toEqual({
      command: "typeText",
      bundleId: "com.green-got.dev",
      text: "azerty é",
      x: 0.25,
      y: 0.75,
    });
  });

  test("omits an incomplete target point", () => {
    expect(xctestTypeTextRequest("com.green-got.dev", "paste", 0.25)).toEqual({
      command: "typeText",
      bundleId: "com.green-got.dev",
      text: "paste",
    });
  });
});
