import { describe, expect, test } from "vitest";
import * as react from "../../src/react/index.js";

describe("the React entry: plan value parts", () => {
  // Spec: Kit.PlanValue, Surface: the React entry offers the bar, the bullet, the list, the style part and the style sheet (check PV-surface)
  test("the React entry exports the five plan value names", () => {
    const names = Object.keys(react);
    for (const name of ["PlanValueBar", "PlanValueBullet", "PlanValueList", "PlanValueStyle", "PLAN_VALUE_CSS"]) {
      expect(names, name).toContain(name);
    }
    expect(typeof react.PlanValueBar).toBe("function");
    expect(typeof react.PlanValueBullet).toBe("function");
    expect(typeof react.PlanValueList).toBe("function");
    expect(typeof react.PlanValueStyle).toBe("function");
    expect(typeof react.PLAN_VALUE_CSS).toBe("string");
  });
});
