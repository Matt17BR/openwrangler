import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPackagedGridColumnCopyJourney,
  packagedGridColumnCopyExpectedCityText,
  packagedGridColumnCopyExpectedSalesText,
  packagedGridColumnCopyFilterModel,
  packagedGridColumnCopyFixtureCsv,
  type PackagedGridColumnCopySurface
} from "./extensionHost/packagedGridColumnCopyJourney";
import type { TestApi } from "./extensionHost/extensionHostTestApi";
import { dispatchExtensionHostPhase, parseExtensionHostPhaseSelection } from "./extensionHost/phaseDispatch";

describe("packaged whole-column copy journey", () => {
  const originalPort = process.env.OPEN_WRANGLER_EDITOR_CDP_PORT;

  beforeEach(() => {
    process.env.OPEN_WRANGLER_EDITOR_CDP_PORT = "43123";
  });

  afterEach(() => {
    if (originalPort === undefined) delete process.env.OPEN_WRANGLER_EDITOR_CDP_PORT;
    else process.env.OPEN_WRANGLER_EDITOR_CDP_PORT = originalPort;
  });

  it("owns one visible action and one first shortcut through exact host clipboard results", async () => {
    const fixture = fakeUri("file:///workspace/fixtures/grid-column-copy.csv");
    const source = new TextEncoder().encode(packagedGridColumnCopyFixtureCsv());
    let clipboard = "original clipboard";
    let session = false;
    let runtime = false;
    const calls: string[] = [];
    const active = activeSession(fixture.toString());
    const testing = {
      activeSession: () => (session ? active : undefined),
      diagnostics: () => ({ sessionCount: session ? 1 : 0 }),
      runtimeRunning: () => runtime,
      ensurePanelSynchronized: vi.fn(async () => true),
      request: vi.fn(async (request: { filterModel: typeof active.metadata.filterModel }) => {
        active.metadata.filterModel = request.filterModel;
        active.metadata.filteredShape = { rows: 1_003, columns: 4 };
        return { kind: "page", page: { totalRows: 1_003 } };
      }),
      synchronizePanel: vi.fn(async () => true),
      updateViewState: vi.fn(async (_sessionId: string, state: typeof active.viewState) => {
        active.viewState = state;
      })
    } as unknown as TestApi;
    const surface: PackagedGridColumnCopySurface = {
      restoreViewport: vi.fn(async () => {
        calls.push("viewport:restore");
      }),
      activateHeaderCopy: vi.fn(async (column) => {
        calls.push(`action:${column}`);
        clipboard = packagedGridColumnCopyExpectedCityText();
        return settledClipboardWriteReceipt();
      }),
      assertHeaderFocused: vi.fn(async (column) => {
        calls.push(`focus:${column}`);
      }),
      pressHeaderCopyShortcut: vi.fn(async (column, platform) => {
        calls.push(`shortcut:${column}:${platform}`);
        clipboard = packagedGridColumnCopyExpectedSalesText();
        return settledClipboardWriteReceipt();
      }),
      waitForColumnValues: vi.fn(async (position, values) => {
        calls.push(`values:${position}:${values.join(",")}`);
      }),
      waitForHeaderCopyState: vi.fn(async (column, state, rows) => {
        calls.push(`state:${column}:${state}:${rows}`);
      })
    };
    const progress: string[] = [];
    const journey = createPackagedGridColumnCopyJourney({
      closeAllEditors: async () => {
        calls.push("editors:close");
        session = false;
        runtime = false;
      },
      connectToEditorWorkbench: async () => ({}) as never,
      createSurface: async () => surface,
      openFixture: async () => {
        session = true;
        runtime = true;
      },
      readClipboardText: async () => clipboard,
      readFixture: async () => source,
      recordProgress: (checkpoint) => progress.push(checkpoint),
      waitFor: async (predicate, _timeout, expectation) => {
        if (!predicate()) throw new Error(`not ready: ${expectation}`);
      },
      writeClipboardText: async (text) => {
        clipboard = text;
      },
      sessionTimeoutMs: 1_000
    });

    await expect(journey(testing, fixture as never)).resolves.toBeUndefined();
    expect(testing.updateViewState).toHaveBeenCalledTimes(1);
    expect(active.metadata.filterModel).toEqual(packagedGridColumnCopyFilterModel());
    expect(surface.activateHeaderCopy).toHaveBeenCalledExactlyOnceWith("city");
    expect(surface.pressHeaderCopyShortcut).toHaveBeenCalledTimes(1);
    expect(surface.waitForHeaderCopyState).toHaveBeenNthCalledWith(1, "city", "copying", 1_003);
    expect(surface.waitForHeaderCopyState).toHaveBeenNthCalledWith(2, "city", "ready", 1_003);
    expect(surface.waitForHeaderCopyState).toHaveBeenNthCalledWith(3, "sales", "ready", 1_003);
    expect(clipboard).toBe(packagedGridColumnCopyExpectedSalesText());
    expect(progress).toEqual([
      "grid-column-copy:open",
      "grid-column-copy:header-action",
      "grid-column-copy:first-shortcut",
      "grid-column-copy:complete"
    ]);
    expect(calls).toEqual([
      "values:2:2004,2002",
      "action:city",
      "state:city:copying:1003",
      "state:city:ready:1003",
      `shortcut:sales:${process.platform}`,
      "state:sales:ready:1003",
      "focus:sales",
      "editors:close",
      "viewport:restore"
    ]);
  });

  it("fails when the production surface cannot attest the copying transition", async () => {
    const fixture = fakeUri("file:///workspace/fixtures/grid-column-copy.csv");
    const active = activeSession(fixture.toString());
    let session = false;
    const surface = {
      restoreViewport: vi.fn(async () => undefined),
      activateHeaderCopy: vi.fn(async () => settledClipboardWriteReceipt()),
      assertHeaderFocused: vi.fn(async () => undefined),
      pressHeaderCopyShortcut: vi.fn(async () => settledClipboardWriteReceipt()),
      waitForColumnValues: vi.fn(async () => undefined),
      waitForHeaderCopyState: vi.fn(async () => {
        throw new Error("copying state absent");
      })
    } satisfies PackagedGridColumnCopySurface;
    const testing = {
      activeSession: () => (session ? active : undefined),
      diagnostics: () => ({ sessionCount: session ? 1 : 0 }),
      runtimeRunning: () => session,
      ensurePanelSynchronized: async () => true,
      request: async (request: { filterModel: typeof active.metadata.filterModel }) => {
        active.metadata.filterModel = request.filterModel;
        active.metadata.filteredShape = { rows: 1_003, columns: 4 };
        return { kind: "page", page: { totalRows: 1_003 } };
      },
      synchronizePanel: async () => true,
      updateViewState: async (_sessionId: string, state: typeof active.viewState) => {
        active.viewState = state;
      }
    } as unknown as TestApi;
    let clipboard = "sentinel";
    const journey = createPackagedGridColumnCopyJourney({
      closeAllEditors: async () => {
        session = false;
      },
      connectToEditorWorkbench: async () => ({}) as never,
      createSurface: async () => surface,
      openFixture: async () => {
        session = true;
      },
      readClipboardText: async () => clipboard,
      readFixture: async () => new TextEncoder().encode(packagedGridColumnCopyFixtureCsv()),
      recordProgress: () => undefined,
      waitFor: async (predicate) => {
        if (!predicate()) throw new Error("not ready");
      },
      writeClipboardText: async (text) => {
        clipboard = text;
      },
      sessionTimeoutMs: 1_000
    });

    await expect(journey(testing, fixture as never)).rejects.toThrow("copying state absent");
    expect(surface.pressHeaderCopyShortcut).not.toHaveBeenCalled();
  });

  it("retains a started header clipboard write through settlement before reporting an attestation failure", async () => {
    const fixture = fakeUri("file:///workspace/fixtures/grid-column-copy.csv");
    const active = activeSession(fixture.toString());
    let session = false;
    let clipboard = "original";
    const writeSettlement = deferred<void>();
    const copyingProofStarted = deferred<void>();
    const closeAllEditors = vi.fn(async () => {
      session = false;
    });
    const surface = {
      restoreViewport: vi.fn(async () => undefined),
      activateHeaderCopy: vi.fn(async () => {
        void writeSettlement.promise.then(() => {
          clipboard = packagedGridColumnCopyExpectedCityText();
        });
        return { waitForSettlement: () => writeSettlement.promise };
      }),
      assertHeaderFocused: vi.fn(async () => undefined),
      pressHeaderCopyShortcut: vi.fn(async () => settledClipboardWriteReceipt()),
      waitForColumnValues: vi.fn(async () => undefined),
      waitForHeaderCopyState: vi.fn(async () => {
        copyingProofStarted.resolve();
        throw new Error("copying state proof failed");
      })
    } satisfies PackagedGridColumnCopySurface;
    const journey = createPackagedGridColumnCopyJourney({
      closeAllEditors,
      connectToEditorWorkbench: async () => ({}) as never,
      createSurface: async () => surface,
      openFixture: async () => {
        session = true;
      },
      readClipboardText: async () => clipboard,
      readFixture: async () => new TextEncoder().encode(packagedGridColumnCopyFixtureCsv()),
      recordProgress: () => undefined,
      waitFor: async (predicate) => {
        if (!predicate()) throw new Error("not ready");
      },
      writeClipboardText: async (text) => {
        clipboard = text;
      },
      sessionTimeoutMs: 1_000
    });

    const outcome = journey(
      testingApi(active, () => session),
      fixture as never
    ).then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ error, status: "rejected" as const })
    );
    await copyingProofStarted.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closeAllEditors).not.toHaveBeenCalled();

    writeSettlement.resolve();
    const result = await outcome;
    expect(result.status).toBe("rejected");
    expect(result.status === "rejected" ? result.error : undefined).toBeInstanceOf(AggregateError);
    expect((result.status === "rejected" ? (result.error as AggregateError).errors : [])[0]).toEqual(
      new Error("copying state proof failed")
    );
    expect(closeAllEditors).toHaveBeenCalledTimes(1);
  });

  it("preserves a concurrent foreign clipboard value and emits only a fixed interference diagnostic", async () => {
    const fixture = fakeUri("file:///workspace/fixtures/grid-column-copy.csv");
    const active = activeSession(fixture.toString());
    let session = false;
    let clipboard = "original clipboard";
    const surface = successfulSurface(
      (text) => {
        clipboard = text;
      },
      () => {
        clipboard = "foreign-private-value";
      }
    );
    const journey = createPackagedGridColumnCopyJourney({
      closeAllEditors: async () => {
        session = false;
      },
      connectToEditorWorkbench: async () => ({}) as never,
      createSurface: async () => surface,
      openFixture: async () => {
        session = true;
      },
      readClipboardText: async () => clipboard,
      readFixture: async () => new TextEncoder().encode(packagedGridColumnCopyFixtureCsv()),
      recordProgress: () => undefined,
      waitFor: async (predicate) => {
        if (!predicate()) throw new Error("not ready");
      },
      writeClipboardText: async (text) => {
        clipboard = text;
      },
      sessionTimeoutMs: 1_000
    });

    let failure: unknown;
    try {
      await journey(
        testingApi(active, () => session),
        fixture as never
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(
      "Clipboard changed outside the packaged whole-column journey; the foreign value was preserved."
    );
    expect(clipboard).toBe("foreign-private-value");
    expect(String(failure)).not.toContain("foreign-private-value");
  });

  it("never restores after cleanup observes a value that a foreign owner replaces with identical bytes", async () => {
    const fixture = fakeUri("file:///workspace/fixtures/grid-column-copy.csv");
    const active = activeSession(fixture.toString());
    let session = false;
    let editorsClosed = false;
    let clipboard = { owner: "original", text: "original clipboard" };
    let cleanupReads = 0;
    const writeClipboardText = vi.fn(async (text: string) => {
      clipboard = { owner: "journey", text };
    });
    const surface = successfulSurface(
      (text) => {
        clipboard = { owner: "journey", text };
      },
      () => undefined
    );
    const journey = createPackagedGridColumnCopyJourney({
      closeAllEditors: async () => {
        session = false;
        editorsClosed = true;
      },
      connectToEditorWorkbench: async () => ({}) as never,
      createSurface: async () => surface,
      openFixture: async () => {
        session = true;
      },
      readClipboardText: async () => {
        const observed = clipboard.text;
        if (editorsClosed && cleanupReads === 0) {
          cleanupReads += 1;
          queueMicrotask(() => {
            clipboard = { owner: "foreign", text: observed };
          });
        }
        return observed;
      },
      readFixture: async () => new TextEncoder().encode(packagedGridColumnCopyFixtureCsv()),
      recordProgress: () => undefined,
      waitFor: async (predicate) => {
        if (!predicate()) throw new Error("not ready");
      },
      writeClipboardText,
      sessionTimeoutMs: 1_000
    });

    await expect(
      journey(
        testingApi(active, () => session),
        fixture as never
      )
    ).resolves.toBeUndefined();
    await Promise.resolve();

    expect(cleanupReads).toBe(1);
    expect(clipboard).toEqual({ owner: "foreign", text: packagedGridColumnCopyExpectedSalesText() });
    expect(writeClipboardText).toHaveBeenCalledTimes(2);
    expect(writeClipboardText).toHaveBeenNthCalledWith(1, "open-wrangler-grid-copy-sentinel");
    expect(writeClipboardText).toHaveBeenNthCalledWith(2, "open-wrangler-grid-shortcut-sentinel");
  });

  it("rejects an oversized initial clipboard without retaining or rewriting its bytes", async () => {
    const fixture = fakeUri("file:///workspace/fixtures/grid-column-copy.csv");
    const oversized = "private".repeat(700_000);
    const writeClipboardText = vi.fn(async () => undefined);
    const closeAllEditors = vi.fn(async () => undefined);
    const journey = createPackagedGridColumnCopyJourney({
      closeAllEditors,
      connectToEditorWorkbench: async () => ({}) as never,
      createSurface: async () => {
        throw new Error("surface must not open");
      },
      openFixture: async () => {
        throw new Error("fixture must not open");
      },
      readClipboardText: async () => oversized,
      readFixture: async () => new TextEncoder().encode(packagedGridColumnCopyFixtureCsv()),
      recordProgress: () => undefined,
      waitFor: async () => undefined,
      writeClipboardText,
      sessionTimeoutMs: 1_000
    });

    let failure: unknown;
    try {
      await journey(
        testingApi(activeSession(fixture.toString()), () => false),
        fixture as never
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("Packaged whole-column clipboard initial read exceeded its fixed bound.");
    expect(String(failure)).not.toContain("private");
    expect(writeClipboardText).not.toHaveBeenCalled();
    expect(closeAllEditors).toHaveBeenCalledTimes(1);
  });

  it("bounds a never-settling initial clipboard read and still starts editor cleanup", async () => {
    const fixture = fakeUri("file:///workspace/fixtures/grid-column-copy.csv");
    const closeAllEditors = vi.fn(async () => undefined);
    const journey = createPackagedGridColumnCopyJourney({
      closeAllEditors,
      connectToEditorWorkbench: async () => ({}) as never,
      createSurface: async () => {
        throw new Error("surface must not open");
      },
      openFixture: async () => {
        throw new Error("fixture must not open");
      },
      readClipboardText: () => new Promise<string>(() => undefined),
      readFixture: async () => new TextEncoder().encode(packagedGridColumnCopyFixtureCsv()),
      recordProgress: () => undefined,
      waitFor: async () => undefined,
      writeClipboardText: async () => undefined,
      sessionTimeoutMs: 20
    });

    await expect(
      journey(
        testingApi(activeSession(fixture.toString()), () => false),
        fixture as never
      )
    ).rejects.toThrow("Packaged whole-column clipboard initial read failed.");
    expect(closeAllEditors).toHaveBeenCalledTimes(1);
  });

  it("does not start cleanup until a timed-out owned clipboard write actually settles", async () => {
    const fixture = fakeUri("file:///workspace/fixtures/grid-column-copy.csv");
    const active = activeSession(fixture.toString());
    let session = false;
    let clipboard = "original";
    const closeAllEditors = vi.fn(async () => {
      session = false;
    });
    const lateWrite = deferred<void>();
    const writeClipboardText = vi.fn(async (text: string) => {
      await lateWrite.promise;
      clipboard = text;
    });
    const journey = createPackagedGridColumnCopyJourney({
      closeAllEditors,
      connectToEditorWorkbench: async () => ({}) as never,
      createSurface: async () =>
        successfulSurface(
          (text) => (clipboard = text),
          () => undefined
        ),
      openFixture: async () => {
        session = true;
      },
      readClipboardText: async () => clipboard,
      readFixture: async () => new TextEncoder().encode(packagedGridColumnCopyFixtureCsv()),
      recordProgress: () => undefined,
      waitFor: async (predicate) => {
        if (!predicate()) throw new Error("not ready");
      },
      writeClipboardText,
      sessionTimeoutMs: 20
    });

    const outcome = journey(
      testingApi(active, () => session),
      fixture as never
    ).then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ error, status: "rejected" as const })
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    const cleanupStartedBeforeWriteSettlement = closeAllEditors.mock.calls.length > 0;
    lateWrite.resolve();
    const result = await outcome;
    expect(result.status).toBe("rejected");
    expect(result.status === "rejected" ? result.error : undefined).toEqual(
      new Error("Packaged whole-column clipboard write failed.")
    );
    expect(cleanupStartedBeforeWriteSettlement).toBe(false);
    expect(writeClipboardText).toHaveBeenCalledTimes(1);
    expect(closeAllEditors).toHaveBeenCalledTimes(1);
    expect(clipboard).toBe("open-wrangler-grid-copy-sentinel");
  });

  it("starts editor and session cleanup before a never-settling viewport restore finishes", async () => {
    const fixture = fakeUri("file:///workspace/fixtures/grid-column-copy.csv");
    const active = activeSession(fixture.toString());
    let session = false;
    let clipboard = "original";
    const closeAllEditors = vi.fn(async () => {
      session = false;
    });
    const surface = successfulSurface(
      (text) => (clipboard = text),
      () => undefined
    );
    vi.mocked(surface.restoreViewport).mockImplementation(() => new Promise<void>(() => undefined));
    const journey = createPackagedGridColumnCopyJourney({
      closeAllEditors,
      connectToEditorWorkbench: async () => ({}) as never,
      createSurface: async () => surface,
      openFixture: async () => {
        session = true;
      },
      readClipboardText: async () => clipboard,
      readFixture: async () => new TextEncoder().encode(packagedGridColumnCopyFixtureCsv()),
      recordProgress: () => undefined,
      waitFor: async (predicate) => {
        if (!predicate()) throw new Error("not ready");
      },
      writeClipboardText: async (text) => {
        clipboard = text;
      },
      sessionTimeoutMs: 20
    });

    await expect(
      journey(
        testingApi(active, () => session),
        fixture as never
      )
    ).rejects.toThrow("Timed out restoring the packaged whole-column viewport.");
    expect(closeAllEditors).toHaveBeenCalledTimes(1);
    expect(session).toBe(false);
  });

  it("bounds never-settling editor and session cleanup while preserving the primary failure first", async () => {
    const fixture = fakeUri("file:///workspace/fixtures/grid-column-copy.csv");
    const active = activeSession(fixture.toString());
    let session = false;
    let clipboard = "original";
    const closeAllEditors = vi.fn(() => new Promise<void>(() => undefined));
    const surface = successfulSurface(
      (text) => (clipboard = text),
      () => undefined
    );
    vi.mocked(surface.waitForHeaderCopyState).mockRejectedValueOnce(new Error("primary copying state failure"));
    const journey = createPackagedGridColumnCopyJourney({
      closeAllEditors,
      connectToEditorWorkbench: async () => ({}) as never,
      createSurface: async () => surface,
      openFixture: async () => {
        session = true;
      },
      readClipboardText: async () => clipboard,
      readFixture: async () => new TextEncoder().encode(packagedGridColumnCopyFixtureCsv()),
      recordProgress: () => undefined,
      waitFor: async (predicate) => {
        if (predicate()) return;
        await new Promise<void>(() => undefined);
      },
      writeClipboardText: async (text) => {
        clipboard = text;
      },
      sessionTimeoutMs: 20
    });

    let failure: unknown;
    try {
      await journey(
        testingApi(active, () => session),
        fixture as never
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors[0]).toEqual(new Error("primary copying state failure"));
    expect(closeAllEditors).toHaveBeenCalledTimes(1);
  });

  it("dispatches only the exact packaged phase to its owner", async () => {
    const packagedGridColumnCopy = vi.fn(async () => undefined);
    const handled = await dispatchExtensionHostPhase(
      parseExtensionHostPhaseSelection({ OPEN_WRANGLER_TEST_PHASE: "grid-column-copy" }, "linux"),
      {
        dataWranglerCoexistence: async () => undefined,
        focusedRInteractive: async () => undefined,
        focusedRLiterateDocuments: async () => undefined,
        packagedGridColumnCopy,
        platformSmoke: async () => undefined,
        pythonEnvironment: async () => undefined,
        releasedJupyter: async () => undefined,
        remoteWorkspace: async () => undefined,
        seed: async () => undefined
      }
    );
    expect(handled).toBe(true);
    expect(packagedGridColumnCopy).toHaveBeenCalledTimes(1);
  });
});

function fakeUri(value: string): { toString(): string } {
  return { toString: () => value };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function activeSession(sourceUri: string) {
  return {
    sessionId: "session-grid-copy",
    metadata: {
      sessionId: "session-grid-copy",
      revision: 0,
      source: { uri: sourceUri },
      shape: { rows: 2_005, columns: 4 },
      filteredShape: { rows: 2_005, columns: 4 },
      filterModel: { logic: "and" as const, filters: [], sort: [] },
      schema: [
        { id: "c-row", name: "row_id", position: 0 },
        { id: "c-city", name: "city", position: 1 },
        { id: "c-sales", name: "sales", position: 2 },
        { id: "c-active", name: "active", position: 3 }
      ]
    },
    viewState: {
      selectedColumnId: "c-city",
      filterModel: { logic: "and" as const, filters: [], sort: [] },
      viewport: { firstVisibleRow: 0, scrollLeft: 0 },
      columnWidths: new Map<string, number>()
    }
  };
}

function testingApi(active: ReturnType<typeof activeSession>, session: () => boolean): TestApi {
  return {
    activeSession: () => (session() ? active : undefined),
    diagnostics: () => ({ sessionCount: session() ? 1 : 0 }),
    runtimeRunning: session,
    ensurePanelSynchronized: async () => true,
    request: async (request: { filterModel: typeof active.metadata.filterModel }) => {
      active.metadata.filterModel = request.filterModel;
      active.metadata.filteredShape = { rows: 1_003, columns: 4 };
      return { kind: "page", page: { totalRows: 1_003 } };
    },
    synchronizePanel: async () => true,
    updateViewState: async (_sessionId: string, state: typeof active.viewState) => {
      active.viewState = state;
    }
  } as unknown as TestApi;
}

function successfulSurface(
  setClipboard: (text: string) => void,
  onBeforeCleanup: () => void
): PackagedGridColumnCopySurface {
  return {
    restoreViewport: vi.fn(async () => {
      onBeforeCleanup();
    }),
    activateHeaderCopy: vi.fn(async () => {
      setClipboard(packagedGridColumnCopyExpectedCityText());
      return settledClipboardWriteReceipt();
    }),
    assertHeaderFocused: vi.fn(async () => undefined),
    pressHeaderCopyShortcut: vi.fn(async () => {
      setClipboard(packagedGridColumnCopyExpectedSalesText());
      return settledClipboardWriteReceipt();
    }),
    waitForColumnValues: vi.fn(async () => undefined),
    waitForHeaderCopyState: vi.fn(async () => undefined)
  };
}

function settledClipboardWriteReceipt() {
  return { waitForSettlement: async () => undefined };
}
