import { describe, expect, test } from "vitest";
import * as react from "../../src/react/index.js";

describe("the React entry: trace part", () => {
  // Spec: Kit.Trace, Surface: the React entry offers the traced figure part (check TR-surface)
  test("the React entry exports TracedValue", () => {
    expect(Object.keys(react)).toContain("TracedValue");
    expect(typeof react.TracedValue).toBe("function");
  });
});
