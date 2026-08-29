import { describe, expect, it } from "vitest";
import {
  canEditLatestStep,
  canStartOperation,
  operationCatalog,
  supportedOperationCatalog,
  supportsOperation
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
    expect(supportedOperationCatalog(undefined)).toBe(operationCatalog);
    expect(supportedOperationCatalog(renameOnlyCapabilities).map((operation) => operation.kind)).toEqual([
      "renameColumn"
    ]);
    expect(supportsOperation(renameOnlyCapabilities, "renameColumn")).toBe(true);
    expect(supportsOperation(renameOnlyCapabilities, "castColumn")).toBe(false);
    expect(canStartOperation({ mode: "editing", capabilities: renameOnlyCapabilities }, "renameColumn")).toBe(true);
    expect(canStartOperation({ mode: "editing", capabilities: renameOnlyCapabilities }, "castColumn")).toBe(false);
    expect(canEditLatestStep({ mode: "editing", capabilities: renameOnlyCapabilities, steps: [appliedStep] })).toBe(
      false
    );
  });
});
