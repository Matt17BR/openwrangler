import { describe, expect, it, vi } from "vitest";
import {
  PythonRuntimeScopeRegistry,
  type PythonRuntimeScope,
  type PythonRuntimeScopeSelection
} from "../extension/pythonRuntimeScopeRegistry";

interface TestSelection extends PythonRuntimeScopeSelection {
  aborted: boolean;
}

interface TestRuntime extends PythonRuntimeScope {
  readonly pendingIds: Set<string>;
  readonly provisionalSessionIds: Set<string>;
  readonly sessionIds: Set<string>;
  readonly stoppingProcesses: Map<unknown, unknown>;
}

function runtime(key: string): TestRuntime {
  return {
    key,
    pendingIds: new Set(),
    provisionalSessionIds: new Set(),
    sessionIds: new Set(),
    stoppingProcesses: new Map(),
    leaseCount: 0,
    process: undefined,
    processStart: undefined,
    processSelection: undefined,
    processStartSelection: undefined,
    processStop: undefined,
    runtimeExitError: undefined,
    stderrBuffer: ""
  };
}

function registry(
  options: {
    max?: number;
    activeMissingSelection?: () => TestSelection | undefined;
    environmentSelections?: Map<string, TestSelection>;
    selectionEpochs?: Map<string, number>;
    slots?: Map<string, TestRuntime>;
    recency?: Map<string, number>;
    initialUseClock?: number;
    externallyOwned?: Set<string>;
    abortSelection?: (selection: TestSelection) => void;
  } = {}
): PythonRuntimeScopeRegistry<TestRuntime, TestSelection> {
  return new PythonRuntimeScopeRegistry({
    createRuntime: runtime,
    maxRetainedInactiveScopes: options.max,
    activeMissingSelection: options.activeMissingSelection ?? (() => undefined),
    environmentSelections: options.environmentSelections ?? new Map(),
    selectionEpochs: options.selectionEpochs ?? new Map(),
    slots: options.slots,
    recency: options.recency,
    initialUseClock: options.initialUseClock,
    abortSelection:
      options.abortSelection ??
      ((selection) => {
        selection.aborted = true;
      }),
    hasExternalOwnership: (candidate) => options.externallyOwned?.has(candidate.key) ?? false
  });
}

describe("PythonRuntimeScopeRegistry", () => {
  it("evicts the least-recent inactive scope without changing slot insertion order", () => {
    const selections = new Map<string, TestSelection>([
      ["old", { key: "old", aborted: false }],
      ["recent", { key: "recent", aborted: false }]
    ]);
    const epochs = new Map([
      ["old", 7],
      ["recent", 8]
    ]);
    const scopes = registry({ max: 2, environmentSelections: selections, selectionEpochs: epochs });
    const old = scopes.runtime("old");
    const recent = scopes.runtime("recent");
    const insertionOrder = [...scopes.slots.keys()];
    expect(scopes.runtime("old")).toBe(old);
    expect([...scopes.slots.keys()]).toEqual(insertionOrder);

    recent.stderrBuffer = "private diagnostic";
    recent.runtimeExitError = new Error("old failure");
    scopes.runtime("new");
    scopes.trimInactive();

    expect(scopes.slots.has("old")).toBe(true);
    expect(scopes.slots.has("recent")).toBe(false);
    expect(scopes.slots.has("new")).toBe(true);
    expect(selections.get("recent")).toBeUndefined();
    expect(epochs.has("recent")).toBe(false);
    expect(recent.stderrBuffer).toBe("");
    expect(recent.runtimeExitError).toBeUndefined();
    expect(recent.processSelection).toBeUndefined();
    expect(recent.processStartSelection).toBeUndefined();
  });

  it("permits bounded overflow only while exact scopes are leased and trims on idempotent release", () => {
    const scopes = registry({ max: 2 });
    const releaseFirst = scopes.retain(scopes.runtime("first"));
    const releaseSecond = scopes.retain(scopes.runtime("second"));
    const releaseThird = scopes.retain(scopes.runtime("third"));

    scopes.trimInactive();
    expect(scopes.slots.size).toBe(3);
    releaseFirst();
    releaseFirst();
    expect(scopes.slots.size).toBe(2);
    expect(scopes.slots.has("first")).toBe(false);
    expect([...scopes.slots.values()].every((candidate) => candidate.leaseCount === 1)).toBe(true);

    releaseSecond();
    releaseThird();
  });

  it("does not let a stale release alter a same-key replacement", () => {
    const scopes = registry({ max: 1 });
    const original = scopes.runtime("same");
    const release = scopes.retain(original);
    const replacement = runtime("same");
    scopes.slots.set(replacement.key, replacement);
    scopes.recency.set(replacement.key, 41);

    release();

    expect(original.leaseCount).toBe(0);
    expect(scopes.slots.get("same")).toBe(replacement);
    expect(scopes.recency.get("same")).toBe(41);
  });

  it("fails closed on unresolved orphan selections while removing unowned orphan metadata", () => {
    const selections = new Map<string, TestSelection>();
    const epochs = new Map<string, number>();
    const recency = new Map<string, number>();
    for (let index = 0; index < 3; index += 1) {
      epochs.set(`metadata-${index}`, index);
      recency.set(`metadata-${index}`, index);
    }
    const scopes = registry({ max: 2, environmentSelections: selections, selectionEpochs: epochs, recency });
    scopes.trimInactive();
    expect(epochs.has("metadata-0")).toBe(false);
    expect(recency.has("metadata-0")).toBe(false);

    const unresolved = { key: "unresolved", aborted: false };
    selections.set(unresolved.key, unresolved);
    epochs.set(unresolved.key, 0);
    recency.set(unresolved.key, -1);
    scopes.trimInactive();

    expect(selections.get(unresolved.key)).toBe(unresolved);
    expect(epochs.has(unresolved.key)).toBe(true);
    expect(recency.has(unresolved.key)).toBe(true);
  });

  it("retains active missing targets and externally owned scopes", () => {
    const selections = new Map<string, TestSelection>();
    const missing = { key: "missing", aborted: false };
    selections.set(missing.key, missing);
    const externallyOwned = new Set(["transport"]);
    const scopes = registry({
      max: 1,
      environmentSelections: selections,
      activeMissingSelection: () => missing,
      externallyOwned
    });
    scopes.runtime(missing.key);
    scopes.runtime("transport");
    scopes.runtime("ordinary");
    scopes.trimInactive();

    expect(scopes.slots.has(missing.key)).toBe(true);
    expect(scopes.slots.has("transport")).toBe(true);
    expect(scopes.slots.has("ordinary")).toBe(false);
  });

  it("rejects invalid retention bounds and a mismatched factory key", () => {
    expect(() => registry({ max: 0 })).toThrow(/positive safe integer/u);
    expect(() =>
      new PythonRuntimeScopeRegistry<TestRuntime, TestSelection>({
        createRuntime: () => runtime("wrong"),
        environmentSelections: new Map(),
        selectionEpochs: new Map(),
        activeMissingSelection: () => undefined,
        abortSelection: vi.fn(),
        hasExternalOwnership: () => false
      }).runtime("expected")
    ).toThrow(/wrong key/u);
  });
});
