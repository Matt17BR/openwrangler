import { describe, expect, it } from "vitest";

import { assertRPivotWiderPreflight, schemaAfterRStep } from "../extension/r/rKernelMutationSchema";
import type { RColumnSchema } from "../extension/r/rFrameContract";
import type { ColumnSchema, PivotWiderTransformStep, TypedSelectionToken } from "../shared/protocol";
import { isTransformStep } from "../shared/protocolValidation";
import {
  MAX_PIVOT_WIDER_OUTPUTS,
  MIN_PIVOT_WIDER_OUTPUTS,
  pivotWiderKeyValue,
  portablePivotWiderNameKey,
  validatePivotWiderOutputName
} from "../shared/pivotWider";

const source = [
  { id: "c:source:0", name: "group", position: 0, type: "string", rawType: "character", nullable: false },
  { id: "c:source:1", name: "key", position: 1, type: "string", rawType: "character", nullable: false },
  { id: "c:source:2", name: "value", position: 2, type: "integer", rawType: "integer", nullable: false }
] satisfies readonly ColumnSchema[];

function key(value: string): TypedSelectionToken {
  return {
    kind: "typedSelection",
    version: 1,
    columnType: "string",
    cell: { kind: "string", raw: value, display: value, isNull: false, isNaN: false }
  };
}

function step(outputCount = MIN_PIVOT_WIDER_OUTPUTS): PivotWiderTransformStep {
  const outputs = Array.from({ length: outputCount }, (_, ordinal) => ({
    key: key(`key-${ordinal + 1}`),
    name: `value_${ordinal + 1}`
  }));
  return {
    id: "pivot-wider-contract",
    kind: "pivotWider",
    params: {
      namesFrom: { id: source[1].id, name: source[1].name },
      valuesFrom: { id: source[2].id, name: source[2].name },
      outputs: outputs as unknown as PivotWiderTransformStep["params"]["outputs"]
    }
  };
}

describe("pivot-wider public contract", () => {
  it("accepts only canonical present string keys and 2 to 64 ordered outputs", () => {
    expect(isTransformStep(step(MIN_PIVOT_WIDER_OUTPUTS))).toBe(true);
    expect(isTransformStep(step(MAX_PIVOT_WIDER_OUTPUTS))).toBe(true);
    expect(isTransformStep(step(MIN_PIVOT_WIDER_OUTPUTS - 1))).toBe(false);
    expect(isTransformStep(step(MAX_PIVOT_WIDER_OUTPUTS + 1))).toBe(false);

    const malformed = step();
    malformed.params.outputs[0]!.key.cell.display = "not-the-raw-value";
    expect(isTransformStep(malformed)).toBe(false);
    expect(() => pivotWiderKeyValue(malformed.params.outputs[0]!.key)).toThrow(/canonical present string selection/u);
  });

  it("uses the locale-independent portable output collision rule", () => {
    expect(portablePivotWiderNameKey("Value")).toBe("value");
    expect(portablePivotWiderNameKey("Straße")).toBe("strasse");
    expect(portablePivotWiderNameKey("STRASSE")).toBe("strasse");
    expect(portablePivotWiderNameKey("Å")).toBe("Å");
    expect(portablePivotWiderNameKey("å")).toBe("å");
    for (const name of ["", "bad\nname", "bad\0name", "\ud800", "x".repeat(1_025)]) {
      expect(() => validatePivotWiderOutputName(name, "Pivot output")).toThrow();
    }
  });

  it("derives retained lineage and output identities from declared ordinal", () => {
    const operation = step(3);
    expect(schemaAfterRStep(source, operation, [])).toEqual([
      source[0],
      {
        id: `c:step:${operation.id}:0`,
        name: "value_1",
        position: 1,
        type: "integer",
        rawType: "integer",
        nullable: true
      },
      {
        id: `c:step:${operation.id}:1`,
        name: "value_2",
        position: 2,
        type: "integer",
        rawType: "integer",
        nullable: true
      },
      {
        id: `c:step:${operation.id}:2`,
        name: "value_3",
        position: 3,
        type: "integer",
        rawType: "integer",
        nullable: true
      }
    ]);
  });

  it("rejects duplicate keys and output-name collisions before dispatch", () => {
    const duplicateKey = step();
    duplicateKey.params.outputs[1]!.key = duplicateKey.params.outputs[0]!.key;
    expect(isTransformStep(duplicateKey)).toBe(false);

    const duplicateName = step();
    duplicateName.params.outputs[1]!.name = "VALUE_1";
    expect(isTransformStep(duplicateName)).toBe(false);

    const retainedCollision = step();
    retainedCollision.params.outputs[0]!.name = "GROUP";
    const rSchema = source.map((column) => ({
      ...column,
      semantics:
        column.type === "integer"
          ? { kind: "integer", storageMode: "integer", classes: ["integer"] }
          : { kind: "character", storageMode: "character", classes: ["character"] }
    })) as readonly RColumnSchema[];
    expect(() => assertRPivotWiderPreflight(retainedCollision, source, rSchema, 1)).toThrow(/collision/u);
  });
});
