import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { link, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { ExportDataRequest, OpenWranglerResponse, SessionSource } from "../shared/protocol";
import { beginAtomicFileTransaction, createNodeAtomicExportFileSystem } from "../extension/files/safeFileExport";
import { exportPythonDataSafely } from "../extension/files/safePythonDataExport";

const SOURCE_BYTES = "group,value\na,1\nb,2\n";
const PRIOR_DESTINATION_BYTES = "prior destination";
const EXPORTED_BYTES = "group,value,score\na,1,2\nb,2,4\n";

describe("host-owned Python data export", () => {
  let directory: string;
  let sourcePath: string;
  let destinationPath: string;
  let source: SessionSource;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "openwrangler-python-export-"));
    sourcePath = path.join(directory, "source.csv");
    destinationPath = path.join(directory, "cleaned.csv");
    source = { kind: "file", label: "source.csv", path: sourcePath };
    await writeFile(sourcePath, SOURCE_BYTES);
    await writeFile(destinationPath, PRIOR_DESTINATION_BYTES);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("publishes only the reserved sibling target and reports the user's final destination", async () => {
    let runtimeTarget: string | undefined;
    const response = await exportPythonDataSafely({
      request: exportRequest(destinationPath),
      source,
      dispatch: async (request) => {
        runtimeTarget = request.path;
        expect(path.dirname(request.path)).toBe(directory);
        expect(request.path).not.toBe(destinationPath);
        expect(request.targetIdentity).toEqual({
          device: expect.stringMatching(/^(?:0|[1-9][0-9]*)$/u),
          inode: expect.stringMatching(/^(?:0|[1-9][0-9]*)$/u)
        });
        expect(request.rowAxisPolicy).toBe("preserve");
        await writeFile(request.path, EXPORTED_BYTES);
        return exportedResponse(request);
      }
    });

    expect(response).toEqual({
      kind: "dataExported",
      revision: 4,
      path: destinationPath,
      format: "csv",
      shape: { rows: 2, columns: 3 }
    });
    expect(runtimeTarget).toBeDefined();
    expect(await readFile(destinationPath, "utf8")).toBe(EXPORTED_BYTES);
    await expectSourceAndNoTemporaryFiles();
  });

  it("rejects a relative destination before reserving or dispatching", async () => {
    let dispatched = false;

    await expect(
      exportPythonDataSafely({
        request: exportRequest("cleaned.csv"),
        source,
        dispatch: async () => {
          dispatched = true;
          throw new Error("must not dispatch");
        }
      })
    ).rejects.toThrow(/absolute file-system destination/u);

    expect(dispatched).toBe(false);
    await expectFixturePreserved();
  });

  it.skipIf(process.platform === "win32")("rejects a destination symlink before runtime dispatch", async () => {
    const symlinkDestination = path.join(directory, "linked.csv");
    await symlink(destinationPath, symlinkDestination, "file");
    let dispatched = false;

    await expect(
      exportPythonDataSafely({
        request: exportRequest(symlinkDestination),
        source,
        dispatch: async () => {
          dispatched = true;
          throw new Error("must not dispatch");
        }
      })
    ).rejects.toThrow(/new or regular-file destination/u);

    expect(dispatched).toBe(false);
    expect(await readFile(destinationPath, "utf8")).toBe(PRIOR_DESTINATION_BYTES);
    expect(await readFile(symlinkDestination, "utf8")).toBe(PRIOR_DESTINATION_BYTES);
    await expectSourceAndNoTemporaryFiles();
  });

  it("rejects a hard-link alias of the source before runtime dispatch", async () => {
    const alias = path.join(directory, "source-alias.csv");
    await link(sourcePath, alias);
    let dispatched = false;

    await expect(
      exportPythonDataSafely({
        request: exportRequest(alias),
        source,
        dispatch: async () => {
          dispatched = true;
          throw new Error("must not dispatch");
        }
      })
    ).rejects.toThrow(/never overwrites the active source/u);

    expect(dispatched).toBe(false);
    expect(await readFile(alias, "utf8")).toBe(SOURCE_BYTES);
    await expectSourceAndNoTemporaryFiles();
  });

  it("preserves a destination replacement made while the runtime writes", async () => {
    const displacedDestination = path.join(directory, "original-destination.csv");
    await expect(
      exportPythonDataSafely({
        request: exportRequest(destinationPath),
        source,
        dispatch: async (request) => {
          await writeFile(request.path, EXPORTED_BYTES);
          await rename(destinationPath, displacedDestination);
          await writeFile(destinationPath, "concurrent replacement");
          return exportedResponse(request);
        }
      })
    ).rejects.toThrow(/destination changed/u);

    expect(await readFile(displacedDestination, "utf8")).toBe(PRIOR_DESTINATION_BYTES);
    expect(await readFile(destinationPath, "utf8")).toBe("concurrent replacement");
    await expectSourceAndNoTemporaryFiles();
  });

  it("preserves the destination when its parent identity changes before commit", async () => {
    const base = createNodeAtomicExportFileSystem();
    let parentChanged = false;
    const fileSystem = {
      ...base,
      stat: async (target: string) => {
        const identity = await base.stat(target);
        return parentChanged && target === directory ? { ...identity, ino: identity.ino + 1n } : identity;
      }
    };

    await expect(
      exportPythonDataSafely({
        request: exportRequest(destinationPath),
        source,
        beginTransaction: (options) => beginAtomicFileTransaction({ ...options, fileSystem }),
        dispatch: async (request) => {
          await writeFile(request.path, EXPORTED_BYTES);
          parentChanged = true;
          return exportedResponse(request);
        }
      })
    ).rejects.toThrow(/destination changed/u);

    await expectFixturePreserved();
  });

  it("never publishes or removes a substituted runtime target", async () => {
    let foreignTarget: string | undefined;
    const displacedOwnedTarget = path.join(directory, "displaced-owned-target");
    const failure = await captureFailure(() =>
      exportPythonDataSafely({
        request: exportRequest(destinationPath),
        source,
        dispatch: async (request) => {
          foreignTarget = request.path;
          await rename(request.path, displacedOwnedTarget);
          await writeFile(request.path, "foreign replacement");
          await writeFile(displacedOwnedTarget, EXPORTED_BYTES);
          return exportedResponse(request);
        }
      })
    );

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as Error).message).toMatch(/could not be settled safely/u);
    expect(foreignTarget).toBeDefined();
    expect(await readFile(foreignTarget!, "utf8")).toBe("foreign replacement");
    expect(await readFile(displacedOwnedTarget, "utf8")).toBe(EXPORTED_BYTES);
    expect(await readFile(destinationPath, "utf8")).toBe(PRIOR_DESTINATION_BYTES);
    expect(await readFile(sourcePath, "utf8")).toBe(SOURCE_BYTES);
  });

  it("never publishes or removes a runtime target that gained a hard-link alias", async () => {
    const alias = path.join(directory, "runtime-target-alias.csv");
    let runtimeTarget: string | undefined;
    const failure = await captureFailure(() =>
      exportPythonDataSafely({
        request: exportRequest(destinationPath),
        source,
        dispatch: async (request) => {
          runtimeTarget = request.path;
          await writeFile(request.path, EXPORTED_BYTES);
          await link(request.path, alias);
          return exportedResponse(request);
        }
      })
    );

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as Error).message).toMatch(/could not be settled safely/u);
    expect(runtimeTarget).toBeDefined();
    expect(await readFile(runtimeTarget!, "utf8")).toBe(EXPORTED_BYTES);
    expect(await readFile(alias, "utf8")).toBe(EXPORTED_BYTES);
    expect(await readFile(destinationPath, "utf8")).toBe(PRIOR_DESTINATION_BYTES);
    expect(await readFile(sourcePath, "utf8")).toBe(SOURCE_BYTES);
  });

  it("removes its identified partial target after a runtime failure", async () => {
    const runtimeFailure = new Error("injected Python runtime export failure");
    const failure = await captureFailure(() =>
      exportPythonDataSafely({
        request: exportRequest(destinationPath),
        source,
        dispatch: async (request) => {
          await writeFile(request.path, "partial export");
          throw runtimeFailure;
        }
      })
    );

    expect(failure).toBe(runtimeFailure);
    await expectFixturePreserved();
  });

  it("rolls back its identified target after a logical runtime error", async () => {
    const response = await exportPythonDataSafely({
      request: exportRequest(destinationPath),
      source,
      dispatch: async (request) => {
        await writeFile(request.path, "partial export");
        return {
          kind: "error",
          code: "runtime_error",
          message: "injected runtime error",
          recoverable: true,
          sessionId: request.sessionId
        };
      }
    });

    expect(response).toMatchObject({ kind: "error", code: "runtime_error" });
    await expectFixturePreserved();
  });

  it("preserves the source and prior destination after an atomic commit failure", async () => {
    const commitFailure = new Error("injected atomic commit failure");
    const base = createNodeAtomicExportFileSystem();
    const fileSystem = {
      ...base,
      replace: async () => {
        throw commitFailure;
      }
    };

    const failure = await captureFailure(() =>
      exportPythonDataSafely({
        request: exportRequest(destinationPath),
        source,
        beginTransaction: (options) => beginAtomicFileTransaction({ ...options, fileSystem }),
        dispatch: async (request) => {
          await writeFile(request.path, EXPORTED_BYTES);
          return exportedResponse(request);
        }
      })
    );

    expect(failure).toBe(commitFailure);
    await expectFixturePreserved();
  });

  function exportRequest(destination: string): ExportDataRequest {
    return {
      kind: "exportData",
      sessionId: "python-session",
      revision: 4,
      path: destination,
      format: "csv",
      rowAxisPolicy: "preserve"
    };
  }

  function exportedResponse(request: ExportDataRequest): OpenWranglerResponse {
    return {
      kind: "dataExported",
      revision: request.revision,
      path: request.path,
      format: request.format,
      shape: { rows: 2, columns: 3 }
    };
  }

  async function expectFixturePreserved(): Promise<void> {
    expect(await readFile(destinationPath, "utf8")).toBe(PRIOR_DESTINATION_BYTES);
    await expectSourceAndNoTemporaryFiles();
  }

  async function expectSourceAndNoTemporaryFiles(): Promise<void> {
    expect(await readFile(sourcePath, "utf8")).toBe(SOURCE_BYTES);
    expect((await readdir(directory)).filter((entry) => entry.startsWith(".openwrangler-"))).toEqual([]);
  }
});

async function captureFailure(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error("Expected Python data export to fail.");
}
