import { describe, expect, it } from "vitest";
import {
  canEditLatestStep,
  canStartOperation,
  operationCatalog,
  stepReplaysOnEngine,
  supportedOperationCatalog,
  supportsOperation,
  type FileEngine
} from "../shared/operations";
import type { SourceCapabilities } from "../shared/protocol";
import type { TransformStep } from "../shared/protocol";

const appliedStep: TransformStep = {
  id: "drop-missing",
  kind: "dropMissingRows",
  params: {}
};

const renameOnlyCapabilities: SourceCapabilities = {
  editable: true,
  lazy: false,
  cancel: false,
  exportCsv: false,
  exportParquet: false,
  notebookInsert: false,
  supportedOperations: ["renameColumn"]
};

function assertGeneratedCatalogReadonlyAtCompileTime(): void {
  // @ts-expect-error The generated catalog is readonly.
  operationCatalog.push(operationCatalog[0]!);
  // @ts-expect-error Generated operation definitions are readonly.
  operationCatalog[0]!.kind = "sortRows";
  // @ts-expect-error Generated parameter-name arrays are readonly.
  operationCatalog[0]!.required.push("rules");
  // @ts-expect-error Generated parameter-name arrays are readonly.
  operationCatalog[0]!.optional.push("newColumn");
}
void assertGeneratedCatalogReadonlyAtCompileTime;

describe("operation entry-point predicates", () => {
  it("publishes runtime-frozen parameter definitions through a readonly catalog", () => {
    expect(Object.isFrozen(operationCatalog)).toBe(true);
    expect(Reflect.set(operationCatalog, operationCatalog.length, operationCatalog[0])).toBe(false);
    for (const operation of operationCatalog) {
      expect(Object.isFrozen(operation)).toBe(true);
      expect(Object.isFrozen(operation.required)).toBe(true);
      expect(Object.isFrozen(operation.optional)).toBe(true);
      expect(Reflect.set(operation, "kind", "unexpected")).toBe(false);
      expect(Reflect.set(operation.required, 0, "unexpected")).toBe(false);
      expect(Reflect.set(operation.optional, 0, "unexpected")).toBe(false);
      const parameterNames = [...operation.required, ...operation.optional];
      expect(new Set(parameterNames).size).toBe(parameterNames.length);
    }
  });

  it("allows a new operation only for an editing session without a draft", () => {
    expect(canStartOperation({ mode: "editing", draftStep: undefined })).toBe(true);
    expect(canStartOperation({ mode: "viewing", draftStep: undefined })).toBe(false);
    expect(canStartOperation({ mode: "editing", draftStep: appliedStep })).toBe(false);
    expect(canStartOperation(undefined)).toBe(false);
  });

  it("allows native edit-latest actions only when an applied step exists and no draft is active", () => {
    expect(canEditLatestStep({ mode: "editing", draftStep: undefined, steps: [appliedStep] })).toBe(true);
    expect(canEditLatestStep({ mode: "editing", draftStep: undefined, steps: [] })).toBe(false);
    expect(canEditLatestStep({ mode: "editing", draftStep: appliedStep, steps: [appliedStep] })).toBe(false);
    expect(canEditLatestStep({ mode: "viewing", draftStep: undefined, steps: [appliedStep] })).toBe(false);
    expect(canEditLatestStep(undefined)).toBe(false);
  });

  it("narrows operation entry points only when the backend advertises a list", () => {
    expect(supportedOperationCatalog(undefined)).toEqual(
      operationCatalog.filter(({ kind }) => kind !== "extractStructFields" && kind !== "explodeList")
    );
    expect(supportsOperation(undefined, "cloneColumn")).toBe(true);
    expect(supportsOperation(undefined, "extractStructFields")).toBe(false);
    expect(supportsOperation(undefined, "explodeList")).toBe(false);
    expect(supportsOperation({ ...renameOnlyCapabilities, supportedOperations: undefined }, "explodeList")).toBe(false);
    expect(supportsOperation(renameOnlyCapabilities, "explodeList")).toBe(false);
    expect(
      supportedOperationCatalog({ ...renameOnlyCapabilities, supportedOperations: ["explodeList"] }).map(
        ({ kind }) => kind
      )
    ).toEqual(["explodeList"]);
    expect(
      supportsOperation({ ...renameOnlyCapabilities, supportedOperations: undefined }, "extractStructFields")
    ).toBe(false);
    const structCapabilities: SourceCapabilities = {
      ...renameOnlyCapabilities,
      supportedOperations: ["extractStructFields"]
    };
    expect(supportedOperationCatalog(structCapabilities).map(({ kind }) => kind)).toEqual(["extractStructFields"]);
    expect(supportedOperationCatalog(renameOnlyCapabilities).map((operation) => operation.kind)).toEqual([
      "renameColumn"
    ]);
    expect(supportsOperation(renameOnlyCapabilities, "renameColumn")).toBe(true);
    expect(supportsOperation(renameOnlyCapabilities, "castColumn")).toBe(false);
    expect(supportsOperation(renameOnlyCapabilities, "extractStructFields")).toBe(false);
    expect(canStartOperation({ mode: "editing", capabilities: renameOnlyCapabilities }, "renameColumn")).toBe(true);
    expect(canStartOperation({ mode: "editing", capabilities: renameOnlyCapabilities }, "castColumn")).toBe(false);
    expect(canEditLatestStep({ mode: "editing", capabilities: renameOnlyCapabilities, steps: [appliedStep] })).toBe(
      false
    );
  });
});

describe("stepReplaysOnEngine", () => {
  const polars: FileEngine = { backend: "polars" };
  const pandas: FileEngine = { backend: "pandas" };
  const duckdb: FileEngine = { backend: "duckdb" };
  const base: FileEngine = { backend: "r", rLibrary: "base" };
  const dplyr: FileEngine = { backend: "r", rLibrary: "dplyr" };
  const column = { id: "c:0", name: "items" };
  const custom: TransformStep = { id: "custom", kind: "customCode", params: { code: "result <- df" } };
  const struct: TransformStep = {
    id: "struct",
    kind: "extractStructFields",
    params: { column, fields: [{ field: "a", newColumn: "items_a" }] }
  };
  const explode: TransformStep = { id: "explode", kind: "explodeList", params: { column } };

  it.each([
    [custom, base, dplyr, true],
    [custom, polars, pandas, false],
    [custom, base, polars, false],
    [custom, polars, base, false],
    [struct, polars, duckdb, true],
    [struct, duckdb, base, true],
    [struct, polars, pandas, false],
    [explode, polars, base, true],
    [explode, base, polars, true],
    [explode, polars, duckdb, false],
    [explode, polars, pandas, false],
    [appliedStep, base, pandas, true]
  ] as const)("replays %j from %j on %j: %s", (step, from, to, replays) => {
    expect(stepReplaysOnEngine(step, from, to)).toBe(replays);
  });
});
