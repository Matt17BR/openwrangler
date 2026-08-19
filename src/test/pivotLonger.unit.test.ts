import { describe, expect, it } from "vitest";

import { portablePivotLongerNameKey, validatePivotLongerOutputName } from "../shared/pivotLonger";
import { isTransformStep } from "../shared/protocolValidation";

const columns = [
  { id: "c:source:0", name: "alpha" },
  { id: "c:source:1", name: "beta" }
];

function step(labelColumn = "metric", valueColumn = "reading", selected = columns): unknown {
  return {
    id: "pivot-longer",
    kind: "pivotLonger",
    params: { columns: selected, labelColumn, valueColumn }
  };
}

describe("pivot-longer public contract", () => {
  it("uses one explicit locale-independent collision fold", () => {
    expect(portablePivotLongerNameKey("Value")).toBe("value");
    expect(portablePivotLongerNameKey("Straße")).toBe("strasse");
    expect(portablePivotLongerNameKey("STRASSE")).toBe("strasse");
    expect(portablePivotLongerNameKey("Å")).toBe("Å");
    expect(portablePivotLongerNameKey("å")).toBe("å");
  });

  it("accepts only a bounded two-output pivot contract", () => {
    expect(isTransformStep(step())).toBe(true);
    expect(isTransformStep(step("Straße", "STRASSE"))).toBe(false);
    expect(isTransformStep(step("metric", "reading", columns.slice(0, 1)))).toBe(false);
    expect(
      isTransformStep(
        step(
          "metric",
          "reading",
          Array.from({ length: 65 }, (_, index) => ({ id: `c:${index}`, name: `c${index}` }))
        )
      )
    ).toBe(false);
  });

  it("rejects multiline, invalid-scalar, NUL, and oversized output names", () => {
    for (const value of ["", "bad\nname", "bad\rname", "bad\0name", "\ud800", "x".repeat(1_025)]) {
      expect(() => validatePivotLongerOutputName(value, "Pivot output")).toThrow();
    }
    expect(() => validatePivotLongerOutputName("😀".repeat(256), "Pivot output")).not.toThrow();
    expect(() => validatePivotLongerOutputName(`😀${"x".repeat(1_021)}`, "Pivot output")).toThrow();
  });
});
