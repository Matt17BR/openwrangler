import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import { commands, Uri, window, workspace } from "vscode";
import type { BridgeRequestOptions, OpenWranglerBridge } from "../extension/dataBridge";
import { CONFIRMED_FILE_CONFIGURATIONS_STORAGE_KEY } from "../extension/files/confirmedFileConfigurations";
import { DependencyGuardCommandError } from "../extension/dependencyGuardProtocol";
import { OpenWranglerPanel, restoreEditorGroupAfterQuickPick } from "../extension/webviewPanel";
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
  columnId: "c:0",
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
  showInputBox: vi.fn<(options?: PromptOptions, token?: vscode.CancellationToken) => Promise<string | undefined>>(),
  showWarningMessage:
    vi.fn<(message: string, options?: vscode.MessageOptions, ...items: string[]) => Promise<string | undefined>>()
};

describe("OpenWranglerPanel retained view state", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    panelPromptMocks.showQuickPick.mockReset();
    panelPromptMocks.showQuickPick.mockResolvedValue(undefined);
    panelPromptMocks.showInputBox.mockReset();
    panelPromptMocks.showInputBox.mockResolvedValue(undefined);
    panelPromptMocks.showWarningMessage.mockReset();
    panelPromptMocks.showWarningMessage.mockResolvedValue(undefined);
    Object.defineProperties(window, {
      showQuickPick: {
        configurable: true,
        value: panelPromptMocks.showQuickPick
      },
      showInputBox: {
        configurable: true,
        value: panelPromptMocks.showInputBox
      },
      showWarningMessage: {
        configurable: true,
        value: panelPromptMocks.showWarningMessage
      }
    });
  });

  it("returns focus to the editor group after a Quick Pick", async () => {
    const executeCommand = vi.spyOn(commands, "executeCommand").mockResolvedValue(undefined);

    await restoreEditorGroupAfterQuickPick();

    expect(executeCommand).toHaveBeenCalledOnce();
    expect(executeCommand).toHaveBeenCalledWith("workbench.action.focusActiveEditorGroup");
  });

  it("keeps the native Quick Pick fallback when a fork lacks the focus command", async () => {
    const executeCommand = vi.spyOn(commands, "executeCommand").mockRejectedValue(new Error("command unavailable"));

    await expect(restoreEditorGroupAfterQuickPick()).resolves.toBeUndefined();

    expect(executeCommand).toHaveBeenCalledWith("workbench.action.focusActiveEditorGroup");
  });

  it.each([
    ["react", "Open Wrangler webview rendering stopped. A renderer reload was offered."],
    ["message", "Open Wrangler webview message handling stopped. A renderer reload was offered."]
  ] as const)("records a fixed %s failure without changing the session or renderer", async (phase, expected) => {
    const request = vi.fn(async () => openedResponse);
    const reportDiagnostic = vi.fn();
    const harness = createPanelHarness({ request, reportDiagnostic });
    await harness.open();
    harness.posted.length = 0;
    const originalHtml = harness.html;
    const originalAssignments = harness.htmlAssignmentCount;
    const originalRequests = request.mock.calls.length;

    await harness.receive({ kind: "webviewFailure", phase });

    expect(reportDiagnostic).toHaveBeenCalledOnce();
    expect(reportDiagnostic).toHaveBeenCalledWith(expected);
    expect(request).toHaveBeenCalledTimes(originalRequests);
    expect(harness.html).toBe(originalHtml);
    expect(harness.htmlAssignmentCount).toBe(originalAssignments);
    expect(harness.posted).toEqual([]);
  });
  afterEach(() => {
    while (liveHarnesses.length) liveHarnesses.pop()?.dispose();
    delete (window as unknown as { showQuickPick?: unknown }).showQuickPick;
    delete (window as unknown as { showInputBox?: unknown }).showInputBox;
    delete (window as unknown as { showWarningMessage?: unknown }).showWarningMessage;
  });

  it("keeps native actions on the visible session after sidebar focus and clears them when hidden", async () => {
    const setActiveSession = vi.fn();
    const harness = createPanelHarness({ request: vi.fn(async () => openedResponse), setActiveSession });
    await harness.open();
    harness.posted.length = 0;
    setActiveSession.mockClear();
    harness.deactivate();

    expect(setActiveSession).not.toHaveBeenCalledWith(undefined);
    expect(OpenWranglerPanel.sendEditorAction({ action: "openFilters", column: "city" })).toBe(true);
    expect(harness.posted).toEqual([{ kind: "editorAction", action: "openFilters", column: "city" }]);
    harness.posted.length = 0;

    const action = {
      action: "changeViewSort" as const,
      column: "city",
      sortAction: "remove" as const,
      expectedSessionId: "session",
      expectedSortModelSignature: "[]",
      expectedSortIndex: 0
    };
    expect(OpenWranglerPanel.sendEditorAction(action)).toBe(true);
    expect(harness.posted).toEqual([{ kind: "editorAction", ...action }]);

    harness.posted.length = 0;
    expect(OpenWranglerPanel.sendEditorAction({ ...action, expectedSessionId: "stale-session" })).toBe(false);
    expect(harness.posted).toEqual([]);

    harness.hide();
    expect(setActiveSession).toHaveBeenLastCalledWith(undefined);
    expect(OpenWranglerPanel.sendEditorAction({ action: "openFilters", column: "city" })).toBe(false);
  });

  it("routes applied-step selections to the exact visible session without stealing sidebar focus", async () => {
    const firstResponse: SessionOpenedResponse = {
      ...openedResponse,
      metadata: { ...openedResponse.metadata, sessionId: "session-one" }
    };
    const secondResponse: SessionOpenedResponse = {
      ...openedResponse,
      metadata: { ...openedResponse.metadata, sessionId: "session-two" }
    };
    const first = createPanelHarness({ request: vi.fn(async () => firstResponse) }, { openResponse: firstResponse });
    const second = createPanelHarness({ request: vi.fn(async () => secondResponse) }, { openResponse: secondResponse });
    await first.open();
    await second.open();
    await first.receive({ kind: "ready" });
    await acknowledgeLatestRendererSynchronization(first);
    await second.receive({ kind: "ready" });
    await acknowledgeLatestRendererSynchronization(second);
    first.posted.length = 0;
    second.posted.length = 0;

    expect(
      await OpenWranglerPanel.sendEditorActionForSession({
        action: "selectStep",
        expectedSessionId: "session-one",
        expectedRevision: 0,
        stepId: "clone-score"
      })
    ).toBe(true);
    expect(first.posted).toEqual([
      {
        kind: "editorAction",
        action: "selectStep",
        expectedSessionId: "session-one",
        expectedRevision: 0,
        stepId: "clone-score"
      }
    ]);
    expect(second.posted).toEqual([]);
    expect(first.reveal).not.toHaveBeenCalled();
    expect(second.reveal).not.toHaveBeenCalled();

    expect(
      await OpenWranglerPanel.sendEditorActionForSession({
        action: "selectStep",
        expectedSessionId: "retired-session",
        expectedRevision: 0,
        stepId: "clone-score"
      })
    ).toBe(false);
  });

  it("reveals an exact-session operation only after the renderer is hydrated", async () => {
    const harness = createPanelHarness({ request: vi.fn(async () => openedResponse) });
    await harness.open();
    await harness.receive({ kind: "ready" });
    await acknowledgeLatestRendererSynchronization(harness);
    harness.posted.length = 0;
    harness.reveal.mockClear();

    await expect(
      OpenWranglerPanel.sendEditorActionForSession({
        action: "openOperation",
        expectedSessionId: openedResponse.metadata.sessionId,
        expectedRevision: openedResponse.metadata.revision
      })
    ).resolves.toBe(true);

    expect(harness.reveal).toHaveBeenCalledWith(expect.anything(), false);
    expect(harness.posted).toEqual([
      {
        kind: "editorAction",
        action: "openOperation",
        expectedSessionId: openedResponse.metadata.sessionId,
        expectedRevision: openedResponse.metadata.revision
      }
    ]);
  });

  it("reports a failed exact-session editor-action delivery", async () => {
    const harness = createPanelHarness(
      { request: vi.fn(async () => openedResponse) },
      {
        postMessage: async (message) =>
          !(message && typeof message === "object" && (message as { kind?: unknown }).kind === "editorAction")
      }
    );
    await harness.open();
    await harness.receive({ kind: "ready" });
    await acknowledgeLatestRendererSynchronization(harness);

    await expect(
      OpenWranglerPanel.sendEditorActionForSession({
        action: "selectStep",
        expectedSessionId: openedResponse.metadata.sessionId,
        expectedRevision: openedResponse.metadata.revision,
        stepId: "clone-score"
      })
    ).resolves.toBe(false);
    expect(OpenWranglerPanel.panelHydratedForSession(openedResponse.metadata.sessionId)).toBe(false);
    expect(harness.htmlAssignmentCount).toBe(2);
  });

  it("loads the production webview as an ES module under a restrictive nonce CSP", async () => {
    const harness = createPanelHarness({ request: vi.fn(async () => openedResponse) });
    await harness.open();
    const script = harness.html.match(/<script type="module" nonce="([0-9a-f]{32})" src="([^"]+)"><\/script>/u);
    const style = harness.html.match(/<link rel="stylesheet" href="([^"]+)">/u);
    const csp = harness.html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/u)?.[1];
    expect(script).not.toBeNull();
    const nonce = script?.[1];
    expect(csp).toBe(
      `default-src 'none'; img-src mock-webview; style-src mock-webview 'unsafe-inline'; font-src mock-webview; script-src mock-webview 'nonce-${nonce}';`
    );
    expect(csp).not.toContain("https:");
    expect(script?.[2].replaceAll("\\", "/")).toBe("file:///extension/media/webview.js");
    expect(style?.[1].replaceAll("\\", "/")).toBe("file:///extension/media/webview.css");
    expect(harness.html).toContain('data-fetch-column-block-size="16"');
  });

  it("falls back before malformed bootstrap settings can enter webview markup", () => {
    const dangerous =
      '"><script id="configuration-injection">globalThis.compromised = true</script>&\u2028\u2029\ud800';
    vi.spyOn(workspace, "getConfiguration").mockReturnValue({
      get: (key: string, fallback?: unknown): unknown =>
        ["fetchBlockSize", "fetchColumnBlockSize", "defaultColumnWidth", "insightsOnOpen", "filterMode"].includes(key)
          ? dangerous
          : fallback
    } as vscode.WorkspaceConfiguration);

    const harness = createPanelHarness({ request: vi.fn(async () => openedResponse) });

    expect(harness.html).toContain(
      '<body data-fetch-block-size="200" data-fetch-column-block-size="16" data-default-column-width="190" data-insights-on-open="true" data-filter-mode="basic"'
    );
    expect(harness.html).not.toContain(dangerous);
    expect(harness.html).not.toContain("configuration-injection");
  });

  it("serializes valid bootstrap settings without changing the nonce CSP", () => {
    vi.spyOn(workspace, "getConfiguration").mockReturnValue({
      get: (key: string, fallback?: unknown): unknown =>
        key === "fetchBlockSize"
          ? 25
          : key === "fetchColumnBlockSize"
            ? 256
            : key === "defaultColumnWidth"
              ? 320.5
              : key === "insightsOnOpen"
                ? false
                : key === "filterMode"
                  ? "advanced"
                  : fallback
    } as vscode.WorkspaceConfiguration);

    const harness = createPanelHarness({ request: vi.fn(async () => openedResponse) });
    const nonce = harness.html.match(/<script type="module" nonce="([0-9a-f]{32})"/u)?.[1];
    expect(harness.html).toContain(
      '<body data-fetch-block-size="25" data-fetch-column-block-size="256" data-default-column-width="320.5" data-insights-on-open="false" data-filter-mode="advanced" data-can-change-import-options="true">'
    );
    expect(harness.html).toContain(
      `default-src 'none'; img-src mock-webview; style-src mock-webview 'unsafe-inline'; font-src mock-webview; script-src mock-webview 'nonce-${nonce}';`
    );
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 10_000])(
    "falls back before numeric bootstrap value %s reaches HTML",
    (invalid) => {
      vi.spyOn(workspace, "getConfiguration").mockReturnValue({
        get: (key: string, fallback?: unknown): unknown =>
          ["fetchBlockSize", "fetchColumnBlockSize", "defaultColumnWidth", "insightsOnOpen", "filterMode"].includes(key)
            ? invalid
            : fallback
      } as vscode.WorkspaceConfiguration);

      const harness = createPanelHarness({ request: vi.fn(async () => openedResponse) });
      expect(harness.html).toContain(
        '<body data-fetch-block-size="200" data-fetch-column-block-size="16" data-default-column-width="190" data-insights-on-open="true" data-filter-mode="basic"'
      );
      expect(harness.html).not.toContain(`="${String(invalid)}"`);
    }
  );

  it("brands every workbench tab with theme-specific Open Wrangler action icons", () => {
    const harness = createPanelHarness({ request: vi.fn(async () => openedResponse) });

    const iconPath = harness.iconPath as { light: vscode.Uri; dark: vscode.Uri };
    expect(iconPath.light.toString()).toBe("file:///extension/media/action-icon-light.svg");
    expect(iconPath.dark.toString()).toBe("file:///extension/media/action-icon-dark.svg");
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

    harness.hide();
    const handled = await OpenWranglerPanel.changeActiveImportOptions();

    expect(handled).toBe(false);
    expect(panelPromptMocks.showQuickPick).not.toHaveBeenCalled();
    expect(panelPromptMocks.showInputBox).not.toHaveBeenCalled();
    expect(reconfigureFileSession).not.toHaveBeenCalled();
    expect(bridge.setActiveSession).toHaveBeenLastCalledWith(undefined);
    expect(executeCommand).toHaveBeenLastCalledWith("setContext", "openWrangler.canChangeImportOptions", false);
  });

  it("switches a file session through the native engine picker and remembers the confirmed choice", async () => {
    const source: SessionSource = {
      kind: "file",
      label: "records.csv",
      path: "/workspace/records.csv",
      uri: "file:///workspace/records.csv",
      importOptions: { delimiter: ",", encoding: "utf-8", quoteChar: '"', hasHeader: true }
    };
    const opened = responseForSource(source);
    const configured: SessionOpenedResponse = {
      ...opened,
      metadata: { ...opened.metadata, revision: 1, backend: "pandas" }
    };
    const reconfigureFileSession = vi.fn(async (): Promise<OpenWranglerResponse> => configured);
    const workspaceState = {
      get: vi.fn(() => undefined),
      update: vi.fn(async () => undefined)
    };
    const harness = createPanelHarness(
      {
        request: vi.fn(async () => opened),
        reconfigureFileSession
      },
      { source, openResponse: opened, backendPreference: "auto", workspaceState }
    );
    await harness.open();
    workspaceState.update.mockClear();
    panelPromptMocks.showQuickPick.mockImplementation(async (items, options) => {
      if (options?.title !== "Dataframe engine") return undefined;
      return (items as Array<{ backend: DataBackend }>).find((item) => item.backend === "pandas");
    });

    await harness.receive({ kind: "changeBackend" });

    expect(panelPromptMocks.showQuickPick).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ label: "Polars", description: "Current", backend: "polars" }),
        expect.objectContaining({ label: "DuckDB", backend: "duckdb" }),
        expect.objectContaining({ label: "Pandas", backend: "pandas" })
      ]),
      expect.objectContaining({ title: "Dataframe engine", placeHolder: "Current engine: Polars" }),
      expect.anything()
    );
    expect(reconfigureFileSession).toHaveBeenCalledWith("session", 0, source, {
      cancellation: expect.anything(),
      backendPreference: "pandas"
    });
    expect(workspaceState.update).toHaveBeenCalledWith(
      CONFIRMED_FILE_CONFIGURATIONS_STORAGE_KEY,
      expect.objectContaining({
        entries: [expect.objectContaining({ backend: "pandas", backendPreference: "pandas" })]
      })
    );
    expect(harness.posted).toContainEqual({ kind: "importOptionsState", busy: true });
    expect(harness.posted).toContainEqual({ kind: "importOptionsState", busy: false });
  });

  it("offers only engines that support the current file format and import options", async () => {
    const source: SessionSource = {
      kind: "file",
      label: "records.xlsx",
      path: "/workspace/records.xlsx",
      uri: "file:///workspace/records.xlsx",
      importOptions: { sheetIndex: 0 }
    };
    const opened = responseForSource(source);
    const harness = createPanelHarness(
      { request: vi.fn(async () => opened), reconfigureFileSession: vi.fn() },
      { source, openResponse: opened, backendPreference: "auto" }
    );
    await harness.open();

    await harness.receive({ kind: "changeBackend" });

    const choices = panelPromptMocks.showQuickPick.mock.calls[0]?.[0] as Array<{
      label: string;
      backend: DataBackend;
    }>;
    expect(choices.map(({ backend }) => backend)).toEqual(["polars", "pandas"]);
    expect(choices.map(({ label }) => label)).toEqual(["Polars", "Pandas"]);
  });

  it("requires explicit replay confirmation before switching a session with cleaning state", async () => {
    const source: SessionSource = {
      kind: "file",
      label: "records.csv",
      path: "/workspace/records.csv",
      uri: "file:///workspace/records.csv",
      importOptions: { delimiter: ",", encoding: "utf-8", quoteChar: '"', hasHeader: true }
    };
    const appliedStep = {
      id: "lower-city",
      kind: "lowerText" as const,
      params: { column: { id: "c:0", name: "city" } }
    };
    const opened: SessionOpenedResponse = {
      ...responseForSource(source),
      metadata: { ...metadata, source, steps: [appliedStep], latestStepInputSchema: metadata.schema }
    };
    const configured: SessionOpenedResponse = {
      ...opened,
      metadata: { ...opened.metadata, revision: 1, backend: "pandas" }
    };
    const reconfigureFileSession = vi.fn(async (): Promise<OpenWranglerResponse> => configured);
    const harness = createPanelHarness(
      { request: vi.fn(async () => opened), reconfigureFileSession },
      { source, openResponse: opened, backendPreference: "auto" }
    );
    await harness.open();
    panelPromptMocks.showQuickPick.mockImplementation(async (items, options) => {
      if (options?.title !== "Dataframe engine") return undefined;
      return (items as Array<{ backend: DataBackend }>).find((item) => item.backend === "pandas");
    });

    await harness.receive({ kind: "changeBackend" });

    expect(panelPromptMocks.showWarningMessage).toHaveBeenCalledWith(
      "Switch to Pandas?",
      expect.objectContaining({
        modal: true,
        detail: expect.stringContaining("replay 1 applied step with Pandas")
      }),
      "Replay and switch"
    );
    expect(reconfigureFileSession).not.toHaveBeenCalled();

    panelPromptMocks.showWarningMessage.mockResolvedValueOnce("Replay and switch");
    await harness.receive({ kind: "changeBackend" });

    expect(reconfigureFileSession).toHaveBeenCalledOnce();
  });

  it("coalesces native import commands and keeps them pending through the renderer-prepared transaction", async () => {
    const source: SessionSource = {
      kind: "file",
      label: "records.csv",
      path: "/workspace/records.csv",
      uri: "file:///workspace/records.csv",
      importOptions: { delimiter: ",", encoding: "utf-8", quoteChar: '"', hasHeader: true }
    };
    const opened = responseForSource(source);
    const reconfiguration = deferred<OpenWranglerResponse>();
    const reconfigureFileSession = vi.fn(async (): Promise<OpenWranglerResponse> => reconfiguration.promise);
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
    const delimiterPrompt = deferred<unknown>();
    let delimiterChoices: PromptPick[] = [];
    panelPromptMocks.showQuickPick.mockImplementation(async (items, options) => {
      const choices = items as PromptPick[];
      if (options?.title === "Delimiter") {
        delimiterChoices = choices;
        return delimiterPrompt.promise;
      }
      if (options?.title === "Text encoding") return choices.find(({ value }) => value === "utf-8");
      if (options?.title === "Header row") return choices.find(({ value }) => value === true);
      return choices[0];
    });
    panelPromptMocks.showInputBox.mockImplementation(async (options) =>
      options?.title === "Quote character" ? '"' : options?.value
    );
    harness.posted.length = 0;

    const command = OpenWranglerPanel.changeActiveImportOptions();
    const concurrentCommand = OpenWranglerPanel.changeActiveImportOptions();
    expect(concurrentCommand).toBe(command);
    await vi.waitFor(() => expect(harness.posted.some((message) => isRendererImportRequest(message))).toBe(true));
    expect(harness.posted.filter(isRendererImportRequest)).toHaveLength(1);
    const rendererRequest = harness.posted.find(isRendererImportRequest);
    if (!rendererRequest) throw new Error("The panel did not publish a renderer import request.");
    const rendererResponse = harness.receive({
      kind: "changeImportOptions",
      actionId: rendererRequest.actionId
    });
    await vi.waitFor(() => expect(delimiterChoices.length).toBeGreaterThan(0));
    let commandSettled = false;
    void command.then(
      () => {
        commandSettled = true;
      },
      () => {
        commandSettled = true;
      }
    );
    await Promise.resolve();
    expect(commandSettled).toBe(false);

    delimiterPrompt.resolve(delimiterChoices.find(({ value }) => value === ","));
    await vi.waitFor(() => expect(reconfigureFileSession).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(commandSettled).toBe(false);
    reconfiguration.resolve(opened);
    await expect(Promise.all([command, concurrentCommand])).resolves.toEqual([true, true]);
    await rendererResponse;

    expect(rendererRequest).toEqual({
      kind: "requestImportOptionsChange",
      actionId: expect.stringMatching(/^[A-Za-z0-9]{32}$/u)
    });
    expect(panelPromptMocks.showQuickPick).toHaveBeenCalled();
    expect(reconfigureFileSession).toHaveBeenCalledOnce();
  });

  it("waits for the exact post-commit acknowledgement when the test API resynchronizes a panel", async () => {
    const source: SessionSource = {
      kind: "file",
      label: "records.csv",
      path: "/workspace/records.csv",
      uri: "file:///workspace/records.csv",
      importOptions: { delimiter: ",", encoding: "utf-8", quoteChar: '"', hasHeader: true }
    };
    const opened = responseForSource(source);
    const authoritativeState = {
      columnWidths: new Map([["c:0", 280]]),
      selectedColumnId: "c:0",
      viewport: { firstVisibleRow: 1, scrollLeft: 24 }
    };
    const rendererState = {
      columnWidths: [["c:0", 320]],
      selectedColumnId: "c:0",
      viewport: { firstVisibleRow: 0, scrollLeft: 0 }
    };
    const serializedAuthoritativeState = {
      ...authoritativeState,
      columnWidths: [["c:0", 280]]
    };
    const updateViewState = vi.fn(async () => undefined);
    const harness = createPanelHarness(
      {
        request: vi.fn(async () => opened),
        getViewState: vi.fn(() => authoritativeState),
        updateViewState
      },
      { source, openResponse: opened }
    );
    await harness.open();
    expect(OpenWranglerPanel.panelHydratedForSession("missing-session")).toBe(false);
    expect(OpenWranglerPanel.panelSynchronizationReceiptForSession("missing-session")).toBeUndefined();
    expect(OpenWranglerPanel.panelHydratedForSession(opened.metadata.sessionId)).toBe(false);
    expect(OpenWranglerPanel.panelSynchronizationReceiptForSession(opened.metadata.sessionId)).toBeUndefined();
    expect(OpenWranglerPanel.panelSynchronizableForSession(opened.metadata.sessionId)).toBe(false);
    await harness.receive({ kind: "ready" });
    const initialMarker = latestRendererSynchronization(harness.posted);
    expect(OpenWranglerPanel.panelSynchronizableForSession("wrong-session")).toBe(false);
    expect(OpenWranglerPanel.panelSynchronizableForSession(opened.metadata.sessionId)).toBe(true);
    expect(OpenWranglerPanel.panelHydratedForSession(opened.metadata.sessionId)).toBe(false);
    await harness.receive({
      kind: "rendererSynchronized",
      syncId: "stale-synchronization",
      sessionId: initialMarker.sessionId,
      revision: initialMarker.revision
    });
    expect(OpenWranglerPanel.panelHydratedForSession(opened.metadata.sessionId)).toBe(false);
    await harness.receive({
      kind: "rendererSynchronized",
      syncId: initialMarker.syncId,
      sessionId: initialMarker.sessionId,
      revision: initialMarker.revision
    });
    expect(OpenWranglerPanel.panelHydratedForSession(opened.metadata.sessionId)).toBe(true);
    expect(OpenWranglerPanel.panelSynchronizationReceiptForSession(opened.metadata.sessionId)).toEqual({
      syncId: initialMarker.syncId,
      sessionId: initialMarker.sessionId,
      revision: initialMarker.revision,
      layoutTransitionPending: initialMarker.layoutTransitionPending
    });

    harness.posted.length = 0;
    await harness.receive({ kind: "requestSessionSnapshot" });
    const pulledMarker = latestRendererSynchronization(harness.posted);
    expect(OpenWranglerPanel.panelHydratedForSession(opened.metadata.sessionId)).toBe(false);
    await harness.receive({
      kind: "rendererSynchronized",
      syncId: initialMarker.syncId,
      sessionId: initialMarker.sessionId,
      revision: initialMarker.revision
    });
    expect(OpenWranglerPanel.panelHydratedForSession(opened.metadata.sessionId)).toBe(false);
    await harness.receive({
      kind: "rendererSynchronized",
      syncId: pulledMarker.syncId,
      sessionId: pulledMarker.sessionId,
      revision: pulledMarker.revision
    });
    expect(OpenWranglerPanel.panelHydratedForSession(opened.metadata.sessionId)).toBe(true);
    expect(OpenWranglerPanel.panelSynchronizationReceiptForSession(opened.metadata.sessionId)).toEqual({
      syncId: pulledMarker.syncId,
      sessionId: pulledMarker.sessionId,
      revision: pulledMarker.revision,
      layoutTransitionPending: pulledMarker.layoutTransitionPending
    });
    harness.posted.length = 0;

    const synchronization = OpenWranglerPanel.synchronizePanelForSession(opened.metadata.sessionId);
    expect(OpenWranglerPanel.panelHydratedForSession(opened.metadata.sessionId)).toBe(false);
    expect(OpenWranglerPanel.panelSynchronizationReceiptForSession(opened.metadata.sessionId)).toBeUndefined();
    await vi.waitFor(() => expect(harness.posted.some(isRendererSynchronizationMessage)).toBe(true));
    const marker = latestRendererSynchronization(harness.posted);
    let settled = false;
    void synchronization.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    harness.posted.length = 0;
    await harness.receive({ kind: "updateViewState", state: rendererState });
    expect(updateViewState).not.toHaveBeenCalled();
    expect(harness.posted).toContainEqual({ kind: "viewState", state: serializedAuthoritativeState });

    await harness.receive({
      kind: "rendererSynchronized",
      syncId: marker.syncId,
      sessionId: marker.sessionId,
      revision: marker.revision
    });
    await expect(synchronization).resolves.toBe(true);
    expect(OpenWranglerPanel.panelHydratedForSession(opened.metadata.sessionId)).toBe(true);
    expect(OpenWranglerPanel.panelSynchronizationReceiptForSession(opened.metadata.sessionId)).toEqual({
      syncId: marker.syncId,
      sessionId: marker.sessionId,
      revision: marker.revision,
      layoutTransitionPending: marker.layoutTransitionPending
    });

    await harness.receive({ kind: "updateViewState", state: rendererState });
    expect(updateViewState).toHaveBeenCalledOnce();
    expect(updateViewState).toHaveBeenCalledWith(opened.metadata.sessionId, {
      ...rendererState,
      columnWidths: new Map([["c:0", 320]])
    });

    harness.dispose();
    expect(OpenWranglerPanel.panelHydratedForSession(opened.metadata.sessionId)).toBe(false);
    expect(OpenWranglerPanel.panelSynchronizationReceiptForSession(opened.metadata.sessionId)).toBeUndefined();
    expect(OpenWranglerPanel.panelSynchronizableForSession(opened.metadata.sessionId)).toBe(false);
  });

  it("drains a synchronization requested after the current runner's final loop check", async () => {
    const heldMarker = deferred<boolean>();
    let markerCount = 0;
    const harness = createPanelHarness(
      { request: vi.fn(async () => openedResponse) },
      {
        postMessage: async (message) => {
          if (isRendererSynchronizationMessage(message)) {
            markerCount += 1;
            if (markerCount === 1) return heldMarker.promise;
          }
          return true;
        }
      }
    );
    await harness.open();

    const initialSynchronization = harness.receive({ kind: "ready" });
    await vi.waitFor(() => expect(markerCount).toBe(1));

    let pull: Promise<void> | undefined;
    heldMarker.resolve(true);
    // Cross the async postMessage wrappers and the runner's final await so
    // this pull lands after its loop condition but before the old .then cleanup.
    queueMicrotask(() =>
      queueMicrotask(() =>
        queueMicrotask(() =>
          queueMicrotask(() => {
            pull = harness.receive({ kind: "requestSessionSnapshot" });
          })
        )
      )
    );

    await initialSynchronization;
    await vi.waitFor(() => expect(pull).toBeDefined());
    await pull;
    expect(markerCount).toBe(2);
  });

  it("adopts the matching automatic synchronization before considering a replacement", async () => {
    const harness = createPanelHarness({ request: vi.fn(async () => openedResponse) });
    await harness.open();
    expect(OpenWranglerPanel.panelSynchronizableForSession(openedResponse.metadata.sessionId)).toBe(false);
    await harness.receive({ kind: "ready" });
    const automaticMarker = latestRendererSynchronization(harness.posted);
    expect(OpenWranglerPanel.panelSynchronizableForSession(openedResponse.metadata.sessionId)).toBe(true);

    const synchronization = OpenWranglerPanel.ensurePanelSynchronizedForSession(openedResponse.metadata.sessionId);
    expect(harness.posted.filter(isRendererSynchronizationMessage)).toEqual([automaticMarker]);

    await harness.receive({
      kind: "rendererSynchronized",
      syncId: automaticMarker.syncId,
      sessionId: automaticMarker.sessionId,
      revision: automaticMarker.revision
    });
    await expect(synchronization).resolves.toBe(true);
    expect(harness.posted.filter(isRendererSynchronizationMessage)).toEqual([automaticMarker]);

    harness.dispose();
    expect(OpenWranglerPanel.panelSynchronizableForSession(openedResponse.metadata.sessionId)).toBe(false);
  });

  it("reloads a renderer after its current synchronization acknowledgement expires", async () => {
    vi.useFakeTimers();
    try {
      const harness = createPanelHarness({ request: vi.fn(async () => openedResponse) });
      await harness.open();
      await harness.receive({ kind: "ready" });
      const automaticMarker = latestRendererSynchronization(harness.posted);

      const synchronization = OpenWranglerPanel.ensurePanelSynchronizedForSession(openedResponse.metadata.sessionId);
      expect(harness.posted.filter(isRendererSynchronizationMessage)).toEqual([automaticMarker]);

      await vi.advanceTimersByTimeAsync(5_000);
      await Promise.resolve();
      await expect(synchronization).resolves.toBe(false);
      expect(harness.htmlAssignmentCount).toBe(2);
      expect(harness.posted.filter(isRendererSynchronizationMessage)).toEqual([automaticMarker]);

      await harness.receive({ kind: "ready" });
      const replacementMarker = latestRendererSynchronization(harness.posted);
      expect(replacementMarker.syncId).not.toBe(automaticMarker.syncId);
      const recovered = OpenWranglerPanel.ensurePanelSynchronizedForSession(openedResponse.metadata.sessionId);

      await harness.receive({
        kind: "rendererSynchronized",
        syncId: replacementMarker.syncId,
        sessionId: replacementMarker.sessionId,
        revision: replacementMarker.revision
      });
      await expect(recovered).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not publish a replacement after the caller's synchronization deadline", async () => {
    vi.useFakeTimers();
    try {
      const harness = createPanelHarness({ request: vi.fn(async () => openedResponse) });
      await harness.open();
      await harness.receive({ kind: "ready" });
      const automaticMarker = latestRendererSynchronization(harness.posted);

      const synchronization = OpenWranglerPanel.ensurePanelSynchronizedForSession(
        openedResponse.metadata.sessionId,
        Date.now() + 100
      );
      await vi.advanceTimersByTimeAsync(100);
      await expect(synchronization).resolves.toBe(false);
      expect(harness.posted.filter(isRendererSynchronizationMessage)).toEqual([automaticMarker]);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(harness.posted.filter(isRendererSynchronizationMessage)).toEqual([automaticMarker]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never invalidates a newer automatic synchronization that appears while it is waiting", async () => {
    const harness = createPanelHarness({ request: vi.fn(async () => openedResponse) });
    await harness.open();
    await harness.receive({ kind: "ready" });
    const firstMarker = latestRendererSynchronization(harness.posted);

    const synchronization = OpenWranglerPanel.ensurePanelSynchronizedForSession(openedResponse.metadata.sessionId);
    await harness.receive({ kind: "requestSessionSnapshot" });
    const replacementMarker = latestRendererSynchronization(harness.posted);
    expect(replacementMarker.syncId).not.toBe(firstMarker.syncId);
    await expect(synchronization).resolves.toBe(false);
    expect(harness.posted.filter(isRendererSynchronizationMessage)).toEqual([firstMarker, replacementMarker]);

    await harness.receive({
      kind: "rendererSynchronized",
      syncId: replacementMarker.syncId,
      sessionId: replacementMarker.sessionId,
      revision: replacementMarker.revision
    });
    expect(OpenWranglerPanel.panelHydratedForSession(openedResponse.metadata.sessionId)).toBe(true);
    expect(harness.posted.filter(isRendererSynchronizationMessage)).toHaveLength(2);
  });

  it("requires a fresh renderer-ready handshake after the synchronization marker cannot be delivered", async () => {
    let rejectSynchronizationMarker = true;
    const harness = createPanelHarness(
      { request: vi.fn(async () => openedResponse) },
      {
        postMessage: async (message) => !(rejectSynchronizationMarker && isRendererSynchronizationMessage(message))
      }
    );
    await harness.open();

    await harness.receive({ kind: "ready" });

    await expect(OpenWranglerPanel.synchronizePanelForSession(openedResponse.metadata.sessionId)).resolves.toBe(false);
    expect(OpenWranglerPanel.panelHydratedForSession(openedResponse.metadata.sessionId)).toBe(false);

    rejectSynchronizationMarker = false;
    harness.posted.length = 0;
    await harness.receive({ kind: "ready" });
    const freshMarker = latestRendererSynchronization(harness.posted);
    await harness.receive({
      kind: "rendererSynchronized",
      syncId: freshMarker.syncId,
      sessionId: freshMarker.sessionId,
      revision: freshMarker.revision
    });

    expect(OpenWranglerPanel.panelHydratedForSession(openedResponse.metadata.sessionId)).toBe(true);
  });

  it("retires only an exact visible hydrated renderer through the test environment without changing host ownership", async () => {
    vi.useFakeTimers();
    const previousExtensionTests = process.env.OPEN_WRANGLER_EXTENSION_TESTS;
    try {
      process.env.OPEN_WRANGLER_EXTENSION_TESTS = "1";
      const request = vi.fn(async (candidate: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
        if (candidate.kind === "openSession") return openedResponse;
        if (candidate.kind === "closeSession") {
          return { kind: "sessionClosed", sessionId: candidate.sessionId };
        }
        throw new Error(`Unexpected request ${candidate.kind}`);
      });
      const harness = createPanelHarness({ request }, { delegateOpen: true });
      await harness.open();

      expect(OpenWranglerPanel.retireRendererForSessionForTesting("missing-session")).toBe(false);
      expect(OpenWranglerPanel.retireRendererForSessionForTesting(openedResponse.metadata.sessionId)).toBe(false);
      await harness.receive({ kind: "ready" });
      const originalSynchronization = await acknowledgeLatestRendererSynchronization(harness);
      const originalReceipt = OpenWranglerPanel.panelSynchronizationReceiptForSession(
        openedResponse.metadata.sessionId
      );
      expect(originalReceipt?.syncId).toBe(originalSynchronization.syncId);
      expect(harness.htmlAssignmentCount).toBe(1);

      delete process.env.OPEN_WRANGLER_EXTENSION_TESTS;
      expect(OpenWranglerPanel.retireRendererForSessionForTesting(openedResponse.metadata.sessionId)).toBe(false);
      process.env.OPEN_WRANGLER_EXTENSION_TESTS = "1";
      harness.hide();
      expect(OpenWranglerPanel.retireRendererForSessionForTesting(openedResponse.metadata.sessionId)).toBe(false);
      harness.activate();

      expect(OpenWranglerPanel.retireRendererForSessionForTesting(openedResponse.metadata.sessionId)).toBe(true);
      expect(harness.htmlAssignmentCount).toBe(2);
      expect(harness.html).toContain("default-src 'none'");
      expect(OpenWranglerPanel.panelHydratedForSession(openedResponse.metadata.sessionId)).toBe(true);
      expect(OpenWranglerPanel.panelSynchronizationReceiptForSession(openedResponse.metadata.sessionId)).toEqual(
        originalReceipt
      );
      expect(request.mock.calls.filter(([candidate]) => candidate.kind === "openSession")).toHaveLength(1);
      expect(request.mock.calls.filter(([candidate]) => candidate.kind === "closeSession")).toHaveLength(0);

      harness.posted.length = 0;
      const stalledSynchronization = OpenWranglerPanel.synchronizePanelForSession(openedResponse.metadata.sessionId);
      for (let attempt = 0; attempt < 20 && !harness.posted.some(isRendererSynchronizationMessage); attempt += 1) {
        await Promise.resolve();
      }
      const unacknowledged = latestRendererSynchronization(harness.posted);
      expect(unacknowledged.syncId).not.toBe(originalSynchronization.syncId);
      expect(OpenWranglerPanel.panelHydratedForSession(openedResponse.metadata.sessionId)).toBe(false);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(harness.htmlAssignmentCount).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(harness.htmlAssignmentCount).toBe(3);
      await expect(stalledSynchronization).resolves.toBe(false);

      await harness.receive({ kind: "ready" });
      const recovered = latestRendererSynchronization(harness.posted);
      expect(recovered.syncId).not.toBe(unacknowledged.syncId);
      expect(recovered).toMatchObject({
        sessionId: openedResponse.metadata.sessionId,
        revision: openedResponse.metadata.revision
      });
      await harness.receive({
        kind: "rendererSynchronized",
        syncId: recovered.syncId,
        sessionId: recovered.sessionId,
        revision: recovered.revision
      });
      expect(OpenWranglerPanel.panelHydratedForSession(openedResponse.metadata.sessionId)).toBe(true);
      expect(request.mock.calls.filter(([candidate]) => candidate.kind === "openSession")).toHaveLength(1);
      expect(request.mock.calls.filter(([candidate]) => candidate.kind === "closeSession")).toHaveLength(0);
    } finally {
      if (previousExtensionTests === undefined) delete process.env.OPEN_WRANGLER_EXTENSION_TESTS;
      else process.env.OPEN_WRANGLER_EXTENSION_TESTS = previousExtensionTests;
      vi.useRealTimers();
    }
  });

  it("recovers only from the exact current hydrated renderer retirement receipt", async () => {
    vi.useFakeTimers();
    try {
      const reportDiagnostic = vi.fn();
      const request = vi.fn(async (candidate: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
        if (candidate.kind === "openSession") return openedResponse;
        if (candidate.kind === "closeSession") {
          return { kind: "sessionClosed", sessionId: candidate.sessionId };
        }
        throw new Error(`Unexpected renderer-retirement request ${candidate.kind}`);
      });
      const harness = createPanelHarness({ request, reportDiagnostic }, { delegateOpen: true });
      await harness.open();
      await harness.receive({ kind: "ready" });
      const original = await acknowledgeLatestRendererSynchronization(harness);
      expect(OpenWranglerPanel.panelHydratedForSession(openedResponse.metadata.sessionId)).toBe(true);

      await harness.receive({
        kind: "rendererRetiring",
        syncId: original.syncId,
        sessionId: original.sessionId,
        revision: original.revision,
        forged: true
      });
      await harness.receive({
        kind: "rendererRetiring",
        syncId: "X".repeat(32),
        sessionId: original.sessionId,
        revision: original.revision
      });
      await harness.receive({
        kind: "rendererRetiring",
        syncId: original.syncId,
        sessionId: original.sessionId,
        revision: Number(original.revision) + 1
      });
      expect(OpenWranglerPanel.panelHydratedForSession(openedResponse.metadata.sessionId)).toBe(true);

      await harness.receive({ kind: "requestSessionSnapshot" });
      const current = latestRendererSynchronization(harness.posted);
      expect(current.syncId).not.toBe(original.syncId);
      expect(OpenWranglerPanel.panelHydratedForSession(openedResponse.metadata.sessionId)).toBe(false);
      await harness.receive({
        kind: "rendererRetiring",
        syncId: current.syncId,
        sessionId: current.sessionId,
        revision: current.revision
      });
      expect(OpenWranglerPanel.panelSynchronizableForSession(openedResponse.metadata.sessionId)).toBe(true);
      await harness.receive({
        kind: "rendererSynchronized",
        syncId: current.syncId,
        sessionId: current.sessionId,
        revision: current.revision
      });
      expect(OpenWranglerPanel.panelHydratedForSession(openedResponse.metadata.sessionId)).toBe(true);

      const initialHtmlAssignments = harness.htmlAssignmentCount;
      await harness.receive({
        kind: "rendererRetiring",
        syncId: current.syncId,
        sessionId: current.sessionId,
        revision: current.revision
      });
      expect(OpenWranglerPanel.panelHydratedForSession(openedResponse.metadata.sessionId)).toBe(false);
      expect(
        OpenWranglerPanel.panelSynchronizationReceiptForSession(openedResponse.metadata.sessionId)
      ).toBeUndefined();
      expect(OpenWranglerPanel.panelSynchronizableForSession(openedResponse.metadata.sessionId)).toBe(false);

      await vi.advanceTimersByTimeAsync(4_999);
      expect(harness.htmlAssignmentCount).toBe(initialHtmlAssignments);
      await vi.advanceTimersByTimeAsync(1);
      expect(harness.htmlAssignmentCount).toBe(initialHtmlAssignments + 1);
      expect(reportDiagnostic).toHaveBeenCalledOnce();

      await harness.receive({
        kind: "rendererRetiring",
        syncId: current.syncId,
        sessionId: current.sessionId,
        revision: current.revision
      });
      await harness.receive({ kind: "ready" });
      const replacement = latestRendererSynchronization(harness.posted);
      expect(replacement.syncId).not.toBe(current.syncId);
      await harness.receive({
        kind: "rendererSynchronized",
        syncId: replacement.syncId,
        sessionId: replacement.sessionId,
        revision: replacement.revision
      });
      expect(OpenWranglerPanel.panelHydratedForSession(openedResponse.metadata.sessionId)).toBe(true);

      await harness.receive({
        kind: "rendererRetiring",
        syncId: current.syncId,
        sessionId: current.sessionId,
        revision: current.revision
      });
      expect(OpenWranglerPanel.panelHydratedForSession(openedResponse.metadata.sessionId)).toBe(true);
      expect(request.mock.calls.filter(([candidate]) => candidate.kind === "openSession")).toHaveLength(1);
      expect(request.mock.calls.filter(([candidate]) => candidate.kind === "closeSession")).toHaveLength(0);

      const settledHtmlAssignments = harness.htmlAssignmentCount;
      harness.dispose();
      await harness.receive({
        kind: "rendererRetiring",
        syncId: replacement.syncId,
        sessionId: replacement.sessionId,
        revision: replacement.revision
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(harness.htmlAssignmentCount).toBe(settledHtmlAssignments);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not interrupt an initial renderer when its pre-ready session publication is rejected", async () => {
    vi.useFakeTimers();
    try {
      const initialSessionPublication = deferred<boolean>();
      let heldInitialSessionPublication = false;
      const request = vi.fn(async (candidate: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
        if (candidate.kind === "closeSession") {
          return { kind: "sessionClosed", sessionId: candidate.sessionId };
        }
        return openedResponse;
      });
      const harness = createPanelHarness(
        { request },
        {
          delegateOpen: true,
          postMessage: async (message) => {
            if (!heldInitialSessionPublication && isSessionOpenedResponse(message)) {
              heldInitialSessionPublication = true;
              return initialSessionPublication.promise;
            }
            return true;
          }
        }
      );

      const opening = harness.open();
      for (let attempt = 0; attempt < 10 && !heldInitialSessionPublication; attempt += 1) await Promise.resolve();
      expect(heldInitialSessionPublication).toBe(true);

      await harness.receive({ kind: "ready" });
      const synchronization = latestRendererSynchronization(harness.posted);
      initialSessionPublication.resolve(false);
      await opening;

      expect(harness.htmlAssignmentCount).toBe(1);
      await harness.receive({
        kind: "rendererSynchronized",
        syncId: synchronization.syncId,
        sessionId: synchronization.sessionId,
        revision: synchronization.revision
      });
      await vi.advanceTimersByTimeAsync(20_000);

      expect(OpenWranglerPanel.panelHydratedForSession(openedResponse.metadata.sessionId)).toBe(true);
      expect(harness.htmlAssignmentCount).toBe(1);
      expect(request.mock.calls.filter(([candidate]) => candidate.kind === "openSession")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reloads an error renderer that starts but never acknowledges its synchronized UI", async () => {
    vi.useFakeTimers();
    try {
      const missing: OpenWranglerResponse = {
        kind: "error",
        code: "missing_dependencies",
        message: "Pandas is missing openpyxl>=3.1.5.",
        recoverable: true
      };
      const request = vi.fn(async (candidate: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
        if (candidate.kind === "closeSession") {
          return { kind: "sessionClosed", sessionId: candidate.sessionId };
        }
        return missing;
      });
      const harness = createPanelHarness({ request }, { delegateOpen: true });
      await harness.open();
      await harness.receive({ kind: "ready" });

      const missingMarker = latestRendererSynchronization(harness.posted);
      expect(missingMarker.sessionId).toBeNull();
      expect(missingMarker.revision).toBeNull();
      await vi.advanceTimersByTimeAsync(4_999);
      expect(harness.htmlAssignmentCount).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(harness.htmlAssignmentCount).toBe(2);
      expect(request.mock.calls.filter(([candidate]) => candidate.kind === "openSession")).toHaveLength(1);

      await harness.receive({ kind: "ready" });
      const recoveredMarker = latestRendererSynchronization(harness.posted);
      await harness.receive({
        kind: "rendererSynchronized",
        syncId: recoveredMarker.syncId,
        sessionId: recoveredMarker.sessionId,
        revision: recoveredMarker.revision
      });
      await vi.advanceTimersByTimeAsync(20_000);

      expect(harness.htmlAssignmentCount).toBe(2);
      expect(request.mock.calls.filter(([candidate]) => candidate.kind === "openSession")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts a fresh recovery grace period after out-of-order panel activation events", async () => {
    vi.useFakeTimers();
    try {
      const first = createPanelHarness({ request: vi.fn(async () => openedResponse) });
      await first.open();
      await vi.advanceTimersByTimeAsync(4_999);

      const second = createPanelHarness({ request: vi.fn(async () => openedResponse) }, { active: false });
      second.activate();
      first.hide();
      await vi.advanceTimersByTimeAsync(1);
      expect(first.htmlAssignmentCount).toBe(1);

      second.hide();
      first.activate();
      await vi.advanceTimersByTimeAsync(4_999);
      expect(first.htmlAssignmentCount).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(first.htmlAssignmentCount).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the same bounded recovery when a renderer generation rejects its synchronization marker", async () => {
    vi.useFakeTimers();
    try {
      let rejectSynchronizationMarker = true;
      const harness = createPanelHarness(
        { request: vi.fn(async () => openedResponse) },
        {
          postMessage: async (message) => !(rejectSynchronizationMarker && isRendererSynchronizationMessage(message))
        }
      );
      await harness.open();
      await harness.receive({ kind: "ready" });
      expect(OpenWranglerPanel.panelSynchronizableForSession(openedResponse.metadata.sessionId)).toBe(false);
      expect(harness.htmlAssignmentCount).toBe(2);

      rejectSynchronizationMarker = false;
      await harness.receive({ kind: "ready" });
      await acknowledgeLatestRendererSynchronization(harness);
      expect(OpenWranglerPanel.panelHydratedForSession(openedResponse.metadata.sessionId)).toBe(true);

      await vi.advanceTimersByTimeAsync(20_000);
      expect(harness.htmlAssignmentCount).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never reports a renderer as hydrated while its initial host publication is still opening", async () => {
    const initialPublication = deferred<void>();
    let heldInitialPublication = false;
    const harness = createPanelHarness(
      { request: vi.fn(async () => openedResponse) },
      {
        postMessage: async (message) => {
          if (!heldInitialPublication && isSessionOpenedResponse(message)) {
            heldInitialPublication = true;
            await initialPublication.promise;
          }
          return true;
        }
      }
    );

    const opening = harness.open();
    await vi.waitFor(() => expect(heldInitialPublication).toBe(true));
    await harness.receive({ kind: "ready" });
    const acknowledgedWhileOpening = latestRendererSynchronization(harness.posted);
    await harness.receive({
      kind: "rendererSynchronized",
      syncId: acknowledgedWhileOpening.syncId,
      sessionId: acknowledgedWhileOpening.sessionId,
      revision: acknowledgedWhileOpening.revision
    });

    expect(OpenWranglerPanel.panelHydratedForSession(openedResponse.metadata.sessionId)).toBe(false);
    expect(OpenWranglerPanel.panelSynchronizableForSession(openedResponse.metadata.sessionId)).toBe(false);

    initialPublication.resolve();
    await opening;
    await vi.waitFor(() => {
      const current = latestRendererSynchronization(harness.posted);
      expect(current.syncId).not.toBe(acknowledgedWhileOpening.syncId);
    });
    expect(OpenWranglerPanel.panelSynchronizableForSession(openedResponse.metadata.sessionId)).toBe(true);
    await acknowledgeLatestRendererSynchronization(harness);
    expect(OpenWranglerPanel.panelHydratedForSession(openedResponse.metadata.sessionId)).toBe(true);
  });

  it("does not publish from an old ready handler after startup recovery replaces its renderer", async () => {
    vi.useFakeTimers();
    const initialPublication = deferred<void>();
    try {
      const openResult = deferred<OpenWranglerResponse>();
      let heldInitialPublication = false;
      const request = vi.fn(async (candidate: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
        if (candidate.kind === "openSession") return openResult.promise;
        if (candidate.kind === "closeSession") {
          return { kind: "sessionClosed", sessionId: candidate.sessionId };
        }
        throw new Error("Unexpected panel request.");
      });
      const harness = createPanelHarness(
        { request },
        {
          delegateOpen: true,
          postMessage: async (message) => {
            if (!heldInitialPublication && isSessionOpenedResponse(message)) {
              heldInitialPublication = true;
              await initialPublication.promise;
            }
            return true;
          }
        }
      );

      const opening = harness.open();
      const firstReady = harness.receive({ kind: "ready" });
      for (let attempt = 0; attempt < 20; attempt += 1) await Promise.resolve();
      openResult.resolve(openedResponse);
      for (let attempt = 0; attempt < 10 && !heldInitialPublication; attempt += 1) await Promise.resolve();
      expect(heldInitialPublication).toBe(true);

      await vi.advanceTimersByTimeAsync(5_000);
      await opening;
      await firstReady;

      expect(harness.htmlAssignmentCount).toBe(2);
      expect(harness.posted.filter(isSessionOpenedResponse)).toEqual([openedResponse]);
      expect(OpenWranglerPanel.panelSynchronizableForSession(openedResponse.metadata.sessionId)).toBe(false);

      await harness.receive({ kind: "ready" });
      await acknowledgeLatestRendererSynchronization(harness);
      expect(harness.posted.filter(isSessionOpenedResponse)).toEqual([openedResponse, openedResponse]);
      expect(OpenWranglerPanel.panelHydratedForSession(openedResponse.metadata.sessionId)).toBe(true);
    } finally {
      initialPublication.resolve();
      vi.useRealTimers();
    }
  });

  it("abandons a stalled initial publication and hydrates one recovered renderer generation", async () => {
    vi.useFakeTimers();
    try {
      const initialPublication = deferred<void>();
      let heldInitialPublication = false;
      const request = vi.fn(async (): Promise<OpenWranglerResponse> => openedResponse);
      const harness = createPanelHarness(
        { request },
        {
          delegateOpen: true,
          postMessage: async (message) => {
            if (!heldInitialPublication && isSessionOpenedResponse(message)) {
              heldInitialPublication = true;
              await initialPublication.promise;
            }
            return true;
          }
        }
      );

      let openingSettled = false;
      const opening = harness.open().then(() => {
        openingSettled = true;
      });
      for (let attempt = 0; attempt < 10 && !heldInitialPublication; attempt += 1) await Promise.resolve();
      expect(heldInitialPublication).toBe(true);
      await harness.receive({ kind: "ready" });
      expect(OpenWranglerPanel.panelHydratedForSession(openedResponse.metadata.sessionId)).toBe(false);
      expect(OpenWranglerPanel.panelSynchronizableForSession(openedResponse.metadata.sessionId)).toBe(false);

      await vi.advanceTimersByTimeAsync(4_999);
      expect(openingSettled).toBe(false);
      expect(harness.htmlAssignmentCount).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await opening;

      expect(harness.htmlAssignmentCount).toBe(2);
      expect(request).toHaveBeenCalledOnce();
      expect(OpenWranglerPanel.panelHydratedForSession(openedResponse.metadata.sessionId)).toBe(false);

      await harness.receive({ kind: "ready" });
      await acknowledgeLatestRendererSynchronization(harness);
      expect(OpenWranglerPanel.panelHydratedForSession(openedResponse.metadata.sessionId)).toBe(true);

      initialPublication.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(OpenWranglerPanel.panelHydratedForSession(openedResponse.metadata.sessionId)).toBe(true);
      expect(harness.htmlAssignmentCount).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retire a renderer that hydrated while an older publication was stalled", async () => {
    vi.useFakeTimers();
    try {
      const initialPublication = deferred<void>();
      let heldInitialPublication = false;
      const harness = createPanelHarness(
        { request: vi.fn(async (): Promise<OpenWranglerResponse> => openedResponse) },
        {
          delegateOpen: true,
          postMessage: async (message) => {
            if (!heldInitialPublication && isSessionOpenedResponse(message)) {
              heldInitialPublication = true;
              await initialPublication.promise;
            }
            return true;
          }
        }
      );

      const opening = harness.open();
      for (let attempt = 0; attempt < 10 && !heldInitialPublication; attempt += 1) await Promise.resolve();
      expect(heldInitialPublication).toBe(true);
      await harness.receive({ kind: "ready" });
      await acknowledgeLatestRendererSynchronization(harness);

      await vi.advanceTimersByTimeAsync(5_000);
      await opening;

      expect(harness.htmlAssignmentCount).toBe(1);
      expect(OpenWranglerPanel.panelHydratedForSession(openedResponse.metadata.sessionId)).toBe(true);

      initialPublication.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(harness.htmlAssignmentCount).toBe(1);
      expect(OpenWranglerPanel.panelHydratedForSession(openedResponse.metadata.sessionId)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("replays attempt-scoped PySpark open progress to a late renderer and clears it at the terminal response", async () => {
    const openResult = deferred<OpenWranglerResponse>();
    const releaseAcquiringPublication = deferred<void>();
    let heldAcquiringPublication = false;
    let reportProgress: BridgeRequestOptions["onOpenProgress"];
    const request: OpenWranglerBridge["request"] = vi.fn(async (request, options): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") {
        reportProgress = options?.onOpenProgress;
        return openResult.promise;
      }
      if (request.kind === "closeSession") {
        return { kind: "sessionClosed", sessionId: request.sessionId };
      }
      return {
        kind: "error",
        code: "unexpected_request",
        message: "Unexpected test request.",
        recoverable: false
      };
    });
    const bridge: OpenWranglerBridge = {
      request
    };
    const harness = createPanelHarness(bridge, {
      backend: "pyspark",
      backendPreference: "pyspark",
      delegateOpen: true,
      source: { kind: "notebookVariable", label: "spark_df", variableName: "spark_df" },
      postMessage: async (message) => {
        if (!heldAcquiringPublication && isSessionOpenProgressMessage(message) && message.stage === "acquiringKernel") {
          heldAcquiringPublication = true;
          await releaseAcquiringPublication.promise;
        }
        return true;
      }
    });

    const opening = harness.open();
    await vi.waitFor(() => expect(reportProgress).toEqual(expect.any(Function)));
    reportProgress?.("acquiringKernel");
    expect(harness.posted).not.toContainEqual(expect.objectContaining({ kind: "sessionOpenProgress" }));

    const rendererReady = harness.receive({ kind: "ready" });
    await vi.waitFor(() =>
      expect(harness.posted).toContainEqual({ kind: "sessionOpenProgress", stage: "acquiringKernel" })
    );
    reportProgress?.("bootstrappingRuntime");
    reportProgress?.("preparingSparkView");
    expect(harness.posted.filter(isSessionOpenProgressMessage)).toEqual([
      { kind: "sessionOpenProgress", stage: "acquiringKernel" }
    ]);
    releaseAcquiringPublication.resolve(undefined);
    await vi.waitFor(() =>
      expect(harness.posted.filter(isSessionOpenProgressMessage)).toEqual([
        { kind: "sessionOpenProgress", stage: "acquiringKernel" },
        { kind: "sessionOpenProgress", stage: "bootstrappingRuntime" },
        { kind: "sessionOpenProgress", stage: "preparingSparkView" }
      ])
    );

    const pysparkOpened: SessionOpenedResponse = {
      ...openedResponse,
      metadata: {
        ...openedResponse.metadata,
        backend: "pyspark",
        mode: "viewing",
        source: { kind: "notebookVariable", label: "spark_df", variableName: "spark_df" },
        capabilities: { ...openedResponse.metadata.capabilities, editable: false }
      }
    };
    openResult.resolve(pysparkOpened);
    await opening;
    await rendererReady;

    expect(harness.posted.filter(isSessionOpenProgressMessage)).toEqual([
      { kind: "sessionOpenProgress", stage: "acquiringKernel" },
      { kind: "sessionOpenProgress", stage: "bootstrappingRuntime" },
      { kind: "sessionOpenProgress", stage: "preparingSparkView" },
      { kind: "sessionOpenProgress", stage: null }
    ]);

    const publishedCount = harness.posted.length;
    reportProgress?.("acquiringKernel");
    expect(harness.posted).toHaveLength(publishedCount);
    harness.dispose();
    reportProgress?.("preparingSparkView");
    expect(harness.posted).toHaveLength(publishedCount);
  });

  it("passes a host-only disposal signal and closes a late live-notebook session exactly once", async () => {
    const openResult = deferred<OpenWranglerResponse>();
    let reportProgress: BridgeRequestOptions["onOpenProgress"];
    let openCancellation: BridgeRequestOptions["cancellation"];
    const closeRequests: OpenWranglerRequest[] = [];
    const request: OpenWranglerBridge["request"] = vi.fn((runtimeRequest, options): Promise<OpenWranglerResponse> => {
      if (runtimeRequest.kind === "closeSession") {
        closeRequests.push(runtimeRequest);
        return Promise.resolve({ kind: "sessionClosed", sessionId: runtimeRequest.sessionId });
      }
      if (runtimeRequest.kind !== "openSession") throw new Error(`Unexpected request ${runtimeRequest.kind}`);
      reportProgress = options?.onOpenProgress;
      openCancellation = options?.cancellation;
      return openResult.promise;
    });
    const harness = createPanelHarness(
      { request },
      {
        backend: null,
        backendPreference: "auto",
        delegateOpen: true,
        source: { kind: "notebookVariable", label: "auto_df", variableName: "auto_df" }
      }
    );

    const opening = harness.open();
    await vi.waitFor(() => expect(reportProgress).toEqual(expect.any(Function)));
    expect(openCancellation?.isCancellationRequested).toBe(false);
    expect(request).toHaveBeenCalledWith(
      expect.not.objectContaining({ backend: expect.anything() }),
      expect.any(Object)
    );
    reportProgress?.("acquiringKernel");
    reportProgress?.("bootstrappingRuntime");
    reportProgress?.("openingNotebookVariable");
    harness.dispose();
    expect(openCancellation?.isCancellationRequested).toBe(true);
    openResult.resolve(openedResponse);
    await opening;
    expect(closeRequests).toEqual([
      { kind: "closeSession", sessionId: openedResponse.metadata.sessionId, revision: openedResponse.metadata.revision }
    ]);
    expect(harness.posted).not.toContainEqual(expect.objectContaining({ kind: "sessionOpened" }));
  });

  it("routes screenshot-evidence drafts through the live panel snapshot", async () => {
    const draft = {
      id: "screenshot-uppercase",
      kind: "upperText",
      params: { column: { id: "c:0", name: "city" } }
    } as const;
    const preview: OpenWranglerResponse = {
      kind: "stepPreview",
      revision: 1,
      metadata: { ...metadata, revision: 1, draftStep: draft },
      page,
      diff: {
        addedRows: 0,
        removedRows: 0,
        addedColumns: [],
        removedColumns: [],
        changedCells: 1,
        cells: [
          {
            rowNumber: 0,
            columnId: "c:0",
            column: "city",
            before: page.rows[0]!.values[0]!,
            after: { kind: "string", raw: "BERLIN", display: "BERLIN", isNull: false, isNaN: false }
          }
        ],
        truncated: false
      },
      code: "def clean_data(df):\n    return df\n"
    };
    const request = vi.fn(async (candidate: OpenWranglerRequest) =>
      candidate.kind === "previewStep" ? preview : openedResponse
    );
    const harness = createPanelHarness({ request }, { openResponse: openedResponse });
    await harness.open();
    await harness.receive({ kind: "ready" });
    const previewRequest = {
      kind: "previewStep",
      sessionId: "session",
      revision: 0,
      step: draft,
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 16
    } satisfies Extract<OpenWranglerRequest, { kind: "previewStep" }>;

    const snapshot = await OpenWranglerPanel.previewStepForSessionForTesting(previewRequest);

    expect(snapshot?.metadata.draftStep).toEqual(draft);
    expect(snapshot?.metadata.revision).toBe(1);
    expect(snapshot?.page.rows[0]?.values[0]?.display).toBe("Berlin");
    expect(request).toHaveBeenLastCalledWith(previewRequest, undefined);
    expect(harness.posted).toContainEqual(preview);
  });

  it("reveals Code Preview only after the exact first draft synchronization and only once per session", async () => {
    const executeCommand = vi.spyOn(commands, "executeCommand");
    const codePreviewFocus = deferred<unknown>();
    const draft = {
      id: "acknowledged-uppercase",
      kind: "upperText",
      params: { column: { id: "c:0", name: "city" } }
    } as const;
    const secondDraft = {
      id: "second-uppercase",
      kind: "upperText",
      params: { column: { id: "c:0", name: "city" } }
    } as const;
    const preview: OpenWranglerResponse = {
      kind: "stepPreview",
      revision: 1,
      metadata: { ...metadata, revision: 1, draftStep: draft },
      page,
      diff: {
        addedRows: 0,
        removedRows: 0,
        addedColumns: [],
        removedColumns: [],
        changedCells: 1,
        cells: [],
        truncated: false
      },
      code: "def clean_data(df):\n    return df\n"
    };
    const discarded: OpenWranglerResponse = {
      kind: "planUpdated",
      action: "discard",
      revision: 2,
      metadata: { ...metadata, revision: 2 },
      page,
      code: "def clean_data(df):\n    return df\n"
    };
    const secondPreview: OpenWranglerResponse = {
      kind: "stepPreview",
      revision: 3,
      metadata: { ...metadata, revision: 3, draftStep: secondDraft },
      page,
      diff: {
        addedRows: 0,
        removedRows: 0,
        addedColumns: [],
        removedColumns: [],
        changedCells: 1,
        cells: [],
        truncated: false
      },
      code: "def clean_data(df):\n    return df\n"
    };
    const harness = createPanelHarness(
      {
        request: vi.fn(async (candidate: OpenWranglerRequest) => {
          if (candidate.kind === "discardDraft") return discarded;
          if (candidate.kind === "previewStep") {
            return candidate.step.id === secondDraft.id ? secondPreview : preview;
          }
          return openedResponse;
        })
      },
      { openResponse: openedResponse }
    );
    await harness.open();
    await harness.receive({ kind: "ready" });
    const initialMarker = await acknowledgeLatestRendererSynchronization(harness);
    expect(initialMarker.layoutTransitionPending).toBe(false);
    executeCommand.mockClear();
    executeCommand.mockImplementation((command: string) =>
      command === "openWrangler.codePreview.focus" ? codePreviewFocus.promise : Promise.resolve(undefined)
    );
    harness.posted.length = 0;

    await OpenWranglerPanel.previewStepForSessionForTesting({
      kind: "previewStep",
      sessionId: metadata.sessionId,
      revision: metadata.revision,
      step: draft,
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 16
    });
    await vi.waitFor(() => expect(harness.posted.some(isRendererSynchronizationMessage)).toBe(true));
    const draftMarker = latestRendererSynchronization(harness.posted);
    expect(draftMarker.layoutTransitionPending).toBe(true);

    expect(executeCommand).not.toHaveBeenCalledWith("openWrangler.codePreview.focus", { preserveFocus: true });
    expect(harness.htmlAssignmentCount).toBe(1);
    expect(harness.posted.filter(isRendererSynchronizationMessage)).toHaveLength(1);

    await harness.receive({
      kind: "rendererSynchronized",
      syncId: draftMarker.syncId,
      sessionId: draftMarker.sessionId,
      revision: draftMarker.revision
    });
    await vi.waitFor(() =>
      expect(executeCommand).toHaveBeenCalledWith("openWrangler.codePreview.focus", { preserveFocus: true })
    );
    expect(executeCommand.mock.calls).toEqual([["openWrangler.codePreview.focus", { preserveFocus: true }]]);
    expect(harness.reveal).not.toHaveBeenCalled();
    expect(harness.htmlAssignmentCount).toBe(1);
    expect(harness.posted.filter(isRendererSynchronizationMessage)).toHaveLength(1);
    expect(OpenWranglerPanel.panelHydratedForSession(openedResponse.metadata.sessionId)).toBe(true);
    expect(OpenWranglerPanel.panelSynchronizationReceiptForSession(openedResponse.metadata.sessionId)).toEqual({
      syncId: draftMarker.syncId,
      sessionId: draftMarker.sessionId,
      revision: draftMarker.revision,
      layoutTransitionPending: true
    });

    codePreviewFocus.resolve(undefined);
    await vi.waitFor(() => expect(harness.posted.filter(isRendererSynchronizationMessage)).toHaveLength(2));
    const settledMarker = latestRendererSynchronization(harness.posted);
    expect(settledMarker).not.toEqual(draftMarker);
    expect(settledMarker.layoutTransitionPending).toBe(false);

    // A stale duplicate acknowledgement cannot satisfy the new post-layout
    // barrier or reopen Code Preview.
    await harness.receive({
      kind: "rendererSynchronized",
      syncId: draftMarker.syncId,
      sessionId: draftMarker.sessionId,
      revision: draftMarker.revision
    });
    expect(OpenWranglerPanel.panelHydratedForSession(openedResponse.metadata.sessionId)).toBe(false);
    expect(executeCommand).toHaveBeenCalledTimes(1);
    expect(harness.htmlAssignmentCount).toBe(1);
    expect(harness.posted.filter(isRendererSynchronizationMessage)).toHaveLength(2);

    await harness.receive({
      kind: "rendererSynchronized",
      syncId: settledMarker.syncId,
      sessionId: settledMarker.sessionId,
      revision: settledMarker.revision
    });
    expect(OpenWranglerPanel.panelHydratedForSession(openedResponse.metadata.sessionId)).toBe(true);
    expect(OpenWranglerPanel.panelSynchronizationReceiptForSession(openedResponse.metadata.sessionId)).toEqual({
      syncId: settledMarker.syncId,
      sessionId: settledMarker.sessionId,
      revision: settledMarker.revision,
      layoutTransitionPending: false
    });
    expect(executeCommand).toHaveBeenCalledTimes(1);
    expect(harness.posted.filter(isRendererSynchronizationMessage)).toHaveLength(2);

    harness.posted.length = 0;
    await harness.receive({
      kind: "runtimeRequest",
      request: {
        kind: "discardDraft",
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 16
      }
    });
    await vi.waitFor(() => expect(harness.posted.some(isRendererSynchronizationMessage)).toBe(true));
    const discardedMarker = latestRendererSynchronization(harness.posted);
    await harness.receive({
      kind: "rendererSynchronized",
      syncId: discardedMarker.syncId,
      sessionId: discardedMarker.sessionId,
      revision: discardedMarker.revision
    });
    expect(executeCommand).toHaveBeenCalledTimes(1);

    harness.posted.length = 0;
    await OpenWranglerPanel.previewStepForSessionForTesting({
      kind: "previewStep",
      sessionId: metadata.sessionId,
      revision: 2,
      step: secondDraft,
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 16
    });
    await vi.waitFor(() => expect(harness.posted.some(isRendererSynchronizationMessage)).toBe(true));
    const secondDraftMarker = latestRendererSynchronization(harness.posted);
    await harness.receive({
      kind: "rendererSynchronized",
      syncId: secondDraftMarker.syncId,
      sessionId: secondDraftMarker.sessionId,
      revision: secondDraftMarker.revision
    });

    expect(executeCommand).toHaveBeenCalledTimes(1);
    expect(harness.reveal).not.toHaveBeenCalled();
    expect(harness.htmlAssignmentCount).toBe(1);
    expect(harness.posted.filter(isRendererSynchronizationMessage)).toHaveLength(1);
    expect(OpenWranglerPanel.panelHydratedForSession(openedResponse.metadata.sessionId)).toBe(true);
  });

  it("publishes a settled renderer barrier when Code Preview cannot be revealed", async () => {
    const executeCommand = vi.spyOn(commands, "executeCommand");
    const reportDiagnostic = vi.fn();
    const draft = {
      id: "failed-code-preview",
      kind: "upperText",
      params: { column: { id: "c:0", name: "city" } }
    } as const;
    const preview: OpenWranglerResponse = {
      kind: "stepPreview",
      revision: 1,
      metadata: { ...metadata, revision: 1, draftStep: draft },
      page,
      diff: {
        addedRows: 0,
        removedRows: 0,
        addedColumns: [],
        removedColumns: [],
        changedCells: 1,
        cells: [],
        truncated: false
      },
      code: "def clean_data(df):\n    return df\n"
    };
    const harness = createPanelHarness(
      {
        request: vi.fn(async (candidate: OpenWranglerRequest) =>
          candidate.kind === "previewStep" ? preview : openedResponse
        ),
        reportDiagnostic
      },
      { openResponse: openedResponse }
    );
    await harness.open();
    await harness.receive({ kind: "ready" });
    await acknowledgeLatestRendererSynchronization(harness);
    harness.posted.length = 0;
    executeCommand.mockRejectedValueOnce(new Error("Code Preview is unavailable"));

    await OpenWranglerPanel.previewStepForSessionForTesting({
      kind: "previewStep",
      sessionId: metadata.sessionId,
      revision: metadata.revision,
      step: draft,
      offset: 0,
      limit: 20,
      columnOffset: 0,
      columnLimit: 16
    });
    await vi.waitFor(() => expect(harness.posted.filter(isRendererSynchronizationMessage)).toHaveLength(1));
    const pendingMarker = latestRendererSynchronization(harness.posted);
    expect(pendingMarker.layoutTransitionPending).toBe(true);

    await harness.receive({
      kind: "rendererSynchronized",
      syncId: pendingMarker.syncId,
      sessionId: pendingMarker.sessionId,
      revision: pendingMarker.revision
    });
    await vi.waitFor(() => expect(harness.posted.filter(isRendererSynchronizationMessage)).toHaveLength(2));

    expect(latestRendererSynchronization(harness.posted).layoutTransitionPending).toBe(false);
    expect(executeCommand).toHaveBeenCalledWith("openWrangler.codePreview.focus", { preserveFocus: true });
    expect(reportDiagnostic).toHaveBeenCalledWith(
      "Open Wrangler could not reveal Code Preview: Code Preview is unavailable"
    );
  });

  it("does not let a pre-draft page replace the retained preview snapshot", async () => {
    const oldPage = deferred<OpenWranglerResponse>();
    const draft = {
      id: "uppercase-after-page",
      kind: "upperText",
      params: { column: { id: "c:0", name: "city" } }
    } as const;
    const preview: OpenWranglerResponse = {
      kind: "stepPreview",
      revision: 1,
      metadata: { ...metadata, revision: 1, draftStep: draft },
      page,
      diff: {
        addedRows: 0,
        removedRows: 0,
        addedColumns: [],
        removedColumns: [],
        changedCells: 1,
        cells: [],
        truncated: false
      },
      code: "def clean_data(df):\n    return df\n"
    };
    const request = vi.fn(async (candidate: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (candidate.kind === "getPage") return oldPage.promise;
      if (candidate.kind === "previewStep") return preview;
      throw new Error(`Unexpected request ${candidate.kind}`);
    });
    const harness = createPanelHarness({ request }, { openResponse: openedResponse });
    await harness.open();

    const pendingPage = harness.receive(pageMessage("pre-draft-page", "pre-draft-view"));
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    await harness.receive({
      kind: "runtimeRequest",
      request: {
        kind: "previewStep",
        step: draft,
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 16
      }
    });

    const stalePage: OpenWranglerResponse = {
      kind: "page",
      revision: 0,
      viewRequestId: "pre-draft-page",
      metadata,
      page
    };
    oldPage.resolve(stalePage);
    await pendingPage;
    harness.posted.length = 0;

    await harness.receive({ kind: "requestSessionSnapshot" });

    const retained = harness.posted.find(isSessionOpenedResponse);
    expect(retained?.metadata.revision).toBe(1);
    expect(retained?.metadata.draftStep).toEqual(draft);
    expect(latestRendererSynchronization(harness.posted)).toMatchObject({
      sessionId: metadata.sessionId,
      revision: 1
    });
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

  it("coalesces a late manual intent with the active native fallback transaction", async () => {
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
      const delimiterPrompt = deferred<unknown>();
      let delimiterChoices: PromptPick[] = [];
      panelPromptMocks.showQuickPick.mockImplementation(async (items, options) => {
        const choices = items as PromptPick[];
        if (options?.title === "Delimiter") {
          delimiterChoices = choices;
          return delimiterPrompt.promise;
        }
        if (options?.title === "Text encoding") return choices.find(({ value }) => value === "utf-8");
        if (options?.title === "Header row") return choices.find(({ value }) => value === true);
        return choices[0];
      });
      panelPromptMocks.showInputBox.mockImplementation(async (options) =>
        options?.title === "Quote character" ? '"' : options?.value
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
      harness.posted.length = 0;

      const command = OpenWranglerPanel.changeActiveImportOptions();
      const rendererRequest = harness.posted.find(isRendererImportRequest);
      if (!rendererRequest) throw new Error("The panel did not publish a renderer import request.");
      await vi.advanceTimersByTimeAsync(1_500);
      await vi.waitFor(() => expect(delimiterChoices.length).toBeGreaterThan(0));

      const manualIntent = harness.receive({ kind: "changeImportOptions" });
      await Promise.resolve();
      expect(panelPromptMocks.showQuickPick).toHaveBeenCalledOnce();
      expect(reconfigureFileSession).not.toHaveBeenCalled();

      delimiterPrompt.resolve(delimiterChoices.find(({ value }) => value === ";"));
      await expect(Promise.all([command, manualIntent])).resolves.toEqual([true, undefined]);
      expect(reconfigureFileSession).toHaveBeenCalledOnce();
      expect(panelPromptMocks.showQuickPick).toHaveBeenCalledTimes(3);

      await harness.receive({ kind: "changeImportOptions", actionId: rendererRequest.actionId });
      expect(reconfigureFileSession).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces a native command with an already active manual import transaction", async () => {
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
    const delimiterPrompt = deferred<unknown>();
    let delimiterChoices: PromptPick[] = [];
    panelPromptMocks.showQuickPick.mockImplementation(async (items, options) => {
      const choices = items as PromptPick[];
      if (options?.title === "Delimiter") {
        delimiterChoices = choices;
        return delimiterPrompt.promise;
      }
      if (options?.title === "Text encoding") return choices.find(({ value }) => value === "utf-8");
      if (options?.title === "Header row") return choices.find(({ value }) => value === true);
      return choices[0];
    });
    panelPromptMocks.showInputBox.mockImplementation(async (options) =>
      options?.title === "Quote character" ? '"' : options?.value
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
    harness.posted.length = 0;

    const manualIntent = harness.receive({ kind: "changeImportOptions" });
    await vi.waitFor(() => expect(delimiterChoices.length).toBeGreaterThan(0));
    const command = OpenWranglerPanel.changeActiveImportOptions();
    await Promise.resolve();
    expect(harness.posted.filter(isRendererImportRequest)).toHaveLength(0);
    expect(panelPromptMocks.showQuickPick).toHaveBeenCalledOnce();

    delimiterPrompt.resolve(delimiterChoices.find(({ value }) => value === ";"));
    await expect(Promise.all([manualIntent, command])).resolves.toEqual([undefined, true]);
    expect(reconfigureFileSession).toHaveBeenCalledOnce();
    expect(panelPromptMocks.showQuickPick).toHaveBeenCalledTimes(3);
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

  it("falls back from an out-of-range horizontal block setting before exposing or requesting it", async () => {
    vi.spyOn(workspace, "getConfiguration").mockImplementation(
      () =>
        ({
          get: (key: string, fallback?: unknown): unknown => (key === "fetchColumnBlockSize" ? 999 : fallback)
        }) as vscode.WorkspaceConfiguration
    );
    const request = vi.fn(async (_request: OpenWranglerRequest): Promise<OpenWranglerResponse> => openedResponse);
    const harness = createPanelHarness({ request }, { delegateOpen: true });

    expect(harness.html).toContain('data-fetch-column-block-size="16"');
    expect(request).not.toHaveBeenCalled();
    await harness.open();
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      kind: "openSession",
      columnOffset: 0,
      columnLimit: 16
    });
  });

  it("forwards validated profile priority and rejects unsupported values", async () => {
    const request = vi.fn(
      async (candidate: OpenWranglerRequest, _options?: BridgeRequestOptions): Promise<OpenWranglerResponse> => {
        if (candidate.kind === "getSummary") {
          return {
            kind: "summary",
            revision: metadata.revision,
            viewRequestId: candidate.viewRequestId,
            summaries: [summary]
          };
        }
        throw new Error(`Unexpected request ${candidate.kind}`);
      }
    );
    const prioritizeViewRequest = vi.fn();
    const harness = createPanelHarness({ request, prioritizeViewRequest });
    await harness.open();
    await harness.send({ kind: "setViewContext", viewContextId: "priority-view" });

    await harness.send({ kind: "prioritizeViewRequest", viewRequestId: "selected-summary" });
    expect(prioritizeViewRequest).toHaveBeenCalledWith("session", "selected-summary");
    await harness.send({ kind: "prioritizeViewRequest", viewRequestId: "" });
    await harness.send({ kind: "prioritizeViewRequest", viewRequestId: "selected-summary", priority: "interactive" });
    expect(prioritizeViewRequest).toHaveBeenCalledOnce();

    await harness.send({
      kind: "runtimeRequest",
      priority: "interactive",
      viewContextId: "priority-view",
      request: {
        kind: "getSummary",
        viewRequestId: "selected-summary",
        filterModel: metadata.filterModel,
        columnIds: ["c:0"]
      }
    });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "getSummary", viewRequestId: "selected-summary" }),
      { priority: "interactive", viewContextId: "priority-view" }
    );

    request.mockClear();
    await harness.send({
      kind: "runtimeRequest",
      priority: "urgent",
      viewContextId: "priority-view",
      request: {
        kind: "getSummary",
        viewRequestId: "invalid-priority",
        filterModel: metadata.filterModel,
        columnIds: ["c:0"]
      }
    });
    expect(request).not.toHaveBeenCalled();

    await harness.send({
      kind: "runtimeRequest",
      priority: "interactive",
      request: { kind: "undoStep", offset: 0, limit: 20, columnOffset: 0, columnLimit: 16 }
    });
    expect(request).not.toHaveBeenCalled();
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
        columnIds: ["c:0"]
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
        columnIds: ["c:0"]
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

  it("retains duplicate-label profiles by stable ID and republishes them in schema order", async () => {
    const duplicateMetadata: SessionMetadata = {
      ...metadata,
      backend: "pandas",
      shape: { rows: 2, columns: 2 },
      filteredShape: { rows: 2, columns: 2 },
      schema: [
        { id: "c:left", name: "duplicate", position: 0, rawType: "Int64", type: "integer", nullable: false },
        { id: "c:right", name: "duplicate", position: 1, rawType: "Float64", type: "float", nullable: false }
      ]
    };
    const duplicatePage: GridPage = { ...page, columnIds: ["c:left", "c:right"], rows: [] };
    const summariesById = new Map<string, ColumnSummary>([
      [
        "c:left",
        {
          ...summary,
          columnId: "c:left",
          column: "duplicate",
          type: "integer",
          rawType: "Int64",
          numeric: { min: 1, max: 1 }
        }
      ],
      [
        "c:right",
        {
          ...summary,
          columnId: "c:right",
          column: "duplicate",
          type: "float",
          rawType: "Float64",
          numeric: { min: 10, max: 20 }
        }
      ]
    ]);
    const bridge: OpenWranglerBridge = {
      request: vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
        if (request.kind !== "getSummary") throw new Error(`Unexpected request ${request.kind}`);
        const columnId = request.columnIds?.[0];
        const columnSummary = columnId ? summariesById.get(columnId) : undefined;
        if (!columnSummary) throw new Error("Expected a known duplicate-label summary ID.");
        return {
          kind: "summary",
          revision: duplicateMetadata.revision,
          viewRequestId: request.viewRequestId,
          summaries: [columnSummary]
        };
      }),
      setViewContext: vi.fn()
    };
    const harness = createPanelHarness(bridge, {
      openResponse: { kind: "sessionOpened", metadata: duplicateMetadata, page: duplicatePage, summaries: [] }
    });
    await harness.open();
    await harness.send({ kind: "setViewContext", viewContextId: "duplicate-view" });
    for (const columnId of ["c:right", "c:left"]) {
      await harness.send({
        kind: "runtimeRequest",
        viewContextId: "duplicate-view",
        request: {
          kind: "getSummary",
          viewRequestId: `summary-${columnId}`,
          filterModel: duplicateMetadata.filterModel,
          columnIds: [columnId]
        }
      });
    }
    await harness.send({ kind: "ready" });

    const retained = [...harness.posted]
      .reverse()
      .find((message): message is SessionOpenedResponse => isSessionOpenedResponse(message));
    if (!retained) throw new Error("The panel did not retain duplicate-label profiles.");
    expect(retained.summaries.map((item) => [item.columnId, item.numeric?.min])).toEqual([
      ["c:left", 1],
      ["c:right", 10]
    ]);
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
      columnWidths: new Map([["c:0", 260]]),
      selectedColumnId: "c:0",
      viewport: { firstVisibleRow: 1, scrollLeft: 44 }
    };
    const serializedState = { ...state, columnWidths: [["c:0", 260]] };
    const bridge: OpenWranglerBridge = {
      request: vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
        if (request.kind === "getPage") {
          return {
            kind: "page",
            revision: metadata.revision + 1,
            viewRequestId: request.viewRequestId,
            metadata: { ...metadata, revision: metadata.revision + 1 },
            page
          };
        }
        return openedResponse;
      }),
      getViewState: vi.fn(() => state),
      updateViewState: vi.fn(async () => undefined)
    };
    const harness = createPanelHarness(bridge);
    await harness.open();

    await harness.send({ kind: "ready" });
    expect(harness.posted).toContainEqual({ kind: "viewState", state: serializedState });

    const synchronization = latestRendererSynchronization(harness.posted);
    const staleSyncId = `${synchronization.syncId.startsWith("A") ? "B" : "A"}${synchronization.syncId.slice(1)}`;
    harness.posted.length = 0;
    await harness.send({ kind: "updateViewState", state: serializedState });
    expect(bridge.updateViewState).not.toHaveBeenCalled();
    expect(harness.posted).toContainEqual({ kind: "viewState", state: serializedState });

    await harness.receive({
      kind: "rendererSynchronized",
      syncId: staleSyncId,
      sessionId: synchronization.sessionId,
      revision: synchronization.revision
    });
    await harness.send({ kind: "updateViewState", state: serializedState });
    expect(bridge.updateViewState).not.toHaveBeenCalled();

    await harness.receive({
      kind: "rendererSynchronized",
      syncId: synchronization.syncId,
      sessionId: synchronization.sessionId,
      revision: synchronization.revision
    });
    await harness.send({ kind: "updateViewState", state: serializedState });
    await harness.send({
      kind: "updateViewState",
      state: { ...serializedState, columnWidths: [["c:0", 20]] }
    });
    await harness.send({
      kind: "updateViewState",
      state: { ...state, viewport: { firstVisibleRow: Number.NaN, scrollLeft: 0 } }
    });

    expect(bridge.updateViewState).toHaveBeenCalledOnce();
    expect(bridge.updateViewState).toHaveBeenCalledWith("session", state);

    await harness.send(pageMessage("next-page", "current-view"));
    const stateAfterPageRevision = {
      ...serializedState,
      columnWidths: [["c:0", 261]]
    };
    await harness.send({ kind: "updateViewState", state: stateAfterPageRevision });
    expect(bridge.updateViewState).toHaveBeenCalledTimes(2);
    expect(bridge.updateViewState).toHaveBeenLastCalledWith("session", {
      ...stateAfterPageRevision,
      columnWidths: new Map([["c:0", 261]])
    });
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
      columnWidths: new Map([["c:0", 245]]),
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
        columnWidths: [["c:0", 310]],
        selectedColumnId: "c:0",
        viewport: { firstVisibleRow: 0, scrollLeft: 0 }
      }
    });

    expect(updateViewState).not.toHaveBeenCalled();
    expect(harness.posted.at(-1)).toEqual({
      kind: "viewState",
      state: { ...authoritativeState, columnWidths: [["c:0", 245]] }
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
      inputRowAxis: { kind: "positional", levelNames: [] },
      outputRowAxis: { kind: "positional", levelNames: [] },
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

  it("rejects a valid preview outside the session's advertised operation set", async () => {
    const limitedOpened: SessionOpenedResponse = {
      ...openedResponse,
      metadata: {
        ...openedResponse.metadata,
        capabilities: {
          ...openedResponse.metadata.capabilities,
          supportedOperations: ["renameColumn"]
        }
      }
    };
    const request = vi.fn(async (candidate: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (candidate.kind === "openSession") return limitedOpened;
      throw new Error(`Unexpected request ${candidate.kind}`);
    });
    const harness = createPanelHarness({ request }, { openResponse: limitedOpened });
    await harness.open();
    request.mockClear();

    await harness.send({
      kind: "runtimeRequest",
      request: {
        kind: "previewStep",
        step: { id: "custom", kind: "customCode", params: { code: "result = df" } },
        offset: 0,
        limit: 200,
        columnOffset: 0,
        columnLimit: 16
      }
    });

    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    { backend: "r" as const, code: 'result <- df[df$city == "Berlin", , drop = FALSE]' },
    { backend: "pandas" as const, code: 'result = df.loc[df["city"] == "Berlin"].copy()' }
  ])("blocks every $backend custom-code preview until the workspace is trusted", async ({ backend, code }) => {
    const customStep = { id: `${backend}-custom`, kind: "customCode" as const, params: { code } };
    const backendMetadata: SessionMetadata = {
      ...metadata,
      backend,
      ...(backend === "r" ? { rDataframeFlavor: "r.data.frame" as const } : {}),
      capabilities: { ...metadata.capabilities, supportedOperations: ["customCode"] }
    };
    const opened: SessionOpenedResponse = {
      ...openedResponse,
      metadata: backendMetadata
    };
    const preview: OpenWranglerResponse = {
      kind: "stepPreview",
      revision: 1,
      metadata: { ...backendMetadata, revision: 1, draftStep: customStep },
      page,
      diff: {
        addedRows: 0,
        removedRows: 0,
        addedColumns: [],
        removedColumns: [],
        changedCells: 0,
        cells: [],
        truncated: false
      },
      code: backend === "r" ? "clean_data <- function(df) df\n" : "def clean_data(df):\n    return df\n"
    };
    const request = vi.fn(async (candidate: OpenWranglerRequest): Promise<OpenWranglerResponse> =>
      candidate.kind === "previewStep" ? preview : opened
    );
    const harness = createPanelHarness({ request }, { openResponse: opened, backend });
    await harness.open();
    await harness.receive({ kind: "ready" });
    request.mockClear();
    harness.posted.length = 0;
    const trustDescriptor = Object.getOwnPropertyDescriptor(workspace, "isTrusted");
    const message = {
      kind: "runtimeRequest",
      request: {
        kind: "previewStep",
        step: customStep,
        offset: 0,
        limit: 200,
        columnOffset: 0,
        columnLimit: 16
      }
    } as const;

    try {
      Object.defineProperty(workspace, "isTrusted", { configurable: true, value: false });
      await harness.send(message);
      await harness.send(message);
      await OpenWranglerPanel.previewStepForSessionForTesting({
        ...message.request,
        sessionId: backendMetadata.sessionId,
        revision: backendMetadata.revision
      });

      expect(request).not.toHaveBeenCalled();
      expect(harness.posted).toEqual([
        {
          kind: "error",
          code: "workspace_untrusted",
          message: "Trust this workspace before running custom code.",
          recoverable: true
        },
        {
          kind: "error",
          code: "workspace_untrusted",
          message: "Trust this workspace before running custom code.",
          recoverable: true
        },
        {
          kind: "error",
          code: "workspace_untrusted",
          message: "Trust this workspace before running custom code.",
          recoverable: true
        }
      ]);

      Object.defineProperty(workspace, "isTrusted", { configurable: true, value: true });
      await harness.send(message);

      expect(request).toHaveBeenCalledOnce();
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "previewStep", step: customStep }),
        undefined
      );
    } finally {
      if (trustDescriptor) Object.defineProperty(workspace, "isTrusted", trustDescriptor);
      else delete (workspace as unknown as { isTrusted?: unknown }).isTrusted;
    }
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

  it("automatically hydrates the live renderer after installing a missing dependency", async () => {
    const missing: OpenWranglerResponse = {
      kind: "error",
      code: "missing_dependencies",
      message: "Polars is missing fastexcel>=0.9.",
      recoverable: true
    };
    let openCalls = 0;
    const request = vi.fn(async (candidate: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (candidate.kind === "closeSession") {
        return { kind: "sessionClosed", sessionId: candidate.sessionId };
      }
      if (candidate.kind !== "openSession") throw new Error(`Unexpected request ${candidate.kind}`);
      openCalls += 1;
      return openCalls === 1 ? missing : openedResponse;
    });
    const executeCommand = vi.spyOn(commands, "executeCommand").mockImplementation(async (command) => {
      if (command === "openWrangler.installRuntimeDependencies") return true;
      return undefined;
    });
    const synchronizePanel = vi.spyOn(OpenWranglerPanel, "synchronizePanelForSession");
    const ensurePanelSynchronized = vi.spyOn(OpenWranglerPanel, "ensurePanelSynchronizedForSession");
    const harness = createPanelHarness({ request }, { delegateOpen: true });
    await harness.open();
    await harness.receive({ kind: "ready" });
    const missingSynchronization = await acknowledgeLatestRendererSynchronization(harness);
    expect(missingSynchronization).toMatchObject({ sessionId: null, revision: null });
    harness.posted.length = 0;
    executeCommand.mockClear();

    await harness.receive({ kind: "installRuntimeDependencies" });
    await vi.waitFor(() =>
      expect(latestRendererSynchronization(harness.posted)).toMatchObject({
        sessionId: openedResponse.metadata.sessionId,
        revision: openedResponse.metadata.revision
      })
    );
    const liveSynchronization = latestRendererSynchronization(harness.posted);
    expect(liveSynchronization.syncId).not.toBe(missingSynchronization.syncId);
    await harness.receive({
      kind: "rendererSynchronized",
      syncId: liveSynchronization.syncId,
      sessionId: liveSynchronization.sessionId,
      revision: liveSynchronization.revision
    });

    expect(executeCommand).toHaveBeenCalledWith("openWrangler.installRuntimeDependencies");
    expect(request.mock.calls.map(([candidate]) => candidate.kind)).toEqual(["openSession", "openSession"]);
    expect(harness.posted).toContainEqual({ kind: "runtimeDependencyInstallState", busy: true });
    expect(harness.posted).toContainEqual(openedResponse);
    expect(harness.posted).toContainEqual({ kind: "runtimeDependencyInstallState", busy: false });
    expect(OpenWranglerPanel.panelHydratedForSession(openedResponse.metadata.sessionId)).toBe(true);
    expect(OpenWranglerPanel.panelSynchronizationReceiptForSession(openedResponse.metadata.sessionId)).toEqual({
      syncId: liveSynchronization.syncId,
      sessionId: openedResponse.metadata.sessionId,
      revision: openedResponse.metadata.revision,
      layoutTransitionPending: liveSynchronization.layoutTransitionPending
    });
    expect(synchronizePanel).not.toHaveBeenCalled();
    expect(ensurePanelSynchronized).not.toHaveBeenCalled();
  });

  it("accepts only an exact cleaned-data export intent from the webview", async () => {
    const executeCommand = vi.spyOn(commands, "executeCommand").mockResolvedValue(undefined);
    const harness = createPanelHarness({ request: vi.fn(async () => openedResponse) });
    await harness.open();
    executeCommand.mockClear();

    for (const malformed of [
      { kind: "exportData", unexpected: true },
      { kind: "exportData", format: "csv" },
      { kind: "exportData", path: "/tmp/out.csv" }
    ]) {
      await harness.receive(malformed);
    }
    expect(executeCommand).not.toHaveBeenCalled();

    await harness.receive({ kind: "exportData" });
    expect(executeCommand).toHaveBeenCalledOnce();
    expect(executeCommand).toHaveBeenCalledWith("openWrangler.internal.exportSessionData", "session", 0);
  });

  it("keeps an initial dependency error retryable when installation is declined", async () => {
    const missing: OpenWranglerResponse = {
      kind: "error",
      code: "missing_dependencies",
      message: "Polars is missing fastexcel>=0.9.",
      recoverable: true
    };
    const request = vi.fn(async (): Promise<OpenWranglerResponse> => missing);
    const executeCommand = vi.spyOn(commands, "executeCommand").mockImplementation(async (command) => {
      if (command === "openWrangler.installRuntimeDependencies") return false;
      return undefined;
    });
    const harness = createPanelHarness({ request }, { delegateOpen: true });
    await harness.open();
    harness.posted.length = 0;
    executeCommand.mockClear();

    for (const malformed of [
      { kind: "installRuntimeDependencies", unexpected: true },
      { kind: "installRuntimeDependencies", confirmed: true }
    ]) {
      await harness.receive(malformed);
    }
    expect(executeCommand).not.toHaveBeenCalled();

    await harness.receive({ kind: "installRuntimeDependencies" });

    expect(executeCommand).toHaveBeenCalledWith("openWrangler.installRuntimeDependencies");
    expect(request).toHaveBeenCalledOnce();
    expect(harness.posted).toEqual([
      { kind: "runtimeDependencyInstallState", busy: true },
      { kind: "runtimeDependencyInstallState", busy: false }
    ]);
  });

  it("publishes actionable bounded guidance when the confirmed environment is already inconsistent", async () => {
    const missing: OpenWranglerResponse = {
      kind: "error",
      code: "missing_dependencies",
      message: "Pandas is missing openpyxl>=3.1.5.",
      recoverable: true
    };
    const request = vi.fn(async (): Promise<OpenWranglerResponse> => missing);
    const executable = "/private/selected/environment/bin/python";
    const executeCommand = vi.spyOn(commands, "executeCommand").mockImplementation(async (command) => {
      if (command === "openWrangler.installRuntimeDependencies") {
        throw new DependencyGuardCommandError("install", "environment_inconsistent", executable);
      }
      return undefined;
    });
    const harness = createPanelHarness({ request }, { delegateOpen: true });
    await harness.open();
    harness.posted.length = 0;
    executeCommand.mockClear();

    await harness.receive({ kind: "installRuntimeDependencies" });

    expect(harness.posted).toEqual([
      { kind: "runtimeDependencyInstallState", busy: true },
      {
        kind: "error",
        code: "dependency_install_failed",
        message:
          "The selected environment already has incompatible installed requirements. Repair it before installing Open Wrangler dependencies.",
        recoverable: true
      },
      { kind: "runtimeDependencyInstallState", busy: false }
    ]);
    expect(JSON.stringify(harness.posted)).not.toContain(executable);
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
      columnWidths: new Map([["c:0", 245]]),
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
      { kind: "viewState", state: { ...retainedView, columnWidths: [["c:0", 245]] } },
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

  it("recovers a reconfigured renderer that accepts publication but never acknowledges its new snapshot", async () => {
    vi.useFakeTimers();
    try {
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
      const committed = responseForSource({ ...source, importOptions: nextOptions }, 7);
      const request = vi.fn(async (candidate: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
        if (candidate.kind === "openSession") return initial;
        if (candidate.kind === "closeSession") {
          return { kind: "sessionClosed", sessionId: candidate.sessionId };
        }
        throw new Error(`Unexpected request ${candidate.kind}`);
      });
      const reconfigureFileSession = vi.fn(async (): Promise<OpenWranglerResponse> => committed);
      const harness = createPanelHarness(
        { request, reconfigureFileSession },
        { source, delegateOpen: true, backendPreference: "auto" }
      );

      await harness.open();
      await harness.receive({ kind: "ready" });
      const initialSynchronization = await acknowledgeLatestRendererSynchronization(harness);
      expect(OpenWranglerPanel.panelHydratedForSession(initial.metadata.sessionId)).toBe(true);
      expect(harness.htmlAssignmentCount).toBe(1);
      harness.posted.length = 0;
      configureDelimitedPrompts(nextOptions);

      await harness.receive({ kind: "changeImportOptions" });

      const unacknowledged = latestRendererSynchronization(harness.posted);
      expect(unacknowledged).toMatchObject({
        sessionId: committed.metadata.sessionId,
        revision: committed.metadata.revision
      });
      expect(OpenWranglerPanel.panelHydratedForSession(committed.metadata.sessionId)).toBe(false);
      expect(OpenWranglerPanel.panelSynchronizationReceiptForSession(committed.metadata.sessionId)).toBeUndefined();
      await harness.receive({
        kind: "rendererSynchronized",
        syncId: initialSynchronization.syncId,
        sessionId: initialSynchronization.sessionId,
        revision: initialSynchronization.revision
      });
      expect(OpenWranglerPanel.panelHydratedForSession(committed.metadata.sessionId)).toBe(false);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(harness.htmlAssignmentCount).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(harness.htmlAssignmentCount).toBe(2);
      expect(request.mock.calls.filter(([candidate]) => candidate.kind === "openSession")).toHaveLength(1);
      expect(request.mock.calls.filter(([candidate]) => candidate.kind === "closeSession")).toHaveLength(0);
      expect(reconfigureFileSession).toHaveBeenCalledOnce();
      const publicationsBeforeRecoveredReady = harness.posted.filter(isSessionOpenedResponse).length;
      expect(publicationsBeforeRecoveredReady).toBe(2);

      await harness.receive({ kind: "ready" });
      const recovered = latestRendererSynchronization(harness.posted);
      expect(recovered.syncId).not.toBe(unacknowledged.syncId);
      expect(recovered).toMatchObject({
        sessionId: committed.metadata.sessionId,
        revision: committed.metadata.revision
      });
      expect(harness.posted.filter(isSessionOpenedResponse)).toHaveLength(publicationsBeforeRecoveredReady + 1);
      expect(harness.posted.filter(isSessionOpenedResponse).at(-1)).toEqual(committed);
      await harness.receive({
        kind: "rendererSynchronized",
        syncId: recovered.syncId,
        sessionId: recovered.sessionId,
        revision: recovered.revision
      });
      await vi.advanceTimersByTimeAsync(20_000);

      expect(OpenWranglerPanel.panelHydratedForSession(committed.metadata.sessionId)).toBe(true);
      expect(OpenWranglerPanel.panelSynchronizationReceiptForSession(committed.metadata.sessionId)).toEqual({
        syncId: recovered.syncId,
        sessionId: recovered.sessionId,
        revision: recovered.revision,
        layoutTransitionPending: recovered.layoutTransitionPending
      });
      expect(harness.htmlAssignmentCount).toBe(2);
      expect(request.mock.calls.filter(([candidate]) => candidate.kind === "openSession")).toHaveLength(1);
      expect(request.mock.calls.filter(([candidate]) => candidate.kind === "closeSession")).toHaveLength(0);
      expect(reconfigureFileSession).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses live workbook sheet names for Excel reconfiguration without asking users to type one", async () => {
    const source: SessionSource = {
      kind: "file",
      label: "workbook.xlsx",
      path: "/workspace/workbook.xlsx",
      uri: "file:///workspace/workbook.xlsx",
      importOptions: { sheetIndex: 0 }
    };
    const initial = responseForSource(source);
    const listExcelSheets = vi.fn(async () => ["Overview", "Sales", "2024"]);
    const reconfigureFileSession = vi.fn(
      async (_sessionId: string, _revision: number, nextSource: SessionSource): Promise<OpenWranglerResponse> =>
        responseForSource(nextSource, 1)
    );
    const harness = createPanelHarness(
      {
        request: vi.fn(async () => initial),
        listExcelSheets,
        reconfigureFileSession
      },
      { source, openResponse: initial }
    );
    await harness.open();
    harness.posted.length = 0;
    panelPromptMocks.showQuickPick.mockImplementationOnce(async (items) =>
      (items as PromptPick[]).find(({ value }) => value === "Sales")
    );

    await harness.receive({ kind: "changeImportOptions" });

    expect(listExcelSheets).toHaveBeenCalledWith("session", source, "polars", {
      cancellation: expect.objectContaining({
        isCancellationRequested: false,
        onCancellationRequested: expect.any(Function)
      })
    });
    expect(promptPicksAt(0).map(({ label }) => label)).toEqual(["Overview", "Sales", "2024"]);
    expect(panelPromptMocks.showInputBox).not.toHaveBeenCalled();
    expect(reconfigureFileSession).toHaveBeenCalledWith(
      "session",
      0,
      { ...source, importOptions: { sheetName: "Sales" } },
      {
        cancellation: expect.objectContaining({
          isCancellationRequested: false,
          onCancellationRequested: expect.any(Function)
        })
      }
    );
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

  it("adopts a confirmed open before persisting it so an immediate import command reconfigures the same session", async () => {
    const source: SessionSource = {
      kind: "file",
      label: "sample.csv",
      path: "/workspace/sample.csv",
      uri: "file:///workspace/sample.csv",
      importOptions: {
        delimiter: ",",
        encoding: "utf-8",
        quoteChar: '"',
        hasHeader: true
      }
    };
    const configuredSource: SessionSource = {
      ...source,
      importOptions: {
        delimiter: ";",
        encoding: "utf-8",
        quoteChar: '"',
        hasHeader: true
      }
    };
    const initial = responseForSource(source);
    const configured = responseForSource(configuredSource, 1);
    const persistenceStarted = deferred<void>();
    const releasePersistence = deferred<void>();
    const workspaceState = createWorkspaceMemento();
    workspaceState.update.mockImplementationOnce(async (key: string, value: unknown): Promise<void> => {
      persistenceStarted.resolve(undefined);
      await releasePersistence.promise;
      workspaceState.values.set(key, value);
    });
    const request = vi.fn(async (candidate: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (candidate.kind === "openSession") return initial;
      if (candidate.kind === "closeSession") return { kind: "sessionClosed", sessionId: candidate.sessionId };
      throw new Error(`Unexpected request ${candidate.kind}`);
    });
    const reconfigureFileSession = vi.fn(async (): Promise<OpenWranglerResponse> => configured);
    const setActiveSession = vi.fn();
    const harness = createPanelHarness(
      { request, reconfigureFileSession, setActiveSession },
      { source, delegateOpen: true, workspaceState }
    );
    configureDelimitedPrompts({
      delimiter: ";",
      encoding: "utf-8",
      quoteChar: '"',
      hasHeader: true
    });

    const opening = harness.open();
    await persistenceStarted.promise;
    expect(setActiveSession).toHaveBeenLastCalledWith(initial.metadata.sessionId);
    expect(request.mock.calls.filter(([candidate]) => candidate.kind === "openSession")).toHaveLength(1);
    expect(request.mock.calls.filter(([candidate]) => candidate.kind === "closeSession")).toHaveLength(0);
    const changing = OpenWranglerPanel.changeActiveImportOptions();
    await Promise.resolve();
    expect(reconfigureFileSession).not.toHaveBeenCalled();
    expect(request.mock.calls.filter(([candidate]) => candidate.kind === "closeSession")).toHaveLength(0);
    releasePersistence.resolve(undefined);
    await expect(Promise.all([opening, changing])).resolves.toEqual([undefined, true]);

    expect(request.mock.calls.filter(([candidate]) => candidate.kind === "openSession")).toHaveLength(1);
    expect(request.mock.calls.filter(([candidate]) => candidate.kind === "closeSession")).toHaveLength(0);
    expect(reconfigureFileSession).toHaveBeenCalledOnce();
    expect(reconfigureFileSession).toHaveBeenCalledWith(
      initial.metadata.sessionId,
      initial.metadata.revision,
      configuredSource,
      {
        cancellation: expect.objectContaining({
          isCancellationRequested: false,
          onCancellationRequested: expect.any(Function)
        })
      }
    );
    expect(setActiveSession).toHaveBeenLastCalledWith(initial.metadata.sessionId);
    expect(workspaceState.update).toHaveBeenCalledTimes(2);
    expect(harness.posted.filter(isSessionOpenedResponse)).toEqual([initial, configured]);
    expect(workspaceState.values.get(CONFIRMED_FILE_CONFIGURATIONS_STORAGE_KEY)).toEqual({
      version: 2,
      entries: [
        {
          uri: source.uri,
          backend: "polars",
          backendPreference: "polars",
          importOptions: configuredSource.importOptions
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
    let initialOpenCancellation: BridgeRequestOptions["cancellation"];
    let opens = 0;
    const request = vi.fn(
      async (candidate: OpenWranglerRequest, options?: BridgeRequestOptions): Promise<OpenWranglerResponse> => {
        if (candidate.kind === "openSession") {
          opens += 1;
          if (opens === 1) initialOpenCancellation = options?.cancellation;
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
    await vi.waitFor(() => expect(initialOpenCancellation?.isCancellationRequested).toBe(true));
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

  it("observes activation that occurs while an immediately opening panel dispatches its session", async () => {
    const setActiveSession = vi.fn();
    const request = vi.fn(async (candidate: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (candidate.kind === "openSession") return openedResponse;
      if (candidate.kind === "closeSession") return { kind: "sessionClosed", sessionId: candidate.sessionId };
      throw new Error(`Unexpected request ${candidate.kind}`);
    });

    createPanelHarness(
      { request, setActiveSession },
      {
        createViaFactory: true,
        delegateOpen: true,
        active: false,
        activateDuringOpenRequest: true
      }
    );

    await vi.waitFor(() => expect(setActiveSession).toHaveBeenLastCalledWith("session"));
  });

  it("forces a Variables-view PySpark session into viewing mode", async () => {
    const source: SessionSource = {
      kind: "notebookVariable",
      label: "spark_frame",
      variableName: "spark_frame",
      uri: "file:///workspace/example.ipynb"
    };
    const request = vi.fn(async (candidate: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (candidate.kind === "openSession") {
        return {
          ...openedResponse,
          metadata: {
            ...metadata,
            backend: "pyspark",
            mode: "viewing",
            source,
            capabilities: {
              editable: false,
              lazy: true,
              cancel: false,
              exportCsv: false,
              exportParquet: false,
              notebookInsert: false
            }
          }
        };
      }
      throw new Error(`Unexpected request ${candidate.kind}`);
    });

    createPanelHarness(
      { request },
      { createViaFactory: true, delegateOpen: true, source, backend: "pyspark", backendPreference: "pyspark" }
    );

    await vi.waitFor(() =>
      expect(request.mock.calls.find(([candidate]) => candidate.kind === "openSession")?.[0]).toMatchObject({
        backend: "pyspark",
        mode: "viewing"
      })
    );
  });

  it("uses the default viewing mode for R notebooks and caps the initial page to 100,000 cells", async () => {
    vi.spyOn(workspace, "getConfiguration").mockImplementation(
      () =>
        ({
          get: (key: string, fallback?: unknown): unknown => {
            if (key === "fetchBlockSize") return 2_000;
            if (key === "fetchColumnBlockSize") return 256;
            return fallback;
          }
        }) as vscode.WorkspaceConfiguration
    );
    const source: SessionSource = {
      kind: "notebookVariable",
      label: "r_frame",
      variableName: "r_frame",
      uri: "file:///workspace/example.ipynb"
    };
    const request = vi.fn(async (candidate: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (candidate.kind === "openSession") {
        return {
          ...openedResponse,
          metadata: {
            ...metadata,
            backend: "r",
            rDataframeFlavor: "r.data.frame",
            mode: "viewing",
            source,
            capabilities: {
              editable: false,
              lazy: false,
              cancel: false,
              exportCsv: false,
              exportParquet: false,
              notebookInsert: false
            }
          }
        };
      }
      throw new Error(`Unexpected request ${candidate.kind}`);
    });

    createPanelHarness(
      { request },
      { createViaFactory: true, delegateOpen: true, source, backend: "r", backendPreference: "r" }
    );

    await vi.waitFor(() => {
      const openRequest = request.mock.calls.find(([candidate]) => candidate.kind === "openSession")?.[0];
      expect(openRequest).toMatchObject({
        backend: "r",
        mode: "viewing",
        pageSize: 390,
        columnOffset: 0,
        columnLimit: 256
      });
      if (!openRequest || openRequest.kind !== "openSession") throw new Error("Expected an open-session request.");
      expect(openRequest.pageSize * openRequest.columnLimit).toBeLessThanOrEqual(100_000);
    });
  });

  it("routes the visible notebook Editing action through the exact session-bound reconfiguration", async () => {
    const source: SessionSource = {
      kind: "notebookVariable",
      label: "r_frame",
      variableName: "r_frame",
      uri: "file:///workspace/example.ipynb"
    };
    const viewing: SessionOpenedResponse = {
      ...openedResponse,
      metadata: {
        ...metadata,
        backend: "r",
        rDataframeFlavor: "r.data.frame",
        mode: "viewing",
        source,
        capabilities: {
          editable: true,
          lazy: false,
          cancel: false,
          exportCsv: false,
          exportParquet: false,
          notebookInsert: true,
          supportedOperations: ["sortRows"]
        }
      }
    };
    const editing: SessionOpenedResponse = {
      ...viewing,
      metadata: {
        ...viewing.metadata,
        revision: 1,
        mode: "editing",
        capabilities: { ...viewing.metadata.capabilities, exportCsv: true }
      }
    };
    const viewingAgain: SessionOpenedResponse = {
      ...viewing,
      metadata: { ...viewing.metadata, revision: 2 }
    };
    const request = vi.fn(async (candidate: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (candidate.kind === "openSession") return viewing;
      throw new Error(`Unexpected request ${candidate.kind}`);
    });
    const reconfigureLiveSessionMode = vi.fn(
      async (_sessionId: string, _revision: number, mode: SessionMetadata["mode"]): Promise<OpenWranglerResponse> =>
        mode === "editing" ? editing : viewingAgain
    );
    const harness = createPanelHarness(
      { request, reconfigureLiveSessionMode },
      { createViaFactory: true, delegateOpen: true, source, backend: "r", backendPreference: "r" }
    );
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(harness.posted).toContainEqual(viewing));
    harness.posted.length = 0;

    const currentViewState = {
      selectedColumnId: "c:0",
      columnWidths: [["c:0", 240]],
      viewport: { firstVisibleRow: 1, scrollLeft: 73 }
    };
    const decodedCurrentViewState = {
      ...currentViewState,
      columnWidths: new Map([["c:0", 240]])
    };
    await harness.receive({ kind: "switchSessionMode", mode: "editing", state: currentViewState });

    expect(reconfigureLiveSessionMode).toHaveBeenCalledWith("session", 0, "editing", decodedCurrentViewState, {
      priority: "interactive",
      backendPreference: "r"
    });
    expect(harness.posted).toEqual([
      { kind: "sessionModeChangeState", busy: true, mode: "editing" },
      editing,
      { kind: "sessionModeChangeState", busy: false, mode: "editing" }
    ]);

    await harness.receive({ kind: "switchSessionMode", state: currentViewState });
    await harness.receive({ kind: "switchSessionMode", mode: "unsupported", state: currentViewState });
    await harness.receive({ kind: "switchSessionMode", mode: "editing", state: currentViewState, extra: true });
    expect(reconfigureLiveSessionMode).toHaveBeenCalledOnce();

    harness.posted.length = 0;
    await harness.receive({ kind: "switchSessionMode", mode: "viewing", state: currentViewState });
    expect(reconfigureLiveSessionMode).toHaveBeenLastCalledWith("session", 1, "viewing", decodedCurrentViewState, {
      priority: "interactive",
      backendPreference: "r"
    });
    expect(harness.posted).toEqual([
      { kind: "sessionModeChangeState", busy: true, mode: "viewing" },
      viewingAgain,
      { kind: "sessionModeChangeState", busy: false, mode: "viewing" }
    ]);
  });

  it("rejects a forged switch to Viewing while the confirmed cleaning plan is non-empty", async () => {
    const source: SessionSource = {
      kind: "notebookVariable",
      label: "r_frame",
      variableName: "r_frame",
      uri: "file:///workspace/example.ipynb"
    };
    const editing: SessionOpenedResponse = {
      ...openedResponse,
      metadata: {
        ...metadata,
        backend: "r",
        rDataframeFlavor: "r.data.frame",
        mode: "editing",
        source,
        capabilities: {
          ...metadata.capabilities,
          notebookInsert: true,
          supportedOperations: ["lowerText"]
        },
        steps: [
          {
            id: "lower-city",
            kind: "lowerText",
            params: { column: { id: "c:0", name: "city" } }
          }
        ],
        latestStepInputSchema: metadata.schema
      }
    };
    const reconfigureLiveSessionMode = vi.fn();
    const harness = createPanelHarness(
      { request: vi.fn(async () => editing), reconfigureLiveSessionMode },
      { createViaFactory: true, delegateOpen: true, source, backend: "r", backendPreference: "r" }
    );
    await vi.waitFor(() => expect(harness.posted).toContainEqual(editing));
    harness.posted.length = 0;

    await harness.receive({
      kind: "switchSessionMode",
      mode: "viewing",
      state: { columnWidths: [], viewport: { firstVisibleRow: 0, scrollLeft: 0 } }
    });

    expect(reconfigureLiveSessionMode).not.toHaveBeenCalled();
    expect(harness.posted).toEqual([
      expect.objectContaining({
        kind: "error",
        code: "viewing_mode_unavailable",
        message: "Undo the applied step before switching to Viewing.",
        recoverable: true,
        sessionId: "session"
      })
    ]);
  });

  it("offers the same Editing transition for an active R-session dataframe", async () => {
    const source: SessionSource = {
      kind: "rInteractiveVariable",
      label: "r_frame",
      variableName: "r_frame"
    };
    const viewing: SessionOpenedResponse = {
      ...openedResponse,
      metadata: {
        ...metadata,
        backend: "r",
        rDataframeFlavor: "r.tibble",
        mode: "viewing",
        source,
        capabilities: {
          editable: true,
          lazy: false,
          cancel: false,
          exportCsv: false,
          exportParquet: false,
          notebookInsert: false,
          documentInsert: false,
          supportedOperations: ["sortRows"]
        }
      }
    };
    const editing: SessionOpenedResponse = {
      ...viewing,
      metadata: {
        ...viewing.metadata,
        revision: 1,
        mode: "editing",
        capabilities: { ...viewing.metadata.capabilities, exportCsv: true }
      }
    };
    const request = vi.fn(async (candidate: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (candidate.kind === "openSession") return viewing;
      throw new Error(`Unexpected request ${candidate.kind}`);
    });
    const reconfigureLiveSessionMode = vi.fn(async (): Promise<OpenWranglerResponse> => editing);
    const harness = createPanelHarness(
      { request, reconfigureLiveSessionMode },
      { createViaFactory: true, delegateOpen: true, source, backend: "r", backendPreference: "r" }
    );
    await vi.waitFor(() => expect(harness.posted).toContainEqual(viewing));
    harness.posted.length = 0;

    await harness.receive({
      kind: "switchSessionMode",
      mode: "editing",
      state: { columnWidths: [], viewport: { firstVisibleRow: 0, scrollLeft: 0 } }
    });

    expect(reconfigureLiveSessionMode).toHaveBeenCalledOnce();
    expect(harness.posted).toEqual([
      { kind: "sessionModeChangeState", busy: true, mode: "editing" },
      editing,
      { kind: "sessionModeChangeState", busy: false, mode: "editing" }
    ]);
  });

  it("honors an explicit editing-mode preference for an R notebook variable", async () => {
    vi.spyOn(workspace, "getConfiguration").mockImplementation(
      () =>
        ({
          get: (key: string, fallback?: unknown): unknown => (key === "notebookStartMode" ? "editing" : fallback)
        }) as vscode.WorkspaceConfiguration
    );
    const source: SessionSource = {
      kind: "notebookVariable",
      label: "r_frame",
      variableName: "r_frame",
      uri: "file:///workspace/example.ipynb"
    };
    const request = vi.fn(async (candidate: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (candidate.kind === "openSession") {
        return {
          ...openedResponse,
          metadata: {
            ...metadata,
            backend: "r",
            rDataframeFlavor: "r.data.frame",
            mode: "editing",
            source
          }
        };
      }
      throw new Error(`Unexpected request ${candidate.kind}`);
    });

    createPanelHarness(
      { request },
      { createViaFactory: true, delegateOpen: true, source, backend: "r", backendPreference: "r" }
    );

    await vi.waitFor(() =>
      expect(request.mock.calls.find(([candidate]) => candidate.kind === "openSession")?.[0]).toMatchObject({
        backend: "r",
        mode: "editing"
      })
    );
  });

  it("opens a plain R document with the file editing-mode preference", async () => {
    const source: SessionSource = {
      kind: "documentVariable",
      label: "r_frame",
      variableName: "r_frame",
      uri: "file:///workspace/example.R"
    };
    const request = vi.fn(async (candidate: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (candidate.kind === "openSession") {
        return {
          ...openedResponse,
          metadata: {
            ...metadata,
            backend: "r",
            rDataframeFlavor: "r.data.frame",
            mode: "editing",
            source
          }
        };
      }
      throw new Error(`Unexpected request ${candidate.kind}`);
    });

    createPanelHarness(
      { request },
      { createViaFactory: true, delegateOpen: true, source, backend: "r", backendPreference: "r" }
    );

    await vi.waitFor(() =>
      expect(request.mock.calls.find(([candidate]) => candidate.kind === "openSession")?.[0]).toMatchObject({
        backend: "r",
        mode: "editing"
      })
    );
  });

  it("routes the PySpark Reconnect action through the host-only live-session recovery", async () => {
    const source: SessionSource = {
      kind: "notebookVariable",
      label: "spark_frame",
      variableName: "spark_frame",
      uri: "file:///workspace/example.ipynb"
    };
    const pysparkOpened: SessionOpenedResponse = {
      ...openedResponse,
      metadata: {
        ...metadata,
        backend: "pyspark",
        mode: "viewing",
        source,
        capabilities: {
          editable: false,
          lazy: false,
          cancel: false,
          exportCsv: false,
          exportParquet: false,
          notebookInsert: false
        }
      }
    };
    const request = vi.fn(async (candidate: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (candidate.kind === "openSession") return pysparkOpened;
      if (candidate.kind === "closeSession") return { kind: "sessionClosed", sessionId: candidate.sessionId };
      throw new Error(`Unexpected reconnect panel request ${candidate.kind}`);
    });
    const reconnectLiveSession = vi.fn(async (): Promise<OpenWranglerResponse> => pysparkOpened);
    const getViewState = vi.fn(() => ({
      selectedColumnId: "c:0",
      columnWidths: new Map([["c:0", 240]]),
      viewport: { firstVisibleRow: 0, scrollLeft: 30 }
    }));
    const getSessionPresentation = vi.fn(() => ({
      sessionId: "session",
      revision: 0,
      code: ""
    }));
    const harness = createPanelHarness(
      { request, reconnectLiveSession, getViewState, getSessionPresentation },
      { source, backend: "pyspark", backendPreference: "pyspark", delegateOpen: true }
    );
    await harness.open();
    harness.posted.length = 0;

    await harness.receive({ kind: "reconnectLiveSource" });

    expect(reconnectLiveSession).toHaveBeenCalledWith("session", 0, { priority: "interactive" });
    expect(harness.posted).toContainEqual(pysparkOpened);
    expect(harness.posted).toContainEqual({
      kind: "sessionPresentation",
      presentation: { sessionId: "session", revision: 0, code: "" }
    });
    expect(harness.posted).toContainEqual({
      kind: "viewState",
      state: { ...getViewState.mock.results[0]?.value, columnWidths: [["c:0", 240]] }
    });
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
  layoutTransitionPending: boolean;
}

interface RendererImportRequest {
  kind: "requestImportOptionsChange";
  actionId: string;
}

interface SessionOpenProgressMessage {
  kind: "sessionOpenProgress";
  stage: "acquiringKernel" | "bootstrappingRuntime" | "openingNotebookVariable" | "preparingSparkView" | null;
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
    (typeof candidate.revision === "number" || candidate.revision === null) &&
    typeof candidate.layoutTransitionPending === "boolean"
  );
}

function isRendererImportRequest(message: unknown): message is RendererImportRequest {
  if (!message || typeof message !== "object") return false;
  const candidate = message as Partial<RendererImportRequest>;
  return candidate.kind === "requestImportOptionsChange" && typeof candidate.actionId === "string";
}

function isSessionOpenProgressMessage(message: unknown): message is SessionOpenProgressMessage {
  if (!message || typeof message !== "object") return false;
  return (message as Partial<SessionOpenProgressMessage>).kind === "sessionOpenProgress";
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
    activateDuringOpenRequest?: boolean;
    workspaceState?: Pick<vscode.Memento, "get" | "update">;
    backend?: DataBackend | null;
    backendPreference?: DataBackend | "auto";
    postMessage?: (message: unknown) => Promise<boolean>;
  }
): {
  posted: unknown[];
  readonly html: string;
  readonly htmlAssignmentCount: number;
  readonly iconPath: vscode.WebviewPanel["iconPath"];
  open(): Promise<void>;
  receive(message: unknown): Promise<void>;
  send(message: unknown): Promise<void>;
  reveal: ReturnType<typeof vi.fn>;
  activate(): void;
  deactivate(): void;
  hide(): void;
  dispose(): void;
} {
  let listener: ((message: unknown) => Promise<void>) | undefined;
  let disposeListener: (() => void) | undefined;
  let viewStateListener: ((event: { webviewPanel: { active: boolean; visible: boolean } }) => void) | undefined;
  const posted: unknown[] = [];
  let html = "";
  let htmlAssignmentCount = 0;
  const webview = {
    options: {},
    get html() {
      return html;
    },
    set html(value: string) {
      html = value;
      htmlAssignmentCount += 1;
    },
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
  const reveal = vi.fn();
  const panel = {
    webview,
    active: options?.active ?? true,
    visible: true,
    viewColumn: 1,
    iconPath: undefined as vscode.WebviewPanel["iconPath"],
    reveal,
    dispose: () => disposeListener?.(),
    onDidDispose: (listener: () => void) => {
      disposeListener = listener;
      return { dispose: () => undefined };
    },
    onDidChangeViewState: (next: (event: { webviewPanel: { active: boolean; visible: boolean } }) => void) => {
      viewStateListener = next;
      return { dispose: () => undefined };
    }
  };
  const context = {
    extensionPath: "/extension",
    extensionUri: Uri.file("/extension"),
    workspaceState: options?.workspaceState
  };
  const delegatedRequest: OpenWranglerBridge["request"] = options?.delegateOpen
    ? (request, requestOptions) => bridge.request(request, requestOptions)
    : (request, requestOptions) => {
        if (request.kind === "openSession") return Promise.resolve(options?.openResponse ?? openedResponse);
        if (request.kind === "closeSession") {
          return Promise.resolve({ kind: "sessionClosed", sessionId: request.sessionId });
        }
        return bridge.request(request, requestOptions);
      };
  const panelBridge: OpenWranglerBridge = {
    ...bridge,
    request: (request, requestOptions) => {
      if (request.kind === "openSession" && options?.activateDuringOpenRequest) {
        panel.active = true;
        viewStateListener?.({ webviewPanel: panel });
      }
      return delegatedRequest(request, requestOptions);
    }
  };
  const source = options?.source ?? metadata.source;
  const backend = options?.backend === null ? undefined : (options?.backend ?? metadata.backend);
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
    get htmlAssignmentCount() {
      return htmlAssignmentCount;
    },
    get iconPath() {
      return panel.iconPath;
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
    reveal,
    activate() {
      panel.active = true;
      panel.visible = true;
      viewStateListener?.({ webviewPanel: panel });
    },
    deactivate() {
      panel.active = false;
      viewStateListener?.({ webviewPanel: panel });
    },
    hide() {
      panel.active = false;
      panel.visible = false;
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
