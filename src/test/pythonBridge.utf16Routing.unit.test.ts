import { join } from "node:path";
import * as vscode from "vscode";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ErrorResponse, OpenWranglerRequest, SessionSource } from "../shared/protocol";
import * as pythonEnvironment from "../extension/pythonEnvironment";
import { PythonBridge } from "../extension/pythonBridge";

vi.mock("../extension/pythonEnvironment", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../extension/pythonEnvironment")>();
  return {
    ...actual,
    probeDependencies: vi.fn(),
    resolvePythonEnvironment: vi.fn()
  };
});

interface BridgeInternals {
  dependencyGuardErrorForEnvironment(): Promise<undefined>;
  ensureProcess(request: OpenWranglerRequest): Promise<unknown>;
  prepareRequest(request: OpenWranglerRequest): Promise<OpenWranglerRequest | ErrorResponse>;
}

const environment: pythonEnvironment.PythonEnvironment = {
  executable: "/env/bin/python",
  executableIdentity: {
    device: "2",
    inode: "3",
    size: "16384",
    mtimeNs: "1700000000000000000",
    ctimeNs: "1700000100000000000"
  },
  packageRoot: "/env",
  packageRootIdentity: { device: "1", inode: "2" },
  version: "3.12.4",
  source: "pythonExtension"
};

function testExtensionContext(): vscode.ExtensionContext {
  return {
    extensionPath: "/extension",
    asAbsolutePath: (relativePath: string) => join("/extension", relativePath)
  } as vscode.ExtensionContext;
}

function remoteFileSource(encoding: "utf-16le" | "utf-16be"): SessionSource {
  return {
    kind: "file",
    label: "data.csv",
    path: "/workspace/data.csv",
    uri: "vscode-remote://ssh-remote+example/workspace/data.csv",
    importOptions: { encoding }
  };
}

function openSessionRequest(source: SessionSource): Extract<OpenWranglerRequest, { kind: "openSession" }> {
  return {
    kind: "openSession",
    source,
    mode: "editing",
    pageSize: 100,
    columnOffset: 0,
    columnLimit: 16
  };
}

describe("PythonBridge UTF-16 backend routing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockReset();
    vi.mocked(pythonEnvironment.probeDependencies).mockReset();
  });

  it.each(["utf-16le", "utf-16be"] as const)("probes only Pandas for an automatic %s import", async (encoding) => {
    const source = remoteFileSource(encoding);
    const bridge = new PythonBridge(testExtensionContext());
    const internals = bridge as unknown as BridgeInternals;
    vi.spyOn(internals, "dependencyGuardErrorForEnvironment").mockResolvedValue(undefined);
    vi.mocked(pythonEnvironment.resolvePythonEnvironment).mockResolvedValue(environment);
    vi.mocked(pythonEnvironment.probeDependencies).mockResolvedValue({ missing: [], available: ["pandas"] });

    try {
      await expect(internals.prepareRequest(openSessionRequest(source))).resolves.toMatchObject({
        kind: "openSession",
        backend: "pandas",
        source: { importOptions: { encoding } }
      });

      expect(
        vi
          .mocked(pythonEnvironment.probeDependencies)
          .mock.calls.map(([, dependencies]) => dependencies.map((dependency) => dependency.importModule))
      ).toEqual([["pandas"]]);
    } finally {
      await bridge.shutdown();
    }
  });

  it.each([
    { backend: "polars" as const, encoding: "utf-16le" as const },
    { backend: "polars" as const, encoding: "utf-16be" as const },
    { backend: "duckdb" as const, encoding: "utf-16le" as const },
    { backend: "duckdb" as const, encoding: "utf-16be" as const }
  ])("rejects an explicit $backend backend with $encoding before environment work", async ({ backend, encoding }) => {
    const source = remoteFileSource(encoding);
    const bridge = new PythonBridge(testExtensionContext());
    const internals = bridge as unknown as BridgeInternals;
    const ensureProcess = vi.spyOn(internals, "ensureProcess");

    try {
      await expect(bridge.request({ ...openSessionRequest(source), backend })).resolves.toMatchObject({
        kind: "error",
        code: "unsupported_import_options",
        message: expect.stringContaining(encoding === "utf-16le" ? "UTF-16LE" : "UTF-16BE"),
        detail: expect.stringContaining("Pandas"),
        recoverable: true
      });

      expect(pythonEnvironment.resolvePythonEnvironment).not.toHaveBeenCalled();
      expect(pythonEnvironment.probeDependencies).not.toHaveBeenCalled();
      expect(ensureProcess).not.toHaveBeenCalled();
    } finally {
      await bridge.shutdown();
    }
  });
});
