import * as vscode from "vscode";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodeWebviewBootstrapSettings,
  DEFAULT_RUNTIME_REQUEST_TIMEOUT_MS,
  DEFAULT_SESSION_OPEN_TIMEOUT_MS,
  readWebviewBootstrapSettings,
  runtimeRequestTimeoutMs
} from "../extension/configuration";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runtime request deadlines", () => {
  it("reserves a longer bounded default for cold session initialization", () => {
    expect(runtimeRequestTimeoutMs({ kind: "openSession" })).toBe(DEFAULT_SESSION_OPEN_TIMEOUT_MS);
    expect(DEFAULT_SESSION_OPEN_TIMEOUT_MS).toBe(60_000);
    expect(runtimeRequestTimeoutMs({ kind: "getPage" })).toBe(DEFAULT_RUNTIME_REQUEST_TIMEOUT_MS);
    expect(DEFAULT_RUNTIME_REQUEST_TIMEOUT_MS).toBe(30_000);
  });

  it("reads independent configured session-open and steady-state deadlines", () => {
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
      get: <T>(key: string, fallback: T): T =>
        (key === "sessionOpenTimeoutMs" ? 75_000 : key === "requestTimeoutMs" ? 12_000 : fallback) as T
    } as vscode.WorkspaceConfiguration);

    expect(runtimeRequestTimeoutMs({ kind: "openSession" })).toBe(75_000);
    expect(runtimeRequestTimeoutMs({ kind: "getSummary" })).toBe(12_000);
  });

  it("keeps explicit per-call cleanup and test deadlines authoritative", () => {
    expect(runtimeRequestTimeoutMs({ kind: "openSession" }, 2_000)).toBe(2_000);
    expect(runtimeRequestTimeoutMs({ kind: "closeSession" }, 0)).toBe(0);
  });
});

describe("webview bootstrap settings", () => {
  const defaults = {
    fetchBlockSize: 200,
    fetchColumnBlockSize: 16,
    defaultColumnWidth: 190,
    insightsOnOpen: true,
    filterMode: "basic"
  } as const;

  it("accepts exact valid values including numeric boundaries", () => {
    expect(
      decodeWebviewBootstrapSettings({
        fetchBlockSize: 25,
        fetchColumnBlockSize: 1,
        defaultColumnWidth: 80,
        insightsOnOpen: false,
        filterMode: "advanced"
      })
    ).toEqual({
      fetchBlockSize: 25,
      fetchColumnBlockSize: 1,
      defaultColumnWidth: 80,
      insightsOnOpen: false,
      filterMode: "advanced"
    });
    expect(
      decodeWebviewBootstrapSettings({
        fetchBlockSize: 2_000,
        fetchColumnBlockSize: 256,
        defaultColumnWidth: 640,
        insightsOnOpen: true,
        filterMode: "basic"
      })
    ).toEqual({
      fetchBlockSize: 2_000,
      fetchColumnBlockSize: 256,
      defaultColumnWidth: 640,
      insightsOnOpen: true,
      filterMode: "basic"
    });
  });

  it("uses documented defaults for invalid types, non-finite numbers, and dangerous text", () => {
    const dangerousValues: readonly unknown[] = [
      undefined,
      null,
      {},
      [],
      '"><script>compromised()</script>&\u2028\u2029\ud800',
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY
    ];
    for (const value of dangerousValues) {
      expect(
        decodeWebviewBootstrapSettings({
          fetchBlockSize: value,
          fetchColumnBlockSize: value,
          defaultColumnWidth: value,
          insightsOnOpen: value,
          filterMode: value
        })
      ).toEqual(defaults);
    }
    expect(
      decodeWebviewBootstrapSettings({
        fetchBlockSize: false,
        fetchColumnBlockSize: true,
        defaultColumnWidth: false,
        insightsOnOpen: false,
        filterMode: true
      })
    ).toEqual({ ...defaults, insightsOnOpen: false });
  });

  it("uses documented defaults for fractional and out-of-range numeric values", () => {
    for (const input of [
      { fetchBlockSize: 24 },
      { fetchBlockSize: 2_001 },
      { fetchBlockSize: 25.5 },
      { fetchColumnBlockSize: 0 },
      { fetchColumnBlockSize: 257 },
      { fetchColumnBlockSize: 1.5 },
      { defaultColumnWidth: 79.99 },
      { defaultColumnWidth: 640.01 }
    ]) {
      expect(decodeWebviewBootstrapSettings(input)).toMatchObject(defaults);
    }
  });

  it("runtime-decodes raw workspace values before returning bootstrap settings", () => {
    const values = new Map<string, unknown>([
      ["fetchBlockSize", 25],
      ["fetchColumnBlockSize", 256],
      ["defaultColumnWidth", 320.5],
      ["insightsOnOpen", false],
      ["filterMode", "advanced"]
    ]);
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
      get: (key: string): unknown => values.get(key)
    } as vscode.WorkspaceConfiguration);

    expect(readWebviewBootstrapSettings()).toEqual({
      fetchBlockSize: 25,
      fetchColumnBlockSize: 256,
      defaultColumnWidth: 320.5,
      insightsOnOpen: false,
      filterMode: "advanced"
    });
  });
});
