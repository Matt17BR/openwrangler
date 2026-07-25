import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import { commands, window, workspace } from "vscode";
import type { BridgeRequestOptions, OpenWranglerBridge } from "../extension/dataBridge";
import { CONFIRMED_FILE_CONFIGURATIONS_STORAGE_KEY } from "../extension/files/confirmedFileConfigurations";
import { OpenWranglerPanel } from "../extension/webviewPanel";
import type {
  ColumnSummary,
  DataBackend,
  GridPage,
  OpenWranglerRequest,
  OpenWranglerResponse,
  SessionMetadata,
  SessionOpenedResponse,
  SessionSource
} from "../shared/protocol";

const metadata: SessionMetadata = {
  protocolVersion: 2,
  sessionId: "session",
  revision: 0,
  backend: "polars",
  mode: "editing",
  source: { kind: "file", label: "sample.csv", path: "sample.csv" },
  capabilities: {
    editable: true,
    lazy: true,
    cancel: false,
    exportCsv: true,
    exportParquet: true,
    notebookInsert: false
  },
  shape: { rows: 2, columns: 1 },
  filteredShape: { rows: 2, columns: 1 },
  filterModel: { filters: [], sort: [] },
  steps: [],
  schema: [{ id: "c:0", name: "city", position: 0, rawType: "String", type: "string", nullable: false }]
};

const page: GridPage = {
  offset: 0,
  limit: 200,
  totalRows: 2,
  columnIds: ["c:0"],
  rows: [
    {
      id: "r:0",
      rowNumber: 0,
      values: [{ kind: "string", raw: "Berlin", display: "Berlin", isNull: false, isNaN: false }]
    }
  ]
};

const summary: ColumnSummary = {
  column: "city",
  type: "string",
  rawType: "String",
  totalCount: 2,
  nullCount: 0,
  nanCount: 0,
  distinctCount: 2,
  topValues: [{ value: "Berlin", count: 1 }]
};

const openedResponse: SessionOpenedResponse = { kind: "sessionOpened", metadata, page, summaries: [] };
const liveHarnesses: Array<{ dispose(): void }> = [];

interface PromptOptions {
  readonly title?: string;
  readonly value?: string;
}

interface PromptPick {
  readonly label: string;
  readonly description?: string;
  readonly detail?: string;
  readonly value: unknown;
  readonly custom?: boolean;
}

const panelPromptMocks = {
  showQuickPick:
    vi.fn<(items: readonly unknown[], options?: PromptOptions, token?: vscode.CancellationToken) => Promise<unknown>>(),
  showInputBox: vi.fn<(options?: PromptOptions, token?: vscode.CancellationToken) => Promise<string | undefined>>()
};

describe("OpenWranglerPanel retained view state", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    panelPromptMocks.showQuickPick.mockReset();
    panelPromptMocks.showQuickPick.mockResolvedValue(undefined);
    panelPromptMocks.showInputBox.mockReset();
    panelPromptMocks.showInputBox.mockResolvedValue(undefined);
    Object.defineProperties(window, {
      showQuickPick: {
        configurable: true,
        value: panelPromptMocks.showQuickPick
      },
      showInputBox: {
        configurable: true,
        value: panelPromptMocks.showInputBox
      }
    });
  });
  afterEach(() => {
    while (liveHarnesses.length) liveHarnesses.pop()?.dispose();
    delete (window as unknown as { showQuickPick?: unknown }).showQuickPick;
    delete (window as unknown as { showInputBox?: unknown }).showInputBox;
  });

  it("loads the production webview as an ES module under a restrictive nonce CSP", async () => {
    const harness = createPanelHarness({ request: vi.fn(async () => openedResponse) });
    await harness.open();
    const script = harness.html.match(/<script type="module" nonce="([A-Za-z0-9]+)" src="([^"]+)"><\/script>/u);
    expect(script).not.toBeNull();
    const nonce = script?.[1];
    expect(harness.html).toContain(`script-src mock-webview 'nonce-${nonce}';`);
    expect(harness.html).toContain("font-src mock-webview;");
    expect(harness.html).not.toContain("script-src 'unsafe-inline'");
    expect(script?.[2].replaceAll("\\", "/")).toBe("file:///extension/media/webview.js");
    expect(harness.html).toContain('data-fetch-column-block-size="16"');
  });

  it("exposes import reconfiguration only for configurable file formats", () => {
    const executeCommand = vi.spyOn(commands, "executeCommand");
    const configurable = createPanelHarness(
      { request: vi.fn(async () => openedResponse) },
      {
        source: {
          kind: "file",
          label: "records.CSV",
          path: "/workspace/records.CSV"
        }
      }
    );
    const parquet = createPanelHarness(
      { request: vi.fn(async () => openedResponse) },
      {
        source: {
          kind: "file",
          label: "records.parquet",
          path: "/workspace/records.parquet"
        }
      }
    );
    const notebook = createPanelHarness(
      { request: vi.fn(async () => openedResponse) },
      {
        source: {
          kind: "notebookVariable",
          label: "frame",
          variableName: "frame",
          uri: "file:///workspace/example.ipynb"
        }
      }
    );

    expect(configurable.html).toContain('data-can-change-import-options="true"');
    expect(parquet.html).toContain('data-can-change-import-options="false"');
    expect(notebook.html).toContain('data-can-change-import-options="false"');
    expect(executeCommand).toHaveBeenCalledWith("setContext", "openWrangler.canChangeImportOptions", true);
    expect(executeCommand).toHaveBeenCalledWith("setContext", "openWrangler.canChangeImportOptions", false);
  });

  it("never routes import reconfiguration to a hidden panel", async () => {
    const executeCommand = vi.spyOn(commands, "executeCommand");
    const reconfigureFileSession = vi.fn(async (): Promise<OpenWranglerResponse> => openedResponse);
    const bridge: OpenWranglerBridge = {
      request: vi.fn(async () => openedResponse),
      reconfigureFileSession,
      setActiveSession: vi.fn()
    };
    const harness = createPanelHarness(bridge, {
      source: {
        kind: "file",
        label: "records.csv",
        path: "/workspace/records.csv"
      }
    });
    await harness.open();
    panelPromptMocks.showQuickPick.mockClear();
    panelPromptMocks.showInputBox.mockClear();
    executeCommand.mockClear();

    harness.deactivate();
    const handled = await OpenWranglerPanel.changeActiveImportOptions();

    expect(handled).toBe(false);
    expect(panelPromptMocks.showQuickPick).not.toHaveBeenCalled();
    expect(panelPromptMocks.showInputBox).not.toHaveBeenCalled();
    expect(reconfigureFileSession).not.toHaveBeenCalled();
    expect(bridge.setActiveSession).toHaveBeenLastCalledWith(undefined);
    expect(executeCommand).toHaveBeenLastCalledWith("setContext", "openWrangler.canChangeImportOptions", false);
  });

  it("routes the native import command through the active renderer once its readiness handshake completes", async () => {
    const source: SessionSource = {
      kind: "file",
      label: "records.csv",
      path: "/workspace/records.csv",
      uri: "file:///workspace/records.csv",
      importOptions: { delimiter: ",", encoding: "utf-8", quoteChar: '"', hasHeader: true }
    };
    const opened = responseForSource(source);
    const reconfigureFileSession = vi.fn(async (): Promise<OpenWranglerResponse> => opened);
    const harness = createPanelHarness(
      {
        request: vi.fn(async () => opened),
        reconfigureFileSession
      },
      { source, openResponse: opened }
    );
    await harness.open();
    await harness.receive({ kind: "ready" });
    await acknowledgeLatestRendererSynchronization(harness);
    configureDelimitedPrompts({
      delimiter: ",",
      encoding: "utf-8",
      quoteChar: '"',
      hasHeader: true
    });
    harness.posted.length = 0;

    const command = OpenWranglerPanel.changeActiveImportOptions();
    await vi.waitFor(() => expect(harness.posted.some((message) => isRendererImportRequest(message))).toBe(true));
    const rendererRequest = harness.posted.find(isRendererImportRequest);
    if (!rendererRequest) throw new Error("The panel did not publish a renderer import request.");
    const rendererResponse = harness.receive({
      kind: "changeImportOptions",
      actionId: rendererRequest.actionId
    });
    await expect(command).resolves.toBe(true);
    await rendererResponse;

    expect(rendererRequest).toEqual({
      kind: "requestImportOptionsChange",
      actionId: expect.stringMatching(/^[A-Za-z0-9]{32}$/u)
    });
    expect(panelPromptMocks.showQuickPick).toHaveBeenCalled();
    expect(reconfigureFileSession).toHaveBeenCalledOnce();
  });

  it("requires a fresh synchronization acknowledgement after an already hydrated renderer pulls again", async () => {
    const source: SessionSource = {
      kind: "file",
      label: "records.csv",
      path: "/workspace/records.csv",
      uri: "file:///workspace/records.csv",
      importOptions: { delimiter: ",", encoding: "utf-8", quoteChar: '"', hasHeader: true }
    };
    const opened = responseForSource(source);
    const configured = responseForSource(
      {
        ...source,
        importOptions: { delimiter: ";", encoding: "utf-8", quoteChar: '"', hasHeader: true }
      },
      1
    );
    const reconfigureFileSession = vi.fn(async (): Promise<OpenWranglerResponse> => configured);
    const harness = createPanelHarness(
      {
        request: vi.fn(async () => opened),
        reconfigureFileSession
      },
      { source, openResponse: opened }
    );
    await harness.open();
    await harness.receive({ kind: "ready" });
    const firstSynchronization = await acknowledgeLatestRendererSynchronization(harness);
    await harness.receive({ kind: "requestSessionSnapshot" });
    const secondSynchronization = latestRendererSynchronization(harness.posted);
    expect(secondSynchronization.syncId).not.toBe(firstSynchronization.syncId);
    await harness.receive({
      kind: "rendererSynchronized",
      syncId: firstSynchronization.syncId,
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision
    });
    configureDelimitedPrompts({
      delimiter: ";",
      encoding: "utf-8",
      quoteChar: '"',
      hasHeader: true
    });
    harness.posted.length = 0;

    await expect(OpenWranglerPanel.changeActiveImportOptions()).resolves.toBe(true);

    expect(reconfigureFileSession).toHaveBeenCalledOnce();
    expect(harness.posted).not.toContainEqual({ kind: "requestImportOptionsChange" });
  });

  it("replays retained state when an unhydrated renderer pulls its snapshot", async () => {
    const source: SessionSource = {
      kind: "file",
      label: "records.csv",
      path: "/workspace/records.csv",
      uri: "file:///workspace/records.csv",
      importOptions: { delimiter: ",", encoding: "utf-8", quoteChar: '"', hasHeader: true }
    };
    const opened = responseForSource(source);
    const harness = createPanelHarness(
      {
        request: vi.fn(async () => opened)
      },
      { source, openResponse: opened }
    );
    await harness.open();
    harness.posted.length = 0;

    await harness.receive({ kind: "requestSessionSnapshot" });

    expect(harness.posted.slice(0, 2)).toEqual([opened, { kind: "importOptionsState", busy: false }]);
    expect(latestRendererSynchronization(harness.posted)).toMatchObject({
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision
    });
  });

  it("retains a host-side import failure when an older synchronization is acknowledged during publication", async () => {
    const source: SessionSource = {
      kind: "file",
      label: "records.csv",
      path: "/workspace/records.csv",
      uri: "file:///workspace/records.csv",
      importOptions: { delimiter: ",", encoding: "utf-8", quoteChar: '"', hasHeader: true }
    };
    const opened = responseForSource(source);
    const failure: OpenWranglerResponse = {
      kind: "error",
      code: "invalid_import_options",
      message: "The selected delimiter does not match this file.",
      recoverable: true,
      sessionId: opened.metadata.sessionId
    };
    const heldFailurePublication = deferred<boolean>();
    const harness = createPanelHarness(
      {
        request: vi.fn(async () => opened),
        reconfigureFileSession: vi.fn(async (): Promise<OpenWranglerResponse> => failure)
      },
      {
        source,
        openResponse: opened,
        postMessage: (message) =>
          typeof message === "object" && message !== null && (message as { kind?: unknown }).kind === "error"
            ? heldFailurePublication.promise
            : Promise.resolve(true)
      }
    );
    await harness.open();
    await harness.receive({ kind: "ready" });
    const olderSynchronization = latestRendererSynchronization(harness.posted);
    configureDelimitedPrompts({
      delimiter: ";",
      encoding: "utf-8",
      quoteChar: '"',
      hasHeader: true
    });
    harness.posted.length = 0;

    const changing = OpenWranglerPanel.changeActiveImportOptions();
    await vi.waitFor(() => expect(harness.posted).toContainEqual(failure));
    await harness.receive({
      kind: "rendererSynchronized",
      syncId: olderSynchronization.syncId,
      sessionId: olderSynchronization.sessionId,
      revision: olderSynchronization.revision
    });
    heldFailurePublication.resolve(true);
    await changing;

    harness.posted.length = 0;
    await harness.receive({ kind: "requestSessionSnapshot" });

    expect(harness.posted).toContainEqual(opened);
    expect(harness.posted).toContainEqual(failure);
    expect(harness.posted.indexOf(opened)).toBeLessThan(harness.posted.indexOf(failure));
    expect(latestRendererSynchronization(harness.posted)).toMatchObject({
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision
    });
  });

  it("falls back exactly once when a hydrated renderer does not acknowledge a native import action", async () => {
    vi.useFakeTimers();
    try {
      const source: SessionSource = {
        kind: "file",
        label: "records.csv",
        path: "/workspace/records.csv",
        uri: "file:///workspace/records.csv",
        importOptions: { delimiter: ",", encoding: "utf-8", quoteChar: '"', hasHeader: true }
      };
      const opened = responseForSource(source);
      const configured = responseForSource(
        {
          ...source,
          importOptions: { delimiter: ";", encoding: "utf-8", quoteChar: '"', hasHeader: true }
        },
        1
      );
      const reconfigureFileSession = vi.fn(async (): Promise<OpenWranglerResponse> => configured);
      const harness = createPanelHarness(
        {
          request: vi.fn(async () => opened),
          reconfigureFileSession
        },
        { source, openResponse: opened }
      );
      await harness.open();
      await harness.receive({ kind: "ready" });
      await acknowledgeLatestRendererSynchronization(harness);
      configureDelimitedPrompts({
        delimiter: ";",
        encoding: "utf-8",
        quoteChar: '"',
        hasHeader: true
      });
      harness.posted.length = 0;

      const command = OpenWranglerPanel.changeActiveImportOptions();
      const rendererRequest = harness.posted.find(isRendererImportRequest);
      if (!rendererRequest) throw new Error("The panel did not publish a renderer import request.");
      await vi.advanceTimersByTimeAsync(1_500);
      await command;

      expect(reconfigureFileSession).toHaveBeenCalledOnce();
      await harness.receive({ kind: "changeImportOptions", actionId: rendererRequest.actionId });
      expect(reconfigureFileSession).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces a manual renderer import intent with a pending native action", async () => {
    vi.useFakeTimers();
    try {
      const source: SessionSource = {
        kind: "file",
        label: "records.csv",
        path: "/workspace/records.csv",
        uri: "file:///workspace/records.csv",
        importOptions: { delimiter: ",", encoding: "utf-8", quoteChar: '"', hasHeader: true }
      };
      const opened = responseForSource(source);
      const configured = responseForSource(
        {
          ...source,
          importOptions: { delimiter: ";", encoding: "utf-8", quoteChar: '"', hasHeader: true }
        },
        1
      );
      const reconfigureFileSession = vi.fn(async (): Promise<OpenWranglerResponse> => configured);
      const harness = createPanelHarness(
        {
          request: vi.fn(async () => opened),
          reconfigureFileSession
        },
        { source, openResponse: opened }
      );
      await harness.open();
      await harness.receive({ kind: "ready" });
      await acknowledgeLatestRendererSynchronization(harness);
      configureDelimitedPrompts({
        delimiter: ";",
        encoding: "utf-8",
        quoteChar: '"',
        hasHeader: true
      });
      harness.posted.length = 0;

      const command = OpenWranglerPanel.changeActiveImportOptions();
      const rendererRequest = harness.posted.find(isRendererImportRequest);
      if (!rendererRequest) throw new Error("The panel did not publish a renderer import request.");
      const manualIntent = harness.receive({ kind: "changeImportOptions" });
      await expect(command).resolves.toBe(true);
      await manualIntent;
      await vi.advanceTimersByTimeAsync(1_500);

      expect(reconfigureFileSession).toHaveBeenCalledOnce();
      await harness.receive({ kind: "changeImportOptions", actionId: rendererRequest.actionId });
      expect(reconfigureFileSession).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs the native import command in the host before the renderer first becomes ready", async () => {
    const source: SessionSource = {
      kind: "file",
      label: "records.csv",
      path: "/workspace/records.csv",
      uri: "file:///workspace/records.csv",
      importOptions: { delimiter: ",", encoding: "utf-8", quoteChar: '"', hasHeader: true }
    };
    const opened = responseForSource(source);
    const configured = responseForSource(
      {
        ...source,
        importOptions: { delimiter: ";", encoding: "utf-8", quoteChar: '"', hasHeader: true }
      },
      1
    );
    const reconfigureFileSession = vi.fn(
      async (
        _sessionId: string,
        _revision: number,
        _nextSource: SessionSource,
        _options?: BridgeRequestOptions
      ): Promise<OpenWranglerResponse> => configured
    );
    const harness = createPanelHarness(
      {
        request: vi.fn(async () => opened),
        reconfigureFileSession
      },
      { source, openResponse: opened }
    );
    await harness.open();
    configureDelimitedPrompts({
      delimiter: ";",
      encoding: "utf-8",
      quoteChar: '"',
      hasHeader: true
    });
    harness.posted.length = 0;

    await expect(OpenWranglerPanel.changeActiveImportOptions()).resolves.toBe(true);

    expect(panelPromptMocks.showQuickPick).toHaveBeenCalledTimes(3);
    expect(panelPromptMocks.showInputBox).toHaveBeenCalledOnce();
    expect(reconfigureFileSession).toHaveBeenCalledOnce();
    expect(reconfigureFileSession.mock.calls[0]?.[2].importOptions).toEqual(configured.metadata.source.importOptions);
    expect(harness.posted).toEqual([
      { kind: "importOptionsState", busy: true },
      configured,
      { kind: "importOptionsState", busy: false }
    ]);
    expect(harness.posted).not.toContainEqual({ kind: "requestImportOptionsChange" });

    harness.posted.length = 0;
    await harness.receive({ kind: "ready" });

    expect(harness.posted.slice(0, 2)).toEqual([{ kind: "stepInspectionCleared", resumeProfiling: false }, configured]);
    expect(harness.posted).toContainEqual({ kind: "importOptionsState", busy: false });
    expect(latestRendererSynchronization(harness.posted)).toMatchObject({
      sessionId: configured.metadata.sessionId,
      revision: configured.metadata.revision
    });
  });

  it("replays a pre-renderer native import failure after restoring the confirmed snapshot", async () => {
    const source: SessionSource = {
      kind: "file",
      label: "records.csv",
      path: "/workspace/records.csv",
      uri: "file:///workspace/records.csv",
      importOptions: { delimiter: ",", encoding: "utf-8", quoteChar: '"', hasHeader: true }
    };
    const opened = responseForSource(source);
    const failure: OpenWranglerResponse = {
      kind: "error",
      code: "invalid_import_options",
      message: "The selected delimiter does not match this file.",
      recoverable: true
    };
    const reconfigureFileSession = vi.fn(async (): Promise<OpenWranglerResponse> => failure);
    const harness = createPanelHarness(
      {
        request: vi.fn(async () => opened),
        reconfigureFileSession
      },
      { source, openResponse: opened }
    );
    await harness.open();
    configureDelimitedPrompts({
      delimiter: ";",
      encoding: "utf-8",
      quoteChar: '"',
      hasHeader: true
    });
    harness.posted.length = 0;

    await expect(OpenWranglerPanel.changeActiveImportOptions()).resolves.toBe(true);

    expect(harness.posted).toEqual([
      { kind: "importOptionsState", busy: true },
      failure,
      { kind: "importOptionsState", busy: false }
    ]);

    harness.posted.length = 0;
    await harness.receive({ kind: "ready" });

    expect(harness.posted.slice(0, 3)).toEqual([
      { kind: "stepInspectionCleared", resumeProfiling: false },
      opened,
      failure
    ]);
    expect(harness.posted).toContainEqual({ kind: "importOptionsState", busy: false });
    expect(latestRendererSynchronization(harness.posted)).toMatchObject({
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision
    });
  });

  it("does not let an initially hidden panel replace the active command target", async () => {
    const executeCommand = vi.spyOn(commands, "executeCommand");
    const active = createPanelHarness(
      { request: vi.fn(async () => openedResponse) },
      {
        source: {
          kind: "file",
          label: "records.csv",
          path: "/workspace/records.csv"
        }
      }
    );
    await active.open();
    executeCommand.mockClear();

    createPanelHarness(
      { request: vi.fn(async () => openedResponse) },
      {
        active: false,
        source: {
          kind: "file",
          label: "other.parquet",
          path: "/workspace/other.parquet"
        }
      }
    );

    expect(executeCommand).not.toHaveBeenCalledWith("setContext", "openWrangler.canChangeImportOptions", false);
  });

  it("clamps an out-of-range horizontal block setting before exposing or requesting it", async () => {
    vi.spyOn(workspace, "getConfiguration").mockImplementation(
      () =>
        ({
          get: (key: string, fallback?: unknown): unknown => (key === "fetchColumnBlockSize" ? 999 : fallback)
        }) as vscode.WorkspaceConfiguration
    );
    const request = vi.fn(async (_request: OpenWranglerRequest): Promise<OpenWranglerResponse> => openedResponse);
    const harness = createPanelHarness({ request }, { delegateOpen: true });

    expect(harness.html).toContain('data-fetch-column-block-size="256"');
    expect(request).not.toHaveBeenCalled();
    await harness.open();
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      kind: "openSession",
      columnOffset: 0,
      columnLimit: 256
    });
  });

  it("rejects a stale profile from an older opaque view even when metadata and filters match", async () => {
    let resolveStaleSummary: ((response: OpenWranglerResponse) => void) | undefined;
    let resolveStaleStats: ((response: OpenWranglerResponse) => void) | undefined;
    const bridge: OpenWranglerBridge = {
      request: vi.fn((request: OpenWranglerRequest) => {
        if (request.kind === "getSummary") {
          return new Promise<OpenWranglerResponse>((resolve) => {
            resolveStaleSummary = resolve;
          });
        }
        if (request.kind === "getDatasetStats") {
          return new Promise<OpenWranglerResponse>((resolve) => {
            resolveStaleStats = resolve;
          });
        }
        if (request.kind === "getPage") {
          return Promise.resolve<OpenWranglerResponse>({
            kind: "page",
            revision: metadata.revision,
            viewRequestId: request.viewRequestId,
            metadata,
            page
          });
        }
        throw new Error(`Unexpected request ${request.kind}`);
      }),
      setViewContext: vi.fn()
    };
    const harness = createPanelHarness(bridge);
    await harness.open();

    await harness.send({ kind: "setViewContext", viewContextId: "view-a" });
    const stale = harness.send({
      kind: "runtimeRequest",
      viewContextId: "view-a",
      request: {
        kind: "getSummary",
        viewRequestId: "summary-a",
        filterModel: metadata.filterModel,
        columns: ["city"]
      }
    });
    const staleStats = harness.send({
      kind: "runtimeRequest",
      viewContextId: "view-a",
      request: {
        kind: "getDatasetStats",
        viewRequestId: "stats-a",
        filterModel: metadata.filterModel
      }
    });

    await harness.send(pageMessage("page-b", "view-b"));
    await harness.send({ kind: "setViewContext", viewContextId: "view-b" });
    await harness.send(pageMessage("page-a-again", "view-a-again"));
    await harness.send({ kind: "setViewContext", viewContextId: "view-a-again" });
    resolveStaleSummary?.({
      kind: "summary",
      revision: metadata.revision,
      viewRequestId: "summary-a",
      summaries: [summary]
    });
    resolveStaleStats?.({
      kind: "datasetStats",
      revision: metadata.revision,
      viewRequestId: "stats-a",
      stats: { missingCells: 1, missingRows: 1, duplicateRows: 0, missingValuesByColumn: [] }
    });
    await Promise.all([stale, staleStats]);

    await harness.send({ kind: "ready" });
    const retained = [...harness.posted]
      .reverse()
      .find((message): message is SessionOpenedResponse => isSessionOpenedResponse(message));
    if (!retained) throw new Error("The panel did not retain the opened session response.");
    expect(retained.kind).toBe("sessionOpened");
    expect(retained.summaries).toEqual([]);
    expect(retained.metadata.stats).toBeUndefined();
    expect(bridge.setViewContext).toHaveBeenLastCalledWith("session", "view-a-again");
  });

  it("retains profiles only while subsequent pages stay in the same opaque view", async () => {
    const bridge: OpenWranglerBridge = {
      request: vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
        if (request.kind === "getSummary") {
          return {
            kind: "summary",
            revision: metadata.revision,
            viewRequestId: request.viewRequestId,
            summaries: [summary]
          };
        }
        if (request.kind === "getDatasetStats") {
          return {
            kind: "datasetStats",
            revision: metadata.revision,
            viewRequestId: request.viewRequestId,
            stats: { missingCells: 0, missingRows: 0, duplicateRows: 0, missingValuesByColumn: [] }
          };
        }
        if (request.kind === "getPage") {
          return {
            kind: "page",
            revision: metadata.revision,
            viewRequestId: request.viewRequestId,
            metadata,
            page: { ...page, offset: 200 }
          };
        }
        throw new Error(`Unexpected request ${request.kind}`);
      })
    };
    const harness = createPanelHarness(bridge);
    await harness.open();
    await harness.send({ kind: "setViewContext", viewContextId: "current-view" });
    await harness.send({
      kind: "runtimeRequest",
      viewContextId: "current-view",
      request: {
        kind: "getSummary",
        viewRequestId: "current-summary",
        filterModel: metadata.filterModel,
        columns: ["city"]
      }
    });
    await harness.send({
      kind: "runtimeRequest",
      viewContextId: "current-view",
      request: {
        kind: "getDatasetStats",
        viewRequestId: "current-stats",
        filterModel: metadata.filterModel
      }
    });
    await harness.send(pageMessage("same-view-next-page", "current-view"));
    await harness.send({ kind: "ready" });

    const retained = [...harness.posted]
      .reverse()
      .find((message): message is SessionOpenedResponse => isSessionOpenedResponse(message));
    if (!retained) throw new Error("The panel did not retain the opened session response.");
    expect(retained.summaries).toEqual([summary]);
    expect(retained.metadata.stats?.missingCells).toBe(0);
    expect(retained.page.offset).toBe(200);
  });

  it("forwards only validated queued-view cancellation messages", async () => {
    const bridge: OpenWranglerBridge = {
      request: vi.fn(async () => openedResponse),
      cancelViewRequests: vi.fn()
    };
    const harness = createPanelHarness(bridge);
    await harness.open();

    await harness.send({ kind: "cancelViewRequests", viewRequestIds: ["summary-a", "stats-a"] });
    await harness.send({ kind: "cancelViewRequests", viewRequestIds: ["", 3] });

    expect(bridge.cancelViewRequests).toHaveBeenCalledTimes(1);
    expect(bridge.cancelViewRequests).toHaveBeenCalledWith("session", ["summary-a", "stats-a"]);
  });

  it("round-trips only validated host-owned grid presentation state", async () => {
    const state = {
      columnWidths: { "c:0": 260 },
      selectedColumnId: "c:0",
      viewport: { firstVisibleRow: 1, scrollLeft: 44 }
    };
    const bridge: OpenWranglerBridge = {
      request: vi.fn(async () => openedResponse),
      getViewState: vi.fn(() => state),
      updateViewState: vi.fn(async () => undefined)
    };
    const harness = createPanelHarness(bridge);
    await harness.open();

    await harness.send({ kind: "ready" });
    expect(harness.posted).toContainEqual({ kind: "viewState", state });

    await harness.send({ kind: "updateViewState", state });
    await harness.send({
      kind: "updateViewState",
      state: { ...state, columnWidths: { "c:0": 20 } }
    });
    await harness.send({
      kind: "updateViewState",
      state: { ...state, viewport: { firstVisibleRow: Number.NaN, scrollLeft: 0 } }
    });

    expect(bridge.updateViewState).toHaveBeenCalledOnce();
    expect(bridge.updateViewState).toHaveBeenCalledWith("session", state);
  });

  it("rejects a late renderer view-state write while import reconfiguration owns the session", async () => {
    const source: SessionSource = {
      kind: "file",
      label: "sample.csv",
      path: "/workspace/sample.csv",
      uri: "file:///workspace/sample.csv",
      importOptions: { delimiter: ",", encoding: "utf-8", quoteChar: '"', hasHeader: true }
    };
    const initial = responseForSource(source, 2);
    const replacement = deferred<OpenWranglerResponse>();
    const authoritativeState = {
      columnWidths: { "c:0": 245 },
      selectedColumnId: "c:0",
      viewport: { firstVisibleRow: 1, scrollLeft: 18 }
    };
    const updateViewState = vi.fn(async () => undefined);
    const reconfigureFileSession = vi.fn(async () => replacement.promise);
    const harness = createPanelHarness(
      {
        request: vi.fn(async () => initial),
        reconfigureFileSession,
        getViewState: vi.fn(() => authoritativeState),
        updateViewState
      },
      { source, openResponse: initial }
    );
    await harness.open();
    harness.posted.length = 0;
    configureDelimitedPrompts({
      delimiter: ";",
      encoding: "utf-8",
      quoteChar: '"',
      hasHeader: true
    });

    const changing = harness.receive({ kind: "changeImportOptions" });
    await vi.waitFor(() => expect(reconfigureFileSession).toHaveBeenCalledOnce());
    await harness.receive({
      kind: "updateViewState",
      state: {
        columnWidths: { "c:0": 310 },
        selectedColumnId: "c:0",
        viewport: { firstVisibleRow: 0, scrollLeft: 0 }
      }
    });

    expect(updateViewState).not.toHaveBeenCalled();
    expect(harness.posted.at(-1)).toEqual({ kind: "viewState", state: authoritativeState });

    replacement.resolve(
      responseForSource(
        {
          ...source,
          importOptions: { delimiter: ";", encoding: "utf-8", quoteChar: '"', hasHeader: true }
        },
        3
      )
    );
    await changing;
  });

  it("re-publishes the import lock after restoring a recreated renderer", async () => {
    const source: SessionSource = {
      kind: "file",
      label: "sample.csv",
      path: "/workspace/sample.csv",
      uri: "file:///workspace/sample.csv",
      importOptions: { delimiter: ",", encoding: "utf-8", quoteChar: '"', hasHeader: true }
    };
    const initial = responseForSource(source, 2);
    const replacement = deferred<OpenWranglerResponse>();
    const reconfigureFileSession = vi.fn(async () => replacement.promise);
    const harness = createPanelHarness(
      {
        request: vi.fn(async () => initial),
        reconfigureFileSession
      },
      { source, openResponse: initial }
    );
    await harness.open();
    configureDelimitedPrompts({
      delimiter: ";",
      encoding: "utf-8",
      quoteChar: '"',
      hasHeader: true
    });

    const changing = harness.receive({ kind: "changeImportOptions" });
    await vi.waitFor(() => expect(reconfigureFileSession).toHaveBeenCalledOnce());
    harness.posted.length = 0;
    await harness.receive({ kind: "ready" });

    expect(harness.posted).toContainEqual(initial);
    expect(harness.posted).toContainEqual({ kind: "importOptionsState", busy: true });
    expect(latestRendererSynchronization(harness.posted)).toMatchObject({
      sessionId: initial.metadata.sessionId,
      revision: initial.metadata.revision
    });

    replacement.resolve(
      responseForSource(
        {
          ...source,
          importOptions: { delimiter: ";", encoding: "utf-8", quoteChar: '"', hasHeader: true }
        },
        3
      )
    );
    await changing;
  });

  it("forwards only validated applied-step inspection and host-clear messages with correlation", async () => {
    const inspectionPage = {
      ...page,
      offset: 200,
      rows: [{ ...page.rows[0], id: "r:200", rowNumber: 200 }]
    };
    const inspection: OpenWranglerResponse = {
      kind: "stepInspection",
      revision: 0,
      stepId: "round-sales",
      stepIndex: 0,
      inputPage: inspectionPage,
      outputPage: inspectionPage,
      inputSchema: metadata.schema,
      outputSchema: metadata.schema,
      diff: {
        addedRows: 0,
        removedRows: 0,
        addedColumns: [],
        removedColumns: [],
        changedCells: 0,
        cells: [],
        truncated: false
      },
      code: "# selected prefix"
    };
    const bridge: OpenWranglerBridge = {
      request: vi.fn(async () => inspection),
      clearStepInspection: vi.fn()
    };
    const harness = createPanelHarness(bridge);
    await harness.open();

    await harness.send({
      kind: "runtimeRequest",
      request: {
        kind: "inspectStep",
        stepId: "round-sales",
        offset: 200,
        limit: 200,
        columnOffset: 0,
        columnLimit: 16
      }
    });
    await harness.send({ kind: "clearStepInspection" });
    await harness.send({ kind: "clearStepInspection", unexpected: true });
    await harness.send({
      kind: "runtimeRequest",
      request: { kind: "inspectStep", stepId: "", offset: 0, limit: 200, columnOffset: 0, columnLimit: 16 }
    });

    expect(bridge.request).toHaveBeenCalledOnce();
    expect(bridge.request).toHaveBeenCalledWith(
      {
        kind: "inspectStep",
        sessionId: "session",
        revision: 0,
        stepId: "round-sales",
        offset: 200,
        limit: 200,
        columnOffset: 0,
        columnLimit: 16
      },
      undefined
    );
    expect(bridge.clearStepInspection).toHaveBeenCalledOnce();
    expect(bridge.clearStepInspection).toHaveBeenCalledWith("session");
    expect(harness.posted).toContainEqual({
      kind: "stepInspectionResult",
      stepId: "round-sales",
      offset: 200,
      limit: 200,
      columnOffset: 0,
      columnLimit: 16,
      response: inspection
    });
  });

  it("clears retained and recreated inspection state when the active panel changes", async () => {
    const firstBridge: OpenWranglerBridge = {
      request: vi.fn(async () => openedResponse),
      clearStepInspection: vi.fn(),
      setActiveSession: vi.fn()
    };
    const secondResponse: SessionOpenedResponse = {
      ...openedResponse,
      metadata: { ...metadata, sessionId: "second-session" }
    };
    const secondBridge: OpenWranglerBridge = {
      request: vi.fn(async () => secondResponse),
      clearStepInspection: vi.fn(),
      setActiveSession: vi.fn()
    };
    const first = createPanelHarness(firstBridge);
    await first.open();
    first.posted.length = 0;
    const second = createPanelHarness(secondBridge, { openResponse: secondResponse });
    await second.open();

    expect(first.posted).toContainEqual({ kind: "stepInspectionCleared", resumeProfiling: false });
    expect(second.posted).toContainEqual({ kind: "stepInspectionCleared", resumeProfiling: true });
    expect(secondBridge.setActiveSession).toHaveBeenLastCalledWith("second-session");

    first.posted.length = 0;
    second.posted.length = 0;
    first.activate();

    expect(second.posted).toContainEqual({ kind: "stepInspectionCleared", resumeProfiling: false });
    expect(first.posted).toContainEqual({ kind: "stepInspectionCleared", resumeProfiling: true });
    expect(firstBridge.setActiveSession).toHaveBeenLastCalledWith("session");

    vi.mocked(firstBridge.clearStepInspection!).mockClear();
    first.posted.length = 0;
    await first.send({ kind: "ready" });

    expect(firstBridge.clearStepInspection).toHaveBeenCalledWith("session");
    expect(first.posted[0]).toEqual({ kind: "stepInspectionCleared", resumeProfiling: false });
    expect(first.posted).toContainEqual(openedResponse);
  });

  it("rejects malformed or host-owned runtime messages before forwarding", async () => {
    const bridge: OpenWranglerBridge = {
      request: vi.fn(async () => openedResponse)
    };
    const harness = createPanelHarness(bridge);
    await harness.open();
    harness.posted.length = 0;

    await harness.send({
      kind: "runtimeRequest",
      request: {
        kind: "previewStep",
        step: { id: "bad", kind: "renameColumn", params: { columns: ["city"] } },
        offset: 0,
        limit: 200,
        columnOffset: 0,
        columnLimit: 16
      }
    });
    await harness.send({
      kind: "runtimeRequest",
      request: { kind: "exportData", path: "", format: "csv" }
    });
    await harness.send({
      kind: "runtimeRequest",
      request: { kind: "closeSession", force: true }
    });
    await harness.send({ kind: "ready", unexpected: true });
    await harness.send({ kind: "requestSessionSnapshot", unexpected: true });
    await harness.send({
      kind: "rendererSynchronized",
      syncId: "",
      sessionId: "session",
      revision: 0
    });
    await harness.send({
      kind: "rendererSynchronized",
      syncId: "S".repeat(32),
      sessionId: "session",
      revision: -1
    });
    await harness.send({
      kind: "rendererSynchronized",
      syncId: "S".repeat(32),
      sessionId: null,
      revision: 0
    });
    await harness.send({
      kind: "rendererSynchronized",
      syncId: "S".repeat(32),
      sessionId: "session",
      revision: 0,
      unexpected: true
    });

    expect(bridge.request).not.toHaveBeenCalled();
    expect(harness.posted).toEqual([]);
  });

  it("decodes only the exact change-import-options message shape", async () => {
    const source: SessionSource = {
      kind: "file",
      label: "sample.csv",
      path: "/workspace/sample.csv",
      uri: "file:///workspace/sample.csv",
      importOptions: { delimiter: ",", encoding: "utf-8", quoteChar: '"', hasHeader: true }
    };
    const initial = responseForSource(source);
    const harness = createPanelHarness({ request: vi.fn(async () => initial) }, { source, openResponse: initial });
    await harness.open();
    harness.posted.length = 0;

    for (const malformed of [
      null,
      { kind: "changeImportOptions", unexpected: true },
      { kind: "changeImportOptions", request: {} },
      { kind: "changeImportOptions", busy: false },
      { kind: "changeImportOptions", actionId: "short" },
      { kind: "changeImportOptions", actionId: "A".repeat(32), unexpected: true }
    ]) {
      await harness.receive(malformed);
    }

    expect(panelPromptMocks.showQuickPick).not.toHaveBeenCalled();
    expect(harness.posted).toEqual([]);

    await harness.receive({ kind: "changeImportOptions" });

    expect(panelPromptMocks.showQuickPick).toHaveBeenCalledOnce();
    expect(harness.posted).toEqual([
      { kind: "importOptionsState", busy: true },
      { kind: "cancelled", targetRequestId: "change-import-options" },
      { kind: "importOptionsState", busy: false }
    ]);
  });

  it("atomically publishes a successful live import reconfiguration and retains its source and revision", async () => {
    const source: SessionSource = {
      kind: "file",
      label: "sample.csv",
      path: "/workspace/sample.csv",
      uri: "file:///workspace/sample.csv",
      importOptions: { delimiter: ",", encoding: "utf-8", quoteChar: '"', hasHeader: true }
    };
    const initial = responseForSource(source, 2);
    const nextOptions = {
      delimiter: ";",
      encoding: "windows-1252",
      quoteChar: "'",
      hasHeader: false
    } as const;
    let committed: SessionOpenedResponse | undefined;
    const request = vi.fn(async (candidate: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (candidate.kind === "getPage") {
        const current = committed ?? initial;
        return {
          kind: "page",
          revision: candidate.revision,
          viewRequestId: candidate.viewRequestId,
          metadata: current.metadata,
          page
        };
      }
      throw new Error(`Unexpected request ${candidate.kind}`);
    });
    const reconfigureFileSession = vi.fn(
      async (
        _sessionId: string,
        _revision: number,
        nextSource: SessionSource,
        _options?: BridgeRequestOptions
      ): Promise<OpenWranglerResponse> => {
        const opened = responseForSource(nextSource, 7);
        committed = { ...opened, metadata: { ...opened.metadata, backend: "pandas" } };
        return committed;
      }
    );
    const retainedView = {
      columnWidths: { "c:0": 245 },
      selectedColumnId: "c:0",
      viewport: { firstVisibleRow: 1, scrollLeft: 18 }
    };
    const restoredPresentation = () =>
      committed
        ? {
            sessionId: committed.metadata.sessionId,
            revision: committed.metadata.revision,
            code: "# pandas replacement code",
            draft: {
              diff: {
                addedRows: 0,
                removedRows: 0,
                addedColumns: [],
                removedColumns: [],
                changedCells: 1,
                cells: [],
                truncated: false
              },
              warnings: ["replacement warning"],
              beforeSchema: initial.metadata.schema
            }
          }
        : undefined;
    const bridge: OpenWranglerBridge = {
      request,
      reconfigureFileSession,
      getViewState: vi.fn(() => retainedView),
      getSessionPresentation: vi.fn(restoredPresentation),
      setActiveSession: vi.fn()
    };
    const workspaceState = createWorkspaceMemento();
    const harness = createPanelHarness(bridge, {
      source,
      openResponse: initial,
      workspaceState,
      backendPreference: "auto"
    });
    await harness.open();
    harness.posted.length = 0;
    configureDelimitedPrompts(nextOptions);

    await harness.receive({ kind: "changeImportOptions" });

    expect(promptPicksAt(0)[0]).toMatchObject({ value: ",", description: "Current" });
    expect(promptPicksAt(1)[0]).toMatchObject({ value: "utf-8", description: "Current" });
    expect(promptPicksAt(2)[0]).toMatchObject({ value: true, description: "Current" });
    expect(promptInputAt(0)).toMatchObject({ title: "Quote character", value: '"' });
    expect(reconfigureFileSession).toHaveBeenCalledWith(
      "session",
      2,
      { ...source, importOptions: nextOptions },
      {
        cancellation: expect.objectContaining({
          isCancellationRequested: false,
          onCancellationRequested: expect.any(Function)
        })
      }
    );
    expect(harness.posted).toEqual([
      { kind: "importOptionsState", busy: true },
      committed,
      { kind: "sessionPresentation", presentation: restoredPresentation() },
      { kind: "viewState", state: retainedView },
      { kind: "importOptionsState", busy: false }
    ]);
    expect(workspaceState.update).toHaveBeenLastCalledWith(CONFIRMED_FILE_CONFIGURATIONS_STORAGE_KEY, {
      version: 2,
      entries: [{ uri: source.uri, backend: "pandas", backendPreference: "auto", importOptions: nextOptions }]
    });

    harness.posted.length = 0;
    await harness.receive({ kind: "ready" });
    expect(harness.posted).toContainEqual(committed);
    expect(harness.posted).toContainEqual({ kind: "sessionPresentation", presentation: restoredPresentation() });

    await harness.receive(pageMessage("after-import-change", "changed-view"));
    expect(request.mock.calls.at(-1)?.[0]).toMatchObject({
      kind: "getPage",
      sessionId: "session",
      revision: 7
    });

    panelPromptMocks.showQuickPick.mockReset();
    panelPromptMocks.showQuickPick.mockResolvedValue(undefined);
    panelPromptMocks.showInputBox.mockReset();
    await harness.receive({ kind: "changeImportOptions" });
    expect(promptPicksAt(0)[0]).toMatchObject({ value: ";", description: "Current" });
  });

  it("remembers an initial non-default file configuration only after session open is confirmed", async () => {
    const source: SessionSource = {
      kind: "file",
      label: "sample.csv",
      path: "/workspace/sample.csv",
      uri: "file:///workspace/sample.csv",
      importOptions: {
        delimiter: "|",
        encoding: "iso-8859-1",
        quoteChar: "'",
        hasHeader: false
      }
    };
    const workspaceState = createWorkspaceMemento();
    const request = vi.fn(async (): Promise<OpenWranglerResponse> => responseForSource(source, 0));
    const harness = createPanelHarness({ request }, { source, delegateOpen: true, workspaceState });

    expect(workspaceState.update).not.toHaveBeenCalled();
    await harness.open();

    expect(workspaceState.update).toHaveBeenCalledWith(CONFIRMED_FILE_CONFIGURATIONS_STORAGE_KEY, {
      version: 2,
      entries: [
        {
          uri: source.uri,
          backend: "polars",
          backendPreference: "polars",
          importOptions: source.importOptions
        }
      ]
    });
  });

  it("does not remember import options when the initial runtime open is rejected", async () => {
    const source: SessionSource = {
      kind: "file",
      label: "sample.csv",
      path: "/workspace/sample.csv",
      uri: "file:///workspace/sample.csv",
      importOptions: {
        delimiter: "|",
        encoding: "iso-8859-1",
        quoteChar: "'",
        hasHeader: false
      }
    };
    const workspaceState = createWorkspaceMemento();
    const request = vi.fn(async (): Promise<OpenWranglerResponse> => ({
      kind: "error",
      code: "open_failed",
      message: "bad import options",
      recoverable: true
    }));
    const harness = createPanelHarness({ request }, { source, delegateOpen: true, workspaceState });

    await harness.open();

    expect(workspaceState.update).not.toHaveBeenCalled();
  });

  it("remembers the resolved backend for a confirmed Parquet open without import options", async () => {
    const source: SessionSource = {
      kind: "file",
      label: "sample.parquet",
      path: "/workspace/sample.parquet",
      uri: "file:///workspace/sample.parquet"
    };
    const opened = responseForSource(source);
    opened.metadata.backend = "duckdb";
    const workspaceState = createWorkspaceMemento();
    const harness = createPanelHarness(
      { request: vi.fn(async (): Promise<OpenWranglerResponse> => opened) },
      {
        source,
        delegateOpen: true,
        workspaceState,
        backend: "duckdb",
        backendPreference: "auto"
      }
    );

    await harness.open();

    expect(workspaceState.update).toHaveBeenCalledWith(CONFIRMED_FILE_CONFIGURATIONS_STORAGE_KEY, {
      version: 2,
      entries: [{ uri: source.uri, backend: "duckdb", backendPreference: "auto" }]
    });
  });

  it("remembers an already-confirmed replacement even when the panel closes in the response gap", async () => {
    const source: SessionSource = {
      kind: "file",
      label: "sample.csv",
      path: "/workspace/sample.csv",
      uri: "file:///workspace/sample.csv",
      importOptions: { delimiter: ",", encoding: "utf-8", quoteChar: '"', hasHeader: true }
    };
    const nextOptions = {
      delimiter: ";",
      encoding: "windows-1252",
      quoteChar: "'",
      hasHeader: false
    } as const;
    const replacement = deferred<OpenWranglerResponse>();
    const reconfigureFileSession = vi.fn(async () => replacement.promise);
    const workspaceState = createWorkspaceMemento();
    const harness = createPanelHarness(
      {
        request: vi.fn(async () => responseForSource(source)),
        reconfigureFileSession
      },
      { source, openResponse: responseForSource(source), workspaceState }
    );
    await harness.open();
    configureDelimitedPrompts(nextOptions);

    const changing = harness.receive({ kind: "changeImportOptions" });
    await vi.waitFor(() => expect(reconfigureFileSession).toHaveBeenCalledOnce());
    harness.dispose();
    replacement.resolve(responseForSource({ ...source, importOptions: nextOptions }, 1));
    await changing;

    expect(workspaceState.update).toHaveBeenLastCalledWith(CONFIRMED_FILE_CONFIGURATIONS_STORAGE_KEY, {
      version: 2,
      entries: [
        {
          uri: source.uri,
          backend: "polars",
          backendPreference: "polars",
          importOptions: nextOptions
        }
      ]
    });
  });

  it("drains an already-confirmed panel response before publishing a replacement snapshot", async () => {
    const source: SessionSource = {
      kind: "file",
      label: "sample.csv",
      path: "/workspace/sample.csv",
      uri: "file:///workspace/sample.csv",
      importOptions: { delimiter: ",", encoding: "utf-8", quoteChar: '"', hasHeader: true }
    };
    const initial = responseForSource(source, 2);
    const oldPage = deferred<OpenWranglerResponse>();
    const replacement = responseForSource(
      {
        ...source,
        importOptions: { delimiter: ";", encoding: "utf-8", quoteChar: '"', hasHeader: true }
      },
      3
    );
    const request = vi.fn(async (candidate: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (candidate.kind === "getPage") return oldPage.promise;
      throw new Error(`Unexpected request ${candidate.kind}`);
    });
    const reconfigureFileSession = vi.fn(async (): Promise<OpenWranglerResponse> => replacement);
    const harness = createPanelHarness({ request, reconfigureFileSession }, { source, openResponse: initial });
    await harness.open();
    harness.posted.length = 0;
    configureDelimitedPrompts({
      delimiter: ";",
      encoding: "utf-8",
      quoteChar: '"',
      hasHeader: true
    });

    const pendingPage = harness.receive(pageMessage("old-page", "old-view"));
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    const changing = harness.receive({ kind: "changeImportOptions" });
    await vi.waitFor(() => expect(harness.posted).toContainEqual({ kind: "importOptionsState", busy: true }));
    expect(reconfigureFileSession).not.toHaveBeenCalled();

    const confirmedOldPage: OpenWranglerResponse = {
      kind: "page",
      revision: 2,
      viewRequestId: "old-page",
      metadata: initial.metadata,
      page
    };
    oldPage.resolve(confirmedOldPage);
    await Promise.all([pendingPage, changing]);

    expect(reconfigureFileSession).toHaveBeenCalledOnce();
    expect(harness.posted.indexOf(confirmedOldPage)).toBeLessThan(harness.posted.indexOf(replacement));
    harness.posted.length = 0;
    await harness.receive({ kind: "ready" });
    expect(harness.posted).toContainEqual(replacement);
    expect(harness.posted).not.toContainEqual(initial);
  });

  it("keeps the exact confirmed live snapshot and source after prompt cancellation", async () => {
    const source: SessionSource = {
      kind: "file",
      label: "sample.csv",
      path: "/workspace/sample.csv",
      uri: "file:///workspace/sample.csv",
      importOptions: { delimiter: "|", encoding: "utf-8", quoteChar: '"', hasHeader: true }
    };
    const initial = responseForSource(source, 3);
    const reconfigureFileSession = vi.fn(async (): Promise<OpenWranglerResponse> => {
      throw new Error("A cancelled prompt must not reach the bridge.");
    });
    const harness = createPanelHarness(
      { request: vi.fn(async () => initial), reconfigureFileSession },
      { source, openResponse: initial }
    );
    await harness.open();
    harness.posted.length = 0;

    await harness.receive({ kind: "changeImportOptions" });

    expect(reconfigureFileSession).not.toHaveBeenCalled();
    expect(harness.posted).toEqual([
      { kind: "importOptionsState", busy: true },
      { kind: "cancelled", targetRequestId: "change-import-options" },
      { kind: "importOptionsState", busy: false }
    ]);

    harness.posted.length = 0;
    await harness.receive({ kind: "ready" });
    expect(harness.posted).toContainEqual(initial);

    panelPromptMocks.showQuickPick.mockClear();
    await harness.receive({ kind: "changeImportOptions" });
    expect(promptPicksAt(0)[0]).toMatchObject({ value: "|", description: "Current" });
  });

  it("keeps the exact confirmed live snapshot and source after a bridge error", async () => {
    const source: SessionSource = {
      kind: "file",
      label: "sample.csv",
      path: "/workspace/sample.csv",
      uri: "file:///workspace/sample.csv",
      importOptions: { delimiter: ",", encoding: "utf-8", quoteChar: '"', hasHeader: true }
    };
    const initial = responseForSource(source, 4);
    const failure: OpenWranglerResponse = {
      kind: "error",
      code: "invalid_import_options",
      message: "The selected delimiter does not match this file.",
      recoverable: true
    };
    const reconfigureFileSession = vi.fn(async (): Promise<OpenWranglerResponse> => failure);
    const harness = createPanelHarness(
      { request: vi.fn(async () => initial), reconfigureFileSession },
      { source, openResponse: initial }
    );
    await harness.open();
    harness.posted.length = 0;
    configureDelimitedPrompts({
      delimiter: ";",
      encoding: "windows-1252",
      quoteChar: "'",
      hasHeader: false
    });

    await harness.receive({ kind: "changeImportOptions" });

    expect(harness.posted).toEqual([
      { kind: "importOptionsState", busy: true },
      failure,
      { kind: "importOptionsState", busy: false }
    ]);
    harness.posted.length = 0;
    await harness.receive({ kind: "ready" });
    expect(harness.posted).toContainEqual(initial);

    panelPromptMocks.showQuickPick.mockReset();
    panelPromptMocks.showQuickPick.mockResolvedValue(undefined);
    panelPromptMocks.showInputBox.mockReset();
    await harness.receive({ kind: "changeImportOptions" });
    expect(promptPicksAt(0)[0]).toMatchObject({ value: ",", description: "Current" });
  });

  it("keeps the exact confirmed live snapshot and source after a dispatched cancellation", async () => {
    const source: SessionSource = {
      kind: "file",
      label: "sample.csv",
      path: "/workspace/sample.csv",
      uri: "file:///workspace/sample.csv",
      importOptions: { delimiter: ",", encoding: "utf-8", quoteChar: '"', hasHeader: true }
    };
    const initial = responseForSource(source, 5);
    const cancellation: OpenWranglerResponse = {
      kind: "cancelled",
      targetRequestId: "candidate-open"
    };
    const reconfigureFileSession = vi.fn(async (): Promise<OpenWranglerResponse> => cancellation);
    const harness = createPanelHarness(
      { request: vi.fn(async () => initial), reconfigureFileSession },
      { source, openResponse: initial }
    );
    await harness.open();
    harness.posted.length = 0;
    configureDelimitedPrompts({
      delimiter: ";",
      encoding: "utf-8",
      quoteChar: '"',
      hasHeader: true
    });

    await harness.receive({ kind: "changeImportOptions" });

    expect(harness.posted).toEqual([
      { kind: "importOptionsState", busy: true },
      cancellation,
      { kind: "importOptionsState", busy: false }
    ]);
    harness.posted.length = 0;
    await harness.receive({ kind: "ready" });
    expect(harness.posted).toContainEqual(initial);

    panelPromptMocks.showQuickPick.mockReset();
    panelPromptMocks.showQuickPick.mockResolvedValue(undefined);
    panelPromptMocks.showInputBox.mockReset();
    await harness.receive({ kind: "changeImportOptions" });
    expect(promptPicksAt(0)[0]).toMatchObject({ value: ",", description: "Current" });
  });

  it("recovers an initially failed file panel through a fresh configured open", async () => {
    const source: SessionSource = {
      kind: "file",
      label: "sample.csv",
      path: "/workspace/sample.csv",
      uri: "file:///workspace/sample.csv",
      importOptions: { delimiter: ",", encoding: "utf-8", quoteChar: '"', hasHeader: true }
    };
    const initialFailure: OpenWranglerResponse = {
      kind: "error",
      code: "invalid_import_options",
      message: "The initial delimiter was wrong.",
      recoverable: true
    };
    let openCalls = 0;
    const request = vi.fn(
      async (candidate: OpenWranglerRequest, _options?: BridgeRequestOptions): Promise<OpenWranglerResponse> => {
        if (candidate.kind === "openSession") {
          openCalls += 1;
          return openCalls === 1 ? initialFailure : responseForSource(candidate.source, 0);
        }
        if (candidate.kind === "closeSession") {
          return { kind: "sessionClosed", sessionId: candidate.sessionId };
        }
        throw new Error(`Unexpected request ${candidate.kind}`);
      }
    );
    const harness = createPanelHarness({ request }, { source, delegateOpen: true });
    await harness.open();
    configureDelimitedPrompts({
      delimiter: ";",
      encoding: "utf-8",
      quoteChar: '"',
      hasHeader: true
    });

    await harness.receive({ kind: "changeImportOptions" });

    const opens = request.mock.calls.filter(([candidate]) => candidate.kind === "openSession");
    expect(opens).toHaveLength(2);
    expect(opens[1]?.[0]).toMatchObject({
      kind: "openSession",
      source: {
        ...source,
        importOptions: { delimiter: ";", encoding: "utf-8", quoteChar: '"', hasHeader: true }
      }
    });
    expect(opens[1]?.[1]).toEqual({
      cancellation: expect.objectContaining({
        isCancellationRequested: false,
        onCancellationRequested: expect.any(Function)
      }),
      backendPreference: "polars"
    });
    expect(harness.posted).toContainEqual(
      responseForSource(
        {
          ...source,
          importOptions: { delimiter: ";", encoding: "utf-8", quoteChar: '"', hasHeader: true }
        },
        0
      )
    );
  });

  it.each([
    { preference: "auto" as const, expectedRetryBackend: undefined },
    { preference: "pandas" as const, expectedRetryBackend: "pandas" as const }
  ])(
    "uses the logical $preference backend preference when retrying a changed import after initial failure",
    async ({ preference, expectedRetryBackend }) => {
      const source: SessionSource = {
        kind: "file",
        label: "sample.csv",
        path: "/workspace/sample.csv",
        uri: "file:///workspace/sample.csv",
        importOptions: { delimiter: ",", encoding: "utf-8", quoteChar: '"', hasHeader: true }
      };
      const initialFailure: OpenWranglerResponse = {
        kind: "error",
        code: "invalid_import_options",
        message: "The initial delimiter was wrong.",
        recoverable: true
      };
      let openCalls = 0;
      const request = vi.fn(async (candidate: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
        if (candidate.kind === "openSession") {
          openCalls += 1;
          if (openCalls === 1) return initialFailure;
          const opened = responseForSource(candidate.source, 0);
          return { ...opened, metadata: { ...opened.metadata, backend: "pandas" } };
        }
        if (candidate.kind === "closeSession") {
          return { kind: "sessionClosed", sessionId: candidate.sessionId };
        }
        throw new Error(`Unexpected request ${candidate.kind}`);
      });
      const harness = createPanelHarness(
        { request },
        {
          source,
          delegateOpen: true,
          backend: "pandas",
          backendPreference: preference
        }
      );
      await harness.open();
      configureDelimitedPrompts({
        delimiter: ";",
        encoding: "utf-8",
        quoteChar: '"',
        hasHeader: true
      });

      await harness.receive({ kind: "changeImportOptions" });

      const opens = request.mock.calls
        .map(([candidate]) => candidate)
        .filter(
          (candidate): candidate is Extract<OpenWranglerRequest, { kind: "openSession" }> =>
            candidate.kind === "openSession"
        );
      expect(opens).toHaveLength(2);
      expect(opens[0]).toMatchObject({ backend: "pandas" });
      if (expectedRetryBackend === undefined) {
        expect(opens[1]).not.toHaveProperty("backend");
      } else {
        expect(opens[1]).toMatchObject({ backend: expectedRetryBackend });
      }
    }
  );

  it("serializes overlapping changes, cancels the superseded candidate, and publishes only the latest success", async () => {
    const source: SessionSource = {
      kind: "file",
      label: "sample.csv",
      path: "/workspace/sample.csv",
      uri: "file:///workspace/sample.csv",
      importOptions: { delimiter: ",", encoding: "utf-8", quoteChar: '"', hasHeader: true }
    };
    const initial = responseForSource(source);
    const attempts = [
      { delimiter: ";", encoding: "utf-8", quoteChar: '"', hasHeader: true },
      { delimiter: "|", encoding: "windows-1252", quoteChar: "'", hasHeader: false }
    ] as const;
    configureDelimitedPromptAttempts(attempts);
    let activeCandidates = 0;
    let maximumActiveCandidates = 0;
    let candidateNumber = 0;
    const reconfigureFileSession = vi.fn(
      (
        _sessionId: string,
        _revision: number,
        nextSource: SessionSource,
        options?: BridgeRequestOptions
      ): Promise<OpenWranglerResponse> => {
        const currentCandidate = candidateNumber;
        candidateNumber += 1;
        activeCandidates += 1;
        maximumActiveCandidates = Math.max(maximumActiveCandidates, activeCandidates);
        if (currentCandidate === 0) {
          return new Promise((resolve) => {
            const finish = (): void => {
              activeCandidates -= 1;
              resolve({ kind: "cancelled", targetRequestId: "candidate-a" });
            };
            if (options?.cancellation?.isCancellationRequested) finish();
            else options?.cancellation?.onCancellationRequested(finish);
          });
        }
        activeCandidates -= 1;
        return Promise.resolve(responseForSource(nextSource, 8));
      }
    );
    const harness = createPanelHarness(
      { request: vi.fn(async () => initial), reconfigureFileSession },
      { source, openResponse: initial }
    );
    await harness.open();
    harness.posted.length = 0;

    const first = harness.receive({ kind: "changeImportOptions" });
    await vi.waitFor(() => expect(reconfigureFileSession).toHaveBeenCalledTimes(1));
    const second = harness.receive({ kind: "changeImportOptions" });
    await Promise.all([first, second]);

    expect(reconfigureFileSession).toHaveBeenCalledTimes(2);
    expect(reconfigureFileSession.mock.calls[0]?.[2].importOptions).toEqual(attempts[0]);
    expect(reconfigureFileSession.mock.calls[1]?.[2].importOptions).toEqual(attempts[1]);
    expect(reconfigureFileSession.mock.calls[0]?.[3]?.cancellation?.isCancellationRequested).toBe(true);
    expect(reconfigureFileSession.mock.calls[1]?.[3]?.cancellation?.isCancellationRequested).toBe(false);
    expect(maximumActiveCandidates).toBe(1);
    expect(harness.posted).toEqual([
      { kind: "importOptionsState", busy: true },
      responseForSource({ ...source, importOptions: attempts[1] }, 8),
      { kind: "importOptionsState", busy: false }
    ]);
  });

  it("adopts a confirmed replacement before a deferred persistence write so the next change uses it", async () => {
    const source: SessionSource = {
      kind: "file",
      label: "sample.csv",
      path: "/workspace/sample.csv",
      uri: "file:///workspace/sample.csv",
      importOptions: { delimiter: ",", encoding: "utf-8", quoteChar: '"', hasHeader: true }
    };
    const attempts = [
      { delimiter: ";", encoding: "utf-8", quoteChar: '"', hasHeader: true },
      { delimiter: "|", encoding: "windows-1252", quoteChar: "'", hasHeader: false }
    ] as const;
    configureDelimitedPromptAttempts(attempts);
    const initial = responseForSource(source, 2);
    const firstOpened = responseForSource({ ...source, importOptions: attempts[0] }, 7);
    firstOpened.metadata.backend = "pandas";
    const secondOpened = responseForSource({ ...source, importOptions: attempts[1] }, 8);
    secondOpened.metadata.backend = "pandas";
    const reconfigureFileSession = vi
      .fn<
        (
          sessionId: string,
          revision: number,
          source: SessionSource,
          options?: BridgeRequestOptions
        ) => Promise<OpenWranglerResponse>
      >()
      .mockResolvedValueOnce(firstOpened)
      .mockResolvedValueOnce(secondOpened);
    const workspaceState = createWorkspaceMemento();
    const harness = createPanelHarness(
      {
        request: vi.fn(async () => initial),
        reconfigureFileSession
      },
      { source, openResponse: initial, workspaceState, backendPreference: "auto" }
    );
    await harness.open();
    const persistedFirstReplacement = deferred<void>();
    workspaceState.update.mockImplementationOnce(async (key: string, value: unknown): Promise<void> => {
      workspaceState.values.set(key, value);
      await persistedFirstReplacement.promise;
    });
    harness.posted.length = 0;

    const first = harness.receive({ kind: "changeImportOptions" });
    await vi.waitFor(() => expect(reconfigureFileSession).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(workspaceState.update).toHaveBeenCalledTimes(2));
    const second = harness.receive({ kind: "changeImportOptions" });
    expect(reconfigureFileSession).toHaveBeenCalledTimes(1);

    persistedFirstReplacement.resolve();
    await Promise.all([first, second]);

    expect(reconfigureFileSession).toHaveBeenCalledTimes(2);
    expect(reconfigureFileSession.mock.calls[1]?.[0]).toBe("session");
    expect(reconfigureFileSession.mock.calls[1]?.[1]).toBe(7);
    expect(reconfigureFileSession.mock.calls[1]?.[2]).toEqual({
      ...firstOpened.metadata.source,
      importOptions: attempts[1]
    });
    expect(promptPicksAt(3)[0]).toMatchObject({ value: ";", description: "Current" });
    expect(harness.posted).not.toContainEqual(firstOpened);
    expect(harness.posted).toContainEqual(secondOpened);
  });

  it("publishes a committed replacement when its superseding import prompt is cancelled", async () => {
    const source: SessionSource = {
      kind: "file",
      label: "sample.csv",
      path: "/workspace/sample.csv",
      uri: "file:///workspace/sample.csv",
      importOptions: { delimiter: ",", encoding: "utf-8", quoteChar: '"', hasHeader: true }
    };
    const firstOptions = { delimiter: ";", encoding: "utf-8", quoteChar: '"', hasHeader: true } as const;
    const initial = responseForSource(source, 2);
    const firstOpened = responseForSource({ ...source, importOptions: firstOptions }, 7);
    const reconfigureFileSession = vi.fn(async (): Promise<OpenWranglerResponse> => firstOpened);
    const workspaceState = createWorkspaceMemento();
    const harness = createPanelHarness(
      {
        request: vi.fn(async () => initial),
        reconfigureFileSession
      },
      { source, openResponse: initial, workspaceState }
    );
    await harness.open();
    const persistedFirstReplacement = deferred<void>();
    workspaceState.update.mockImplementationOnce(async (key: string, value: unknown): Promise<void> => {
      workspaceState.values.set(key, value);
      await persistedFirstReplacement.promise;
    });
    harness.posted.length = 0;
    configureDelimitedPrompts(firstOptions);

    const first = harness.receive({ kind: "changeImportOptions" });
    await vi.waitFor(() => expect(reconfigureFileSession).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(workspaceState.update).toHaveBeenCalledTimes(2));
    panelPromptMocks.showQuickPick.mockReset();
    panelPromptMocks.showQuickPick.mockResolvedValue(undefined);
    const second = harness.receive({ kind: "changeImportOptions" });

    persistedFirstReplacement.resolve();
    await Promise.all([first, second]);

    expect(reconfigureFileSession).toHaveBeenCalledOnce();
    expect(harness.posted).toEqual([
      { kind: "importOptionsState", busy: true },
      firstOpened,
      { kind: "cancelled", targetRequestId: "change-import-options" },
      { kind: "importOptionsState", busy: false }
    ]);
  });

  it("publishes a committed replacement before reporting a failed superseding reconfiguration", async () => {
    const source: SessionSource = {
      kind: "file",
      label: "sample.csv",
      path: "/workspace/sample.csv",
      uri: "file:///workspace/sample.csv",
      importOptions: { delimiter: ",", encoding: "utf-8", quoteChar: '"', hasHeader: true }
    };
    const attempts = [
      { delimiter: ";", encoding: "utf-8", quoteChar: '"', hasHeader: true },
      { delimiter: "|", encoding: "windows-1252", quoteChar: "'", hasHeader: false }
    ] as const;
    const initial = responseForSource(source, 2);
    const firstOpened = responseForSource({ ...source, importOptions: attempts[0] }, 7);
    const failure: OpenWranglerResponse = {
      kind: "error",
      code: "unsupported_import_options",
      message: "The second import configuration is not supported.",
      recoverable: true,
      sessionId: "session"
    };
    const reconfigureFileSession = vi
      .fn<
        (
          sessionId: string,
          revision: number,
          source: SessionSource,
          options?: BridgeRequestOptions
        ) => Promise<OpenWranglerResponse>
      >()
      .mockResolvedValueOnce(firstOpened)
      .mockResolvedValueOnce(failure);
    const workspaceState = createWorkspaceMemento();
    const harness = createPanelHarness(
      {
        request: vi.fn(async () => initial),
        reconfigureFileSession
      },
      { source, openResponse: initial, workspaceState }
    );
    await harness.open();
    const persistedFirstReplacement = deferred<void>();
    workspaceState.update.mockImplementationOnce(async (key: string, value: unknown): Promise<void> => {
      workspaceState.values.set(key, value);
      await persistedFirstReplacement.promise;
    });
    harness.posted.length = 0;
    configureDelimitedPromptAttempts(attempts);

    const first = harness.receive({ kind: "changeImportOptions" });
    await vi.waitFor(() => expect(reconfigureFileSession).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(workspaceState.update).toHaveBeenCalledTimes(2));
    const second = harness.receive({ kind: "changeImportOptions" });

    persistedFirstReplacement.resolve();
    await Promise.all([first, second]);

    expect(reconfigureFileSession).toHaveBeenCalledTimes(2);
    expect(reconfigureFileSession.mock.calls[1]?.[2]).toEqual({
      ...firstOpened.metadata.source,
      importOptions: attempts[1]
    });
    expect(harness.posted).toEqual([
      { kind: "importOptionsState", busy: true },
      firstOpened,
      failure,
      { kind: "importOptionsState", busy: false }
    ]);
  });

  it("cancels a superseded prompt before starting only the latest replacement", async () => {
    const source: SessionSource = {
      kind: "file",
      label: "sample.csv",
      path: "/workspace/sample.csv",
      uri: "file:///workspace/sample.csv",
      importOptions: { delimiter: ",", encoding: "utf-8", quoteChar: '"', hasHeader: true }
    };
    const initial = responseForSource(source);
    let delimiterPromptCount = 0;
    let firstPromptWasCancelled = false;
    panelPromptMocks.showQuickPick.mockImplementation(async (items, options, token) => {
      const choices = items as PromptPick[];
      if (options?.title === "Delimiter") {
        delimiterPromptCount += 1;
        if (delimiterPromptCount === 1) {
          return new Promise((resolve) => {
            const subscription = token?.onCancellationRequested(() => {
              firstPromptWasCancelled = true;
              subscription?.dispose();
              resolve(undefined);
            });
          });
        }
        return choices.find(({ value }) => value === ";");
      }
      if (options?.title === "Text encoding") return choices.find(({ value }) => value === "utf-8");
      if (options?.title === "Header row") return choices.find(({ value }) => value === true);
      return choices[0];
    });
    panelPromptMocks.showInputBox.mockImplementation(async (options) =>
      options?.title === "Quote character" ? '"' : options?.value
    );
    const reconfigureFileSession = vi.fn(
      async (_sessionId: string, _revision: number, nextSource: SessionSource): Promise<OpenWranglerResponse> =>
        responseForSource(nextSource, 1)
    );
    const harness = createPanelHarness(
      { request: vi.fn(async () => initial), reconfigureFileSession },
      { source, openResponse: initial }
    );
    await harness.open();
    harness.posted.length = 0;

    const first = harness.receive({ kind: "changeImportOptions" });
    await vi.waitFor(() => expect(delimiterPromptCount).toBe(1));
    const second = harness.receive({ kind: "changeImportOptions" });
    await Promise.all([first, second]);

    expect(firstPromptWasCancelled).toBe(true);
    expect(delimiterPromptCount).toBe(2);
    expect(reconfigureFileSession).toHaveBeenCalledOnce();
    expect(reconfigureFileSession.mock.calls[0]?.[2].importOptions).toEqual({
      delimiter: ";",
      encoding: "utf-8",
      quoteChar: '"',
      hasHeader: true
    });
    expect(harness.posted).toEqual([
      { kind: "importOptionsState", busy: true },
      responseForSource(
        {
          ...source,
          importOptions: { delimiter: ";", encoding: "utf-8", quoteChar: '"', hasHeader: true }
        },
        1
      ),
      { kind: "importOptionsState", busy: false }
    ]);
  });

  it("shows import prompts before draining an accepted foreground request, then reconfigures from its result", async () => {
    const source: SessionSource = {
      kind: "file",
      label: "sample.csv",
      path: "/workspace/sample.csv",
      uri: "file:///workspace/sample.csv",
      importOptions: { delimiter: ",", encoding: "utf-8", quoteChar: '"', hasHeader: true }
    };
    const initial = responseForSource(source);
    const mutationResponse = deferred<OpenWranglerResponse>();
    const request = vi.fn(async (candidate: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (candidate.kind === "applyDraft") return mutationResponse.promise;
      return initial;
    });
    const reconfigureFileSession = vi.fn(
      async (_sessionId: string, _revision: number, nextSource: SessionSource): Promise<OpenWranglerResponse> =>
        responseForSource(nextSource, 1)
    );
    configureDelimitedPrompts({
      delimiter: ";",
      encoding: "utf-8",
      quoteChar: '"',
      hasHeader: true
    });
    const harness = createPanelHarness({ request, reconfigureFileSession }, { source, openResponse: initial });
    await harness.open();
    harness.posted.length = 0;

    const mutation = harness.receive({
      kind: "runtimeRequest",
      request: { kind: "applyDraft", offset: 0, limit: 200, columnOffset: 0, columnLimit: 16 }
    });
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    const changing = harness.receive({ kind: "changeImportOptions" });
    await vi.waitFor(() => expect(harness.posted).toContainEqual({ kind: "importOptionsState", busy: true }));
    expect(panelPromptMocks.showQuickPick).toHaveBeenCalled();
    expect(reconfigureFileSession).not.toHaveBeenCalled();

    mutationResponse.resolve({
      kind: "error",
      code: "no_draft",
      message: "There is no draft.",
      recoverable: true,
      sessionId: metadata.sessionId
    });
    await mutation;
    await vi.waitFor(() => expect(panelPromptMocks.showQuickPick).toHaveBeenCalled());
    await changing;

    expect(reconfigureFileSession).toHaveBeenCalledOnce();
    expect(harness.posted).toEqual([
      { kind: "importOptionsState", busy: true },
      {
        kind: "error",
        code: "no_draft",
        message: "There is no draft.",
        recoverable: true,
        sessionId: metadata.sessionId
      },
      responseForSource(
        {
          ...source,
          importOptions: { delimiter: ";", encoding: "utf-8", quoteChar: '"', hasHeader: true }
        },
        1
      ),
      { kind: "importOptionsState", busy: false }
    ]);
  });

  it("supersedes an in-flight initial parse before publishing a configured retry", async () => {
    const source: SessionSource = {
      kind: "file",
      label: "sample.csv",
      path: "/workspace/sample.csv",
      uri: "file:///workspace/sample.csv",
      importOptions: { delimiter: ",", encoding: "utf-8", quoteChar: '"', hasHeader: true }
    };
    const initialOpen = deferred<OpenWranglerResponse>();
    const closeRequests: OpenWranglerRequest[] = [];
    let opens = 0;
    const request = vi.fn(
      async (candidate: OpenWranglerRequest, _options?: BridgeRequestOptions): Promise<OpenWranglerResponse> => {
        if (candidate.kind === "openSession") {
          opens += 1;
          return opens === 1 ? initialOpen.promise : responseForSource(candidate.source, 0);
        }
        if (candidate.kind === "closeSession") {
          closeRequests.push(candidate);
          return { kind: "sessionClosed", sessionId: candidate.sessionId };
        }
        throw new Error(`Unexpected request ${candidate.kind}`);
      }
    );
    const harness = createPanelHarness({ request }, { source, delegateOpen: true });
    configureDelimitedPrompts({
      delimiter: ";",
      encoding: "utf-8",
      quoteChar: '"',
      hasHeader: true
    });
    const opening = harness.open();
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());

    const changing = harness.receive({ kind: "changeImportOptions" });
    initialOpen.resolve(responseForSource(source, 0));
    await Promise.all([opening, changing]);

    expect(closeRequests).toEqual([
      {
        kind: "closeSession",
        sessionId: "session",
        revision: 0
      }
    ]);
    const configured = responseForSource(
      {
        ...source,
        importOptions: { delimiter: ";", encoding: "utf-8", quoteChar: '"', hasHeader: true }
      },
      0
    );
    expect(
      harness.posted.filter(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "kind" in message &&
          (message.kind === "importOptionsState" || message.kind === "sessionOpened")
      )
    ).toEqual([{ kind: "importOptionsState", busy: true }, configured, { kind: "importOptionsState", busy: false }]);
  });

  it("closes once and publishes nothing late when disposed during the import prompt", async () => {
    const source: SessionSource = {
      kind: "file",
      label: "sample.csv",
      path: "/workspace/sample.csv",
      uri: "file:///workspace/sample.csv",
      importOptions: { delimiter: ",", encoding: "utf-8", quoteChar: '"', hasHeader: true }
    };
    const initial = responseForSource(source);
    const delayedDelimiter = deferred<unknown>();
    let delimiterChoices: readonly unknown[] = [];
    panelPromptMocks.showQuickPick.mockImplementation(async (items, options) => {
      if (options?.title === "Delimiter") {
        delimiterChoices = items;
        return delayedDelimiter.promise;
      }
      return items[0];
    });
    panelPromptMocks.showInputBox.mockImplementation(async (options) => options?.value);
    const request = vi.fn(async (candidate: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (candidate.kind === "openSession") return initial;
      if (candidate.kind === "closeSession") return { kind: "sessionClosed", sessionId: candidate.sessionId };
      throw new Error(`Unexpected request ${candidate.kind}`);
    });
    const harness = createPanelHarness({ request }, { source, delegateOpen: true });
    await harness.open();
    harness.posted.length = 0;

    const changing = harness.receive({ kind: "changeImportOptions" });
    await vi.waitFor(() => expect(panelPromptMocks.showQuickPick).toHaveBeenCalledOnce());
    harness.dispose();
    const postedAtDisposal = [...harness.posted];
    delayedDelimiter.resolve(delimiterChoices[0]);
    await changing;

    expect(request.mock.calls.filter(([candidate]) => candidate.kind === "closeSession")).toHaveLength(1);
    expect(harness.posted).toEqual(postedAtDisposal);
  });

  it("cancels the dispatched replacement, closes once, and suppresses its late result after disposal", async () => {
    const source: SessionSource = {
      kind: "file",
      label: "sample.csv",
      path: "/workspace/sample.csv",
      uri: "file:///workspace/sample.csv",
      importOptions: { delimiter: ",", encoding: "utf-8", quoteChar: '"', hasHeader: true }
    };
    const initial = responseForSource(source);
    configureDelimitedPrompts({
      delimiter: ";",
      encoding: "utf-8",
      quoteChar: '"',
      hasHeader: true
    });
    const replacement = deferred<OpenWranglerResponse>();
    let replacementOptions: BridgeRequestOptions | undefined;
    const reconfigureFileSession = vi.fn(
      async (
        _sessionId: string,
        _revision: number,
        _nextSource: SessionSource,
        options?: BridgeRequestOptions
      ): Promise<OpenWranglerResponse> => {
        replacementOptions = options;
        return replacement.promise;
      }
    );
    const request = vi.fn(async (candidate: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (candidate.kind === "openSession") return initial;
      if (candidate.kind === "closeSession") return { kind: "sessionClosed", sessionId: candidate.sessionId };
      throw new Error(`Unexpected request ${candidate.kind}`);
    });
    const harness = createPanelHarness({ request, reconfigureFileSession }, { source, delegateOpen: true });
    await harness.open();
    harness.posted.length = 0;

    const changing = harness.receive({ kind: "changeImportOptions" });
    await vi.waitFor(() => expect(reconfigureFileSession).toHaveBeenCalledOnce());
    harness.dispose();
    expect(replacementOptions?.cancellation?.isCancellationRequested).toBe(true);
    const postedAtDisposal = [...harness.posted];
    replacement.resolve(
      responseForSource(
        {
          ...source,
          importOptions: { delimiter: ";", encoding: "utf-8", quoteChar: '"', hasHeader: true }
        },
        9
      )
    );
    await changing;

    expect(request.mock.calls.filter(([candidate]) => candidate.kind === "closeSession")).toHaveLength(1);
    expect(harness.posted).toEqual(postedAtDisposal);
  });

  it("clears the active UI selection synchronously while runtime cleanup remains asynchronous", async () => {
    let resolveClose: ((response: OpenWranglerResponse) => void) | undefined;
    const bridge: OpenWranglerBridge = {
      request: vi.fn((request: OpenWranglerRequest) => {
        if (request.kind === "openSession") return Promise.resolve(openedResponse);
        if (request.kind === "closeSession") {
          return new Promise<OpenWranglerResponse>((resolve) => {
            resolveClose = resolve;
          });
        }
        throw new Error(`Unexpected request ${request.kind}`);
      }),
      setActiveSession: vi.fn()
    };
    const harness = createPanelHarness(bridge, { delegateOpen: true });
    await harness.open();

    expect(bridge.request).toHaveBeenNthCalledWith(
      1,
      {
        kind: "openSession",
        source: metadata.source,
        backend: "polars",
        pageSize: 200,
        columnOffset: 0,
        columnLimit: 16,
        mode: "editing"
      },
      {
        cancellation: expect.objectContaining({
          isCancellationRequested: false,
          onCancellationRequested: expect.any(Function)
        }),
        backendPreference: "polars"
      }
    );

    harness.dispose();

    expect(bridge.setActiveSession).toHaveBeenCalledWith(undefined);
    expect(bridge.request).toHaveBeenCalledWith(
      {
        kind: "closeSession",
        sessionId: "session",
        revision: 0
      },
      {
        priority: "interactive",
        timeoutMs: 2_000,
        restartRuntimeOnTimeout: false,
        startRuntimeIfNeeded: false
      }
    );
    harness.dispose();
    expect(vi.mocked(bridge.request).mock.calls.filter(([request]) => request.kind === "closeSession")).toHaveLength(1);
    resolveClose?.({ kind: "sessionClosed", sessionId: "session" });
  });

  it("disposes the active panel through the same lifecycle used by editor acceptance", async () => {
    const request = vi.fn(async (candidate: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (candidate.kind === "openSession") return openedResponse;
      if (candidate.kind === "closeSession") return { kind: "sessionClosed", sessionId: candidate.sessionId };
      throw new Error(`Unexpected request ${candidate.kind}`);
    });
    const harness = createPanelHarness({ request }, { delegateOpen: true });
    await harness.open();

    await expect(OpenWranglerPanel.disposePanelForSession("other-session")).resolves.toBeUndefined();
    await expect(OpenWranglerPanel.disposePanelForSession("session")).resolves.toEqual({
      kind: "sessionClosed",
      sessionId: "session"
    });
    await expect(OpenWranglerPanel.disposePanelForSession("session")).resolves.toBeUndefined();
    expect(request.mock.calls.filter(([candidate]) => candidate.kind === "closeSession")).toHaveLength(1);
  });

  it("closes exactly once when disposal wins the open-session race", async () => {
    let resolveOpen: ((response: OpenWranglerResponse) => void) | undefined;
    const request = vi.fn((request: OpenWranglerRequest) => {
      if (request.kind === "openSession") {
        return new Promise<OpenWranglerResponse>((resolve) => {
          resolveOpen = resolve;
        });
      }
      if (request.kind === "closeSession") {
        return Promise.resolve<OpenWranglerResponse>({ kind: "sessionClosed", sessionId: request.sessionId });
      }
      throw new Error(`Unexpected request ${request.kind}`);
    });
    const harness = createPanelHarness({ request }, { delegateOpen: true });

    const opening = harness.open();
    harness.dispose();
    resolveOpen?.(openedResponse);
    await opening;
    await harness.open();

    expect(request.mock.calls.filter(([candidate]) => candidate.kind === "openSession")).toHaveLength(1);
    expect(request.mock.calls.filter(([candidate]) => candidate.kind === "closeSession")).toEqual([
      [
        {
          kind: "closeSession",
          sessionId: "session",
          revision: 0
        },
        {
          priority: "interactive",
          timeoutMs: 2_000,
          restartRuntimeOnTimeout: false,
          startRuntimeIfNeeded: false
        }
      ]
    ]);
    expect(harness.posted).not.toContainEqual(openedResponse);
  });

  it("opens live notebook variables without waiting for renderer readiness", async () => {
    const source: SessionSource = {
      kind: "notebookVariable",
      label: "duplicate_frame",
      variableName: "duplicate_frame",
      uri: "file:///workspace/example.ipynb"
    };
    const request = vi.fn(async (candidate: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (candidate.kind === "openSession") {
        return { ...openedResponse, metadata: { ...metadata, source, backend: "pandas" } };
      }
      if (candidate.kind === "closeSession") return { kind: "sessionClosed", sessionId: candidate.sessionId };
      throw new Error(`Unexpected request ${candidate.kind}`);
    });
    const harness = createPanelHarness({ request }, { createViaFactory: true, delegateOpen: true, source });

    await vi.waitFor(() =>
      expect(request.mock.calls.filter(([candidate]) => candidate.kind === "openSession")).toHaveLength(1)
    );
    await harness.receive({ kind: "ready" });

    expect(request.mock.calls.filter(([candidate]) => candidate.kind === "openSession")).toHaveLength(1);
  });

  it("does not retry a failed live notebook open when renderer readiness arrives later", async () => {
    const source: SessionSource = {
      kind: "notebookVariable",
      label: "denied_frame",
      variableName: "denied_frame",
      uri: "file:///workspace/example.ipynb"
    };
    const request = vi.fn(async (candidate: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (candidate.kind === "openSession") {
        return {
          kind: "error",
          code: "kernel_access_denied",
          message: "Kernel access was denied.",
          recoverable: true
        };
      }
      throw new Error(`Unexpected request ${candidate.kind}`);
    });
    const harness = createPanelHarness({ request }, { createViaFactory: true, delegateOpen: true, source });

    await vi.waitFor(() =>
      expect(request.mock.calls.filter(([candidate]) => candidate.kind === "openSession")).toHaveLength(1)
    );
    await harness.receive({ kind: "ready" });

    expect(request.mock.calls.filter(([candidate]) => candidate.kind === "openSession")).toHaveLength(1);
    expect(harness.posted).toContainEqual({
      kind: "error",
      code: "kernel_access_denied",
      message: "Kernel access was denied.",
      recoverable: true
    });
    expect(latestRendererSynchronization(harness.posted)).toMatchObject({
      sessionId: null,
      revision: null
    });
  });

  it("keeps saved notebook snapshots lazy until their renderer is ready", async () => {
    const source: SessionSource = { kind: "notebookOutput", label: "saved output" };
    const request = vi.fn(async (candidate: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (candidate.kind === "openSession") {
        return { ...openedResponse, metadata: { ...metadata, source } };
      }
      if (candidate.kind === "closeSession") return { kind: "sessionClosed", sessionId: candidate.sessionId };
      throw new Error(`Unexpected request ${candidate.kind}`);
    });
    const harness = createPanelHarness({ request }, { createViaFactory: true, delegateOpen: true, source });

    expect(request).not.toHaveBeenCalled();
    await harness.receive({ kind: "ready" });

    expect(request.mock.calls.filter(([candidate]) => candidate.kind === "openSession")).toHaveLength(1);
  });
});

interface DelimitedPromptResult {
  readonly delimiter: string;
  readonly encoding: string;
  readonly quoteChar: string;
  readonly hasHeader: boolean;
}

function configureDelimitedPrompts(result: DelimitedPromptResult): void {
  panelPromptMocks.showQuickPick.mockImplementation(async (items, options) => {
    const choices = items as PromptPick[];
    if (options?.title === "Delimiter") return choices.find(({ value }) => value === result.delimiter);
    if (options?.title === "Text encoding") return choices.find(({ value }) => value === result.encoding);
    if (options?.title === "Header row") return choices.find(({ value }) => value === result.hasHeader);
    return choices[0];
  });
  panelPromptMocks.showInputBox.mockImplementation(async (options) =>
    options?.title === "Quote character" ? result.quoteChar : options?.value
  );
}

function configureDelimitedPromptAttempts(attempts: readonly DelimitedPromptResult[]): void {
  let attempt = -1;
  panelPromptMocks.showQuickPick.mockImplementation(async (items, options) => {
    if (options?.title === "Delimiter") attempt += 1;
    const result = attempts[attempt];
    if (!result) throw new Error(`Missing prompt result for import-options attempt ${attempt}.`);
    const choices = items as PromptPick[];
    if (options?.title === "Delimiter") return choices.find(({ value }) => value === result.delimiter);
    if (options?.title === "Text encoding") return choices.find(({ value }) => value === result.encoding);
    if (options?.title === "Header row") return choices.find(({ value }) => value === result.hasHeader);
    return choices[0];
  });
  panelPromptMocks.showInputBox.mockImplementation(async (options) => {
    const result = attempts[attempt];
    if (!result) throw new Error(`Missing prompt result for import-options attempt ${attempt}.`);
    return options?.title === "Quote character" ? result.quoteChar : options?.value;
  });
}

function promptPicksAt(call: number): PromptPick[] {
  return panelPromptMocks.showQuickPick.mock.calls[call]?.[0] as PromptPick[];
}

function promptInputAt(call: number): PromptOptions {
  return panelPromptMocks.showInputBox.mock.calls[call]?.[0] as PromptOptions;
}

function responseForSource(source: SessionSource, revision = 0): SessionOpenedResponse {
  return {
    ...openedResponse,
    metadata: {
      ...metadata,
      sessionId: "session",
      revision,
      source
    }
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value: T) {
      if (!resolvePromise) throw new Error("Deferred promise was not initialized.");
      resolvePromise(value);
    }
  };
}

function pageMessage(viewRequestId: string, viewContextId: string) {
  return {
    kind: "runtimeRequest",
    viewContextId,
    request: {
      kind: "getPage",
      viewRequestId,
      offset: 0,
      limit: 200,
      columnOffset: 0,
      columnLimit: 16,
      filterModel: metadata.filterModel
    }
  };
}

interface RendererSynchronizationMessage {
  kind: "rendererSynchronization";
  syncId: string;
  sessionId: string | null;
  revision: number | null;
}

interface RendererImportRequest {
  kind: "requestImportOptionsChange";
  actionId: string;
}

function latestRendererSynchronization(messages: unknown[]): RendererSynchronizationMessage {
  const synchronization = [...messages].reverse().find(isRendererSynchronizationMessage);
  if (!synchronization) throw new Error("The panel did not publish a renderer synchronization marker.");
  return synchronization;
}

function isRendererSynchronizationMessage(message: unknown): message is RendererSynchronizationMessage {
  if (!message || typeof message !== "object") return false;
  const candidate = message as Partial<RendererSynchronizationMessage>;
  return (
    candidate.kind === "rendererSynchronization" &&
    typeof candidate.syncId === "string" &&
    (typeof candidate.sessionId === "string" || candidate.sessionId === null) &&
    (typeof candidate.revision === "number" || candidate.revision === null)
  );
}

function isRendererImportRequest(message: unknown): message is RendererImportRequest {
  if (!message || typeof message !== "object") return false;
  const candidate = message as Partial<RendererImportRequest>;
  return candidate.kind === "requestImportOptionsChange" && typeof candidate.actionId === "string";
}

function isSessionOpenedResponse(message: unknown): message is SessionOpenedResponse {
  return Boolean(message && typeof message === "object" && (message as { kind?: unknown }).kind === "sessionOpened");
}

async function acknowledgeLatestRendererSynchronization(harness: {
  posted: unknown[];
  receive(message: unknown): Promise<void>;
}): Promise<RendererSynchronizationMessage> {
  const synchronization = latestRendererSynchronization(harness.posted);
  await harness.receive({
    kind: "rendererSynchronized",
    syncId: synchronization.syncId,
    sessionId: synchronization.sessionId,
    revision: synchronization.revision
  });
  return synchronization;
}

function createPanelHarness(
  bridge: OpenWranglerBridge,
  options?: {
    createViaFactory?: boolean;
    delegateOpen?: boolean;
    openResponse?: SessionOpenedResponse;
    source?: SessionSource;
    active?: boolean;
    workspaceState?: Pick<vscode.Memento, "get" | "update">;
    backend?: DataBackend;
    backendPreference?: DataBackend | "auto";
    postMessage?: (message: unknown) => Promise<boolean>;
  }
): {
  posted: unknown[];
  readonly html: string;
  open(): Promise<void>;
  receive(message: unknown): Promise<void>;
  send(message: unknown): Promise<void>;
  activate(): void;
  deactivate(): void;
  dispose(): void;
} {
  let listener: ((message: unknown) => Promise<void>) | undefined;
  let disposeListener: (() => void) | undefined;
  let viewStateListener: ((event: { webviewPanel: { active: boolean } }) => void) | undefined;
  const posted: unknown[] = [];
  const webview = {
    options: {},
    html: "",
    cspSource: "mock-webview",
    asWebviewUri: (uri: vscode.Uri) => uri,
    onDidReceiveMessage: (next: (message: unknown) => Promise<void>) => {
      listener = next;
      return { dispose: () => undefined };
    },
    postMessage: async (message: unknown) => {
      posted.push(message);
      return options?.postMessage ? options.postMessage(message) : true;
    }
  };
  const panel = {
    webview,
    active: options?.active ?? true,
    viewColumn: 1,
    reveal: () => undefined,
    dispose: () => disposeListener?.(),
    onDidDispose: (listener: () => void) => {
      disposeListener = listener;
      return { dispose: () => undefined };
    },
    onDidChangeViewState: (next: (event: { webviewPanel: { active: boolean } }) => void) => {
      viewStateListener = next;
      return { dispose: () => undefined };
    }
  };
  const context = { extensionPath: "/extension", workspaceState: options?.workspaceState };
  const panelBridge: OpenWranglerBridge = options?.delegateOpen
    ? bridge
    : {
        ...bridge,
        request: (request, requestOptions) => {
          if (request.kind === "openSession") return Promise.resolve(options?.openResponse ?? openedResponse);
          if (request.kind === "closeSession") {
            return Promise.resolve({ kind: "sessionClosed", sessionId: request.sessionId });
          }
          return bridge.request(request, requestOptions);
        }
      };
  const source = options?.source ?? metadata.source;
  const backend = options?.backend ?? metadata.backend;
  const backendPreference = options?.backendPreference ?? backend;
  let instance: OpenWranglerPanel;
  if (options?.createViaFactory) {
    const descriptor = Object.getOwnPropertyDescriptor(window, "createWebviewPanel");
    Object.defineProperty(window, "createWebviewPanel", {
      configurable: true,
      value: vi.fn(() => panel)
    });
    try {
      instance = OpenWranglerPanel.create(
        context as unknown as vscode.ExtensionContext,
        panelBridge,
        source,
        backend,
        backendPreference
      );
    } finally {
      if (descriptor) Object.defineProperty(window, "createWebviewPanel", descriptor);
      else delete (window as unknown as { createWebviewPanel?: unknown }).createWebviewPanel;
    }
  } else {
    instance = new OpenWranglerPanel(
      panel as unknown as vscode.WebviewPanel,
      context as unknown as vscode.ExtensionContext,
      panelBridge,
      source,
      backend,
      false,
      backendPreference
    );
  }
  const harness = {
    posted,
    get html() {
      return webview.html;
    },
    open: () => instance.open(),
    async receive(message: unknown) {
      if (!listener) throw new Error("Panel message listener was not registered.");
      await listener(message);
    },
    async send(message: unknown) {
      await instance.open();
      await harness.receive(message);
    },
    activate() {
      panel.active = true;
      viewStateListener?.({ webviewPanel: panel });
    },
    deactivate() {
      panel.active = false;
      viewStateListener?.({ webviewPanel: panel });
    },
    dispose() {
      disposeListener?.();
    }
  };
  liveHarnesses.push(harness);
  return harness;
}

function createWorkspaceMemento(): Pick<vscode.Memento, "get" | "update"> & {
  update: ReturnType<typeof vi.fn>;
  values: Map<string, unknown>;
} {
  const values = new Map<string, unknown>();
  return {
    values,
    get: <T>(key: string, fallback?: T): T | undefined =>
      (values.has(key) ? values.get(key) : fallback) as T | undefined,
    update: vi.fn(async (key: string, value: unknown): Promise<void> => {
      values.set(key, value);
    })
  };
}
