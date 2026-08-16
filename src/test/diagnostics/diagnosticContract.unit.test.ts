import { describe, expect, it } from "vitest";
import {
  createOfflineDiagnosticBundle,
  DiagnosticContractError,
  DiagnosticLedger,
  DIAGNOSTIC_CODE_CONTRACT,
  OFFLINE_DIAGNOSTIC_EVENT_CAPACITY,
  OFFLINE_DIAGNOSTIC_MAX_BYTES,
  OFFLINE_DIAGNOSTIC_SCHEMA,
  type DiagnosticCategory,
  type DiagnosticCode
} from "../../extension/diagnostics/diagnosticContract";

const metadata = Object.freeze({
  extensionVersion: "1.99.4-preview.17",
  editor: "vscode",
  editorVersion: "1.130.0-insider.2",
  platform: "linux",
  remote: false,
  workspaceTrusted: true,
  protocolVersion: 2
});

function nextRandom(state: number): number {
  return (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
}

describe("offline diagnostic contract", () => {
  it("accepts only fixed category/code observations and rejects free-form fields", () => {
    const ledger = new DiagnosticLedger();
    expect(ledger.record({ category: "recovery", code: "success", recoverable: true })).toEqual({
      sequence: 1,
      category: "recovery",
      code: "success",
      recoverable: true
    });

    for (const field of ["message", "detail", "path", "source", "environment", "stdout", "stderr"]) {
      expect(() =>
        ledger.record({ category: "request", code: "failure", recoverable: true, [field]: "PRIVATE-CANARY" })
      ).toThrow(DiagnosticContractError);
    }
    expect(() => ledger.record({ category: "runtime", code: "success", recoverable: true })).toThrow(
      DiagnosticContractError
    );
    expect(() => ledger.record({ category: "private", code: "failure", recoverable: true })).toThrow(
      DiagnosticContractError
    );
  });

  it("retains one fixed event window while preserving bounded aggregate counters", () => {
    const ledger = new DiagnosticLedger();
    for (let index = 0; index < OFFLINE_DIAGNOSTIC_EVENT_CAPACITY + 12; index += 1) {
      ledger.record({ category: "runtime", code: index % 2 === 0 ? "start" : "ready", recoverable: true });
    }

    const capture = ledger.snapshot();
    expect(capture.totalObserved).toBe(OFFLINE_DIAGNOSTIC_EVENT_CAPACITY + 12);
    expect(capture.dropped).toBe(12);
    expect(capture.events).toHaveLength(OFFLINE_DIAGNOSTIC_EVENT_CAPACITY);
    expect(capture.events[0].sequence).toBe(13);
    expect(capture.events.at(-1)?.sequence).toBe(OFFLINE_DIAGNOSTIC_EVENT_CAPACITY + 12);
    expect(capture.counters).toEqual([
      { category: "runtime", code: "start", count: 70 },
      { category: "runtime", code: "ready", count: 70 }
    ]);
    expect(Object.isFrozen(capture)).toBe(true);
    expect(Object.isFrozen(capture.events)).toBe(true);
  });

  it("serializes deterministically under the fixed UTF-8 budget without private fields", () => {
    const ledger = new DiagnosticLedger();
    const pairs = Object.entries(DIAGNOSTIC_CODE_CONTRACT).flatMap(([category, codes]) =>
      codes.map((code) => ({ category: category as DiagnosticCategory, code: code as DiagnosticCode }))
    );
    let state = 0x5eedc0de;
    for (let index = 0; index < 5_000; index += 1) {
      state = nextRandom(state);
      const pair = pairs[state % pairs.length];
      ledger.record({ ...pair, recoverable: (state & 1) === 0 });
    }

    const first = createOfflineDiagnosticBundle(metadata, ledger.snapshot());
    const second = createOfflineDiagnosticBundle(metadata, ledger.snapshot());
    expect(first.json).toBe(second.json);
    expect(first.byteLength).toBe(Buffer.byteLength(first.json, "utf8"));
    expect(first.byteLength).toBeLessThanOrEqual(OFFLINE_DIAGNOSTIC_MAX_BYTES);
    expect(first.json).not.toContain("PRIVATE-CANARY");

    const parsed = JSON.parse(first.json) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["schema", "metadata", "capture"]);
    expect(parsed.schema).toBe(OFFLINE_DIAGNOSTIC_SCHEMA);
    const serializedKeys = new Set<string>();
    JSON.parse(first.json, (key, value: unknown) => {
      if (key) serializedKeys.add(key);
      return value;
    });
    for (const forbidden of ["message", "detail", "path", "source", "environment", "stdout", "stderr"]) {
      expect(serializedKeys.has(forbidden)).toBe(false);
    }
  });

  it("rejects mutated snapshots and metadata that could carry unbounded text", () => {
    const ledger = new DiagnosticLedger();
    ledger.record({ category: "kernel", code: "unavailable", recoverable: true });
    const capture = ledger.snapshot();

    expect(() =>
      createOfflineDiagnosticBundle(metadata, {
        ...capture,
        events: [{ ...capture.events[0], detail: "PRIVATE-CANARY" }]
      })
    ).toThrow(DiagnosticContractError);
    expect(() => createOfflineDiagnosticBundle({ ...metadata, editorVersion: "PRIVATE/CANARY" }, capture)).toThrow(
      DiagnosticContractError
    );
    expect(() => createOfflineDiagnosticBundle({ ...metadata, workspacePath: "/private/workspace" }, capture)).toThrow(
      DiagnosticContractError
    );
    expect(() => createOfflineDiagnosticBundle(metadata, { ...capture, dropped: capture.dropped + 1 })).toThrow(
      DiagnosticContractError
    );
  });

  it("requires the exact consecutive retained tail before and after capacity", () => {
    const preCapacity = new DiagnosticLedger();
    for (let index = 0; index < 3; index += 1) {
      preCapacity.record({ category: "request", code: "failure", recoverable: true });
    }
    const preCapture = preCapacity.snapshot();
    expect(() =>
      createOfflineDiagnosticBundle(metadata, {
        ...preCapture,
        dropped: 1,
        events: [preCapture.events[0], preCapture.events[2]]
      })
    ).toThrow(DiagnosticContractError);

    const postCapacity = new DiagnosticLedger();
    for (let index = 0; index < OFFLINE_DIAGNOSTIC_EVENT_CAPACITY + 2; index += 1) {
      postCapacity.record({ category: "runtime", code: "ready", recoverable: true });
    }
    const postCapture = postCapacity.snapshot();
    const wrongFirst = postCapture.events.map((event) => ({ ...event, sequence: event.sequence - 1 }));
    const wrongLast = postCapture.events.map((event) => ({ ...event, sequence: event.sequence + 1 }));
    const gap = postCapture.events.map((event, index) => ({
      ...event,
      sequence: index === 0 ? event.sequence - 1 : event.sequence
    }));
    for (const events of [wrongFirst, wrongLast, gap]) {
      expect(() => createOfflineDiagnosticBundle(metadata, { ...postCapture, events })).toThrow(
        DiagnosticContractError
      );
    }
  });

  it("canonicalizes semantically identical counter arrays before serialization", () => {
    const ledger = new DiagnosticLedger();
    ledger.record({ category: "runtime", code: "ready", recoverable: true });
    ledger.record({ category: "request", code: "failure", recoverable: true });
    const capture = ledger.snapshot();
    const canonical = createOfflineDiagnosticBundle(metadata, capture);
    const reversed = createOfflineDiagnosticBundle(metadata, {
      ...capture,
      counters: [...capture.counters].reverse()
    });
    expect(reversed.json).toBe(canonical.json);
    expect(reversed.bundle.capture.counters).toEqual(capture.counters);
  });
});
