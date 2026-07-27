import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  createReadStream,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import * as vscode from "vscode";
import { chromium, type Browser, type Frame, type Locator, type Page } from "playwright-core";
import type { BridgeRequestOptions } from "../../extension/dataBridge";
import type { OpenWranglerRequest, OpenWranglerResponse, SessionMetadata } from "../../shared/protocol";
import { ACCEPTANCE_PROGRESS_PROTOCOL, writeAcceptanceProgressCheckpoint } from "./progress";

const PHASE_PROTOCOL = "openwrangler-installed-performance-phase-v1";
const FIXTURE_PROTOCOL = "openwrangler-installed-performance-fixtures-v1";
const FIRST_GRID_BOUNDARY =
  "vscode.openWith dispatch to a visible production grid block with exact shape and aria-busy=false";
const SAMPLE_COUNT = 10;
const GRID_DISCOVERY_TIMEOUT_MS = 60_000;
const SESSION_CLOSE_TIMEOUT_MS = 15_000;
const FIRST_GRID_PHASE_PATTERN = /^perf-(csv|parquet)-(cold|warm)$/u;
const GRID_INTERACTION_PHASE = "perf-grid-interaction";
const SHA256 = /^[0-9a-f]{64}$/u;

interface TestApi {
  activeSession(): { sessionId: string; metadata: SessionMetadata } | undefined;
  request(request: OpenWranglerRequest, options?: BridgeRequestOptions): Promise<OpenWranglerResponse>;
  cancelViewRequests(sessionId: string, viewRequestIds: readonly string[]): void;
  diagnostics(): { sessionCount: number };
  runtimeRunning(): boolean;
  synchronizePanel(sessionId: string): Promise<boolean>;
}

interface ExtensionApi {
  testing?: TestApi;
}

interface FixtureEntry {
  fileName: string;
  format: "csv" | "parquet";
  rows: number;
  columns: number;
  sha256: string;
}

interface FixtureManifest {
  protocol: string;
  smoke: boolean;
  fixtures: { csv: FixtureEntry; parquet: FixtureEntry };
}

interface RuntimeProbe {
  pythonVersion: string;
  pythonImplementation: string;
  polarsVersion: string;
}

interface CacheControl {
  supported: boolean;
  applied: boolean;
  method: string;
}

export async function run(): Promise<void> {
  const phase = requiredEnvironment("OPEN_WRANGLER_TEST_PHASE");
  const firstGridMatch = FIRST_GRID_PHASE_PATTERN.exec(phase);
  assert.ok(
    firstGridMatch || phase === GRID_INTERACTION_PHASE,
    "The installed performance phase must identify a first-grid cache case or the grid-interaction case."
  );
  const format = firstGridMatch ? (firstGridMatch[1] as "csv" | "parquet") : "parquet";
  const sourceCache = firstGridMatch ? (firstGridMatch[2] as "cold" | "warm") : undefined;
  const runId = requiredEnvironment("OPEN_WRANGLER_TEST_RUN_ID");
  const testPython = requiredEnvironment("OPEN_WRANGLER_TEST_PYTHON");
  const workspace = soleFileWorkspace();
  const manifest = readFixtureManifest(path.join(workspace, "performance-fixtures.json"));
  const fixture = manifest.fixtures[format];
  assert.equal(fixture.format, format);
  const source = path.join(workspace, "fixtures", fixture.fileName);
  assert.equal(await sha256(source), fixture.sha256, "The timed fixture must match its generated manifest.");

  recordProgress("activation:start");
  const extension = vscode.extensions.getExtension<ExtensionApi>("matt17br.openwrangler");
  assert.ok(extension, "The installed Open Wrangler candidate must be discoverable.");
  const api = await extension.activate();
  const testing = api?.testing;
  assert.ok(testing, "The isolated performance phase requires the environment-gated test API.");
  await configureBenchmarkProfile(testPython);
  const runtime = await runtimeProvenance(testPython, String(extension.packageJSON.version));
  const editor = {
    key: editorKey(),
    appName: vscode.env.appName,
    productVersion: requiredEnvironment("OPEN_WRANGLER_TEST_EDITOR_PRODUCT_VERSION"),
    vscodeApiVersion: vscode.version
  };
  recordProgress("activation:complete");

  const sourceUri = vscode.Uri.file(source);
  let measurement: Record<string, unknown> | undefined;
  try {
    const workbench = await connectToEditorWorkbench();
    await waitForWorkbenchReady(workbench);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
    measurement = firstGridMatch
      ? await measureFirstUsableGrid({
          testing,
          workbench,
          testPython,
          workspace,
          source,
          sourceUri,
          fixture,
          sourceCache: sourceCache as "cold" | "warm"
        })
      : await measureGridInteraction({ testing, workbench, sourceUri, fixture });
  } finally {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await waitFor(
      () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
      SESSION_CLOSE_TIMEOUT_MS,
      "terminal installed-performance cleanup"
    );
  }

  assert.ok(measurement, "The installed performance phase must publish one completed measurement.");
  const fragment = {
    protocol: PHASE_PROTOCOL,
    runId,
    phase,
    editor,
    runtime,
    fixture: {
      format,
      rows: fixture.rows,
      columns: fixture.columns,
      sha256: fixture.sha256
    },
    measurement
  };
  publishFragment(path.join(workspace, "results", `${phase}.json`), fragment);
  recordProgress("fragment:published");
}

async function measureFirstUsableGrid({
  testing,
  workbench,
  testPython,
  workspace,
  source,
  sourceUri,
  fixture,
  sourceCache
}: {
  testing: TestApi;
  workbench: Page;
  testPython: string;
  workspace: string;
  source: string;
  sourceUri: vscode.Uri;
  fixture: FixtureEntry;
  sourceCache: "cold" | "warm";
}): Promise<Record<string, unknown>> {
  const warmup = vscode.Uri.file(path.join(workspace, "warmup.csv"));
  const samplesMs: number[] = [];
  let cacheControl: CacheControl | undefined;

  recordProgress("warmup:open");
  await vscode.commands.executeCommand("vscode.openWith", warmup, "openWrangler.viewer", vscode.ViewColumn.One);
  const warmupSession = await waitForHostSession(
    testing,
    (metadata) => metadata.source.kind === "file" && metadata.source.path === warmup.fsPath,
    GRID_DISCOVERY_TIMEOUT_MS,
    "the runtime warm-up session"
  );
  recordProgress("warmup:host-session");
  await waitForPanelSynchronization(testing, warmupSession.sessionId);
  recordProgress("warmup:renderer-synchronized");
  await waitForUsableGrid(workbench, { rows: 2, columns: 2 });
  recordProgress("warmup:complete");

  for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
    recordProgress(`sample-${sample + 1}:cache`);
    const prepared = prepareSourceCache(testPython, workspace, source, sourceCache);
    if (cacheControl === undefined) cacheControl = prepared;
    else assert.deepEqual(prepared, cacheControl, "Source-cache preparation must remain stable across samples.");

    const started = performance.now();
    await vscode.commands.executeCommand("vscode.openWith", sourceUri, "openWrangler.viewer", vscode.ViewColumn.One);
    await waitForHostSession(
      testing,
      (metadata) =>
        metadata.source.kind === "file" &&
        metadata.source.path === sourceUri.fsPath &&
        metadata.backend === "polars" &&
        metadata.shape.rows === fixture.rows &&
        metadata.shape.columns === fixture.columns,
      GRID_DISCOVERY_TIMEOUT_MS,
      `sample ${sample + 1} host session`
    );
    await waitForUsableGrid(workbench, { rows: fixture.rows, columns: fixture.columns });
    samplesMs.push(roundMilliseconds(performance.now() - started));
    recordProgress(`sample-${sample + 1}:visible`);

    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    await waitFor(
      () => testing.diagnostics().sessionCount === 1,
      SESSION_CLOSE_TIMEOUT_MS,
      `sample ${sample + 1} session cleanup`
    );
  }

  assert.equal(samplesMs.length, SAMPLE_COUNT);
  assert.ok(cacheControl, "The first-grid phase must apply source-cache preparation.");
  return {
    kind: "first-grid",
    boundary: FIRST_GRID_BOUNDARY,
    sourceCache,
    cacheControl,
    samplesMs
  };
}

async function measureGridInteraction({
  testing,
  workbench,
  sourceUri,
  fixture
}: {
  testing: TestApi;
  workbench: Page;
  sourceUri: vscode.Uri;
  fixture: FixtureEntry;
}): Promise<Record<string, unknown>> {
  recordProgress("interaction:open");
  await vscode.commands.executeCommand("vscode.openWith", sourceUri, "openWrangler.viewer", vscode.ViewColumn.One);
  const session = await waitForHostSession(
    testing,
    (metadata) =>
      metadata.source.kind === "file" &&
      metadata.source.path === sourceUri.fsPath &&
      metadata.backend === "polars" &&
      metadata.shape.rows === fixture.rows &&
      metadata.shape.columns === fixture.columns,
    GRID_DISCOVERY_TIMEOUT_MS,
    "the grid-interaction host session"
  );
  await waitForPanelSynchronization(testing, session.sessionId);
  const frame = await waitForUsableGrid(workbench, { rows: fixture.rows, columns: fixture.columns });
  recordProgress("interaction:usable-grid");

  const cachedRows = [0, 400];
  for (const row of cachedRows) {
    await scrollGridToRow(frame, row, fixture.rows, fixture.columns, row);
  }
  const cachedSamplesMs: number[] = [];
  for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
    const row = cachedRows[(sample + 1) % cachedRows.length];
    cachedSamplesMs.push(await scrollGridToRow(frame, row, fixture.rows, fixture.columns, row));
    recordProgress(`interaction:cached-${sample + 1}`);
  }

  const uncachedRows = Array.from({ length: SAMPLE_COUNT }, (_, index) => 800 + index * 400);
  assert.ok(
    uncachedRows.every((row) => row < fixture.rows),
    "The interaction fixture must contain every deterministic uncached target block."
  );
  const uncachedSamplesMs: number[] = [];
  const heartbeatSamplesMs: number[] = [];
  for (const [index, row] of uncachedRows.entries()) {
    uncachedSamplesMs.push(await scrollGridToRow(frame, row, fixture.rows, fixture.columns, row));
    heartbeatSamplesMs.push(await measureRendererHeartbeat(frame));
    recordProgress(`interaction:uncached-${index + 1}`);
  }

  await scrollGridToRow(frame, 0, fixture.rows, fixture.columns, 0);
  const filterStarted = performance.now();
  await openColumnAction(frame, "c00", "Filter…");
  const operator = frame.getByLabel("Predicate operator");
  await operator.selectOption("gte");
  await frame.getByLabel("gte predicate value").fill(String(Math.floor(fixture.rows / 2)));
  await activateLocator(frame.getByRole("button", { name: "Add predicate", exact: true }));
  const filteredRows = fixture.rows - Math.floor(fixture.rows / 2);
  await waitForGridState(frame, {
    rows: filteredRows,
    columns: fixture.columns,
    row: 0,
    column: 0,
    value: Math.floor(fixture.rows / 2)
  });
  const filter = { completed: true, latencyMs: roundMilliseconds(performance.now() - filterStarted) };
  recordProgress("interaction:filter");

  const sortStarted = performance.now();
  await openColumnAction(frame, "c00", "Sort descending");
  await waitForGridState(frame, {
    rows: filteredRows,
    columns: fixture.columns,
    row: 0,
    column: 0,
    value: fixture.rows - 1
  });
  const sort = { completed: true, latencyMs: roundMilliseconds(performance.now() - sortStarted) };
  recordProgress("interaction:sort");

  const profiling = await proveAuthoritativeProfileCancellation(testing, session.sessionId);
  recordProgress("interaction:profiling-cancelled");

  assert.equal(cachedSamplesMs.length, SAMPLE_COUNT);
  assert.equal(uncachedSamplesMs.length, SAMPLE_COUNT);
  assert.equal(heartbeatSamplesMs.length, SAMPLE_COUNT);
  return {
    kind: "grid-interaction",
    cachedSamplesMs,
    uncachedSamplesMs,
    heartbeatSamplesMs,
    filter,
    sort,
    profiling
  };
}

async function configureBenchmarkProfile(testPython: string): Promise<void> {
  const configuration = vscode.workspace.getConfiguration("openWrangler");
  for (const [key, value] of [
    ["pythonPath", testPython],
    ["defaultBackend", "polars"],
    ["fileStartMode", "viewing"],
    ["insightsOnOpen", false],
    ["fetchBlockSize", 200],
    ["fetchColumnBlockSize", 16]
  ] as const) {
    await configuration.update(key, value, vscode.ConfigurationTarget.Global);
  }
}

function readFixtureManifest(manifestPath: string): FixtureManifest {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as FixtureManifest;
  assert.equal(manifest.protocol, FIXTURE_PROTOCOL);
  assert.equal(typeof manifest.smoke, "boolean");
  assert.deepEqual(Object.keys(manifest.fixtures).sort(), ["csv", "parquet"]);
  for (const [format, fixture] of Object.entries(manifest.fixtures)) {
    assert.equal(fixture.format, format);
    assert.match(fixture.fileName, /^\d+-\d+\.(?:csv|parquet)$/u);
    assert.ok(Number.isSafeInteger(fixture.rows) && fixture.rows > 0);
    assert.ok(Number.isSafeInteger(fixture.columns) && fixture.columns > 0);
    assert.match(fixture.sha256, SHA256);
  }
  return manifest;
}

function prepareSourceCache(
  testPython: string,
  workspace: string,
  source: string,
  mode: "cold" | "warm"
): CacheControl {
  const output = execFileSync(
    testPython,
    [path.join(workspace, "benchmarks", "source_cache_control.py"), "--source", source, "--mode", mode],
    {
      encoding: "utf8",
      maxBuffer: 16 * 1024,
      timeout: 30_000,
      windowsHide: true
    }
  );
  const result = JSON.parse(output) as CacheControl;
  assert.deepEqual(Object.keys(result).sort(), ["applied", "method", "supported"]);
  assert.equal(typeof result.supported, "boolean");
  assert.equal(typeof result.applied, "boolean");
  assert.ok(typeof result.method === "string" && result.method.length > 0 && result.method.length <= 256);
  return result;
}

async function runtimeProvenance(
  testPython: string,
  openWranglerRuntimeVersion: string
): Promise<RuntimeProbe & { pythonExecutableSha256: string; openWranglerRuntimeVersion: string }> {
  const output = execFileSync(
    testPython,
    [
      "-I",
      "-c",
      "import json, platform, polars; print(json.dumps({'pythonVersion': platform.python_version(), 'pythonImplementation': platform.python_implementation(), 'polarsVersion': polars.__version__}, sort_keys=True))"
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024, timeout: 30_000, windowsHide: true }
  );
  const probe = JSON.parse(output) as RuntimeProbe;
  assert.deepEqual(Object.keys(probe).sort(), ["polarsVersion", "pythonImplementation", "pythonVersion"]);
  return {
    ...probe,
    pythonExecutableSha256: await sha256(testPython),
    openWranglerRuntimeVersion
  };
}

async function connectToEditorWorkbench(): Promise<Page> {
  const cdpPort = Number(requiredEnvironment("OPEN_WRANGLER_EDITOR_CDP_PORT"));
  assert.ok(Number.isInteger(cdpPort) && cdpPort > 0, "Installed performance requires a private CDP port.");
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  const deadline = Date.now() + 15_000;
  do {
    for (const page of browser.contexts().flatMap((context) => context.pages())) {
      if ((await page.locator(".monaco-workbench").count()) > 0) return page;
    }
    await delay(25);
  } while (Date.now() < deadline);
  throw new Error("The private CDP endpoint did not expose an editor workbench.");
}

async function waitForWorkbenchReady(workbench: Page): Promise<void> {
  const deadline = Date.now() + 15_000;
  do {
    const editor = workbench.locator(".monaco-workbench .part.editor").first();
    if ((await editor.count()) > 0 && (await editor.isVisible())) return;
    await delay(25);
  } while (Date.now() < deadline);
  throw new Error("The private editor workbench did not expose a visible editor part.");
}

async function waitForPanelSynchronization(testing: TestApi, sessionId: string): Promise<void> {
  const deadline = Date.now() + GRID_DISCOVERY_TIMEOUT_MS;
  do {
    const synchronized = await Promise.race([testing.synchronizePanel(sessionId), delay(2_000).then(() => false)]);
    if (synchronized) return;
    await delay(25);
  } while (Date.now() < deadline);
  throw new Error("The installed warm-up renderer did not acknowledge its authoritative host snapshot.");
}

async function waitForUsableGrid(workbench: Page, shape: { rows: number; columns: number }): Promise<Frame> {
  const deadline = Date.now() + GRID_DISCOVERY_TIMEOUT_MS;
  do {
    const browser = workbench.context().browser();
    assertWorkbenchAlive(workbench, browser);
    for (const frame of rendererFrames(workbench, browser)) {
      try {
        if (await frameHasUsableGrid(frame, shape)) return frame;
      } catch {
        // A custom-editor frame can retire while the next sample replaces it.
      }
    }
    await delay(20);
  } while (Date.now() < deadline);
  const browser = workbench.context().browser();
  assertWorkbenchAlive(workbench, browser);
  const diagnostics = await usableGridDiagnostics(workbench, browser);
  throw new Error(
    `The installed production grid did not become usable for shape ${shape.rows}x${shape.columns} within ${GRID_DISCOVERY_TIMEOUT_MS} ms: ${JSON.stringify(diagnostics)}`
  );
}

async function scrollGridToRow(
  frame: Frame,
  row: number,
  totalRows: number,
  totalColumns: number,
  expectedValue: number
): Promise<number> {
  const started = await rendererNow(frame);
  await frame.getByTestId("data-grid-scroller").evaluate((element, targetRow) => {
    (element as unknown as { scrollTop: number }).scrollTop = targetRow * 29;
  }, row);
  await waitForGridState(frame, {
    rows: totalRows,
    columns: totalColumns,
    row,
    column: 0,
    value: expectedValue
  });
  return roundMilliseconds((await rendererNow(frame)) - started);
}

async function measureRendererHeartbeat(frame: Frame): Promise<number> {
  const duration = await frame.evaluate(() => {
    const browser = globalThis as unknown as {
      performance: { now(): number };
      requestAnimationFrame(callback: () => void): number;
    };
    return new Promise<number>((resolve) => {
      const started = browser.performance.now();
      browser.requestAnimationFrame(() => resolve(browser.performance.now() - started));
    });
  });
  return roundMilliseconds(duration);
}

async function rendererNow(frame: Frame): Promise<number> {
  return frame.evaluate(() => {
    const browser = globalThis as unknown as { performance: { now(): number } };
    return browser.performance.now();
  });
}

async function openColumnAction(frame: Frame, column: string, action: string): Promise<void> {
  const header = frame.locator(`th[data-column="${column}"]`).first();
  const details = header.locator("details.columnMenu").first();
  const summary = details.getByLabel(`Column actions for ${column}`);
  if (!(await details.evaluate((element) => element.hasAttribute("open")))) {
    await activateLocator(summary);
  }
  await activateLocator(details.getByRole("button", { name: action, exact: true }));
}

async function activateLocator(locator: Locator): Promise<void> {
  await locator.evaluate((element) => {
    (element as unknown as { click(): void }).click();
  });
}

async function waitForGridState(
  frame: Frame,
  expected: { rows: number; columns: number; row: number; column: number; value: number }
): Promise<void> {
  const deadline = Date.now() + GRID_DISCOVERY_TIMEOUT_MS;
  do {
    try {
      const grid = frame.locator('table[role="grid"]').first();
      const cell = frame.locator(`[data-grid-row="${expected.row}"][data-grid-column="${expected.column}"]`).first();
      if (
        (await grid.count()) > 0 &&
        (await grid.getAttribute("aria-busy")) === "false" &&
        (await grid.getAttribute("aria-rowcount")) === String(expected.rows + 1) &&
        (await grid.getAttribute("aria-colcount")) === String(expected.columns + 1) &&
        (await cell.count()) > 0 &&
        (await cell.isVisible()) &&
        (await cell.textContent()) === String(expected.value)
      ) {
        return;
      }
    } catch {
      // The renderer can briefly replace its virtualized rows while a view query commits.
    }
    await delay(20);
  } while (Date.now() < deadline);
  throw new Error(
    `The production grid did not commit ${expected.rows} rows with value ${expected.value} at ${expected.row},${expected.column}.`
  );
}

async function proveAuthoritativeProfileCancellation(
  testing: TestApi,
  expectedSessionId: string
): Promise<{
  activeObserved: true;
  cancellationRequested: true;
  cancelAcknowledged: true;
  originalRequestSettled: true;
  originalResponseKind: "cancelled";
}> {
  const active = testing.activeSession();
  assert.ok(active && active.sessionId === expectedSessionId, "The interaction session must remain active.");
  const { metadata } = active;
  const activeRequestId = `installed-profile-active-${randomUUID()}`;
  const cancelledRequestId = `installed-profile-cancelled-${randomUUID()}`;
  const pageRequestId = `installed-profile-page-${randomUUID()}`;
  let activeSettled = false;
  const activeProfile = testing
    .request(
      {
        kind: "getSummary",
        sessionId: expectedSessionId,
        revision: metadata.revision,
        viewRequestId: activeRequestId,
        filterModel: metadata.filterModel,
        columns: metadata.schema.map((column) => column.name)
      },
      { priority: "background", timeoutMs: GRID_DISCOVERY_TIMEOUT_MS, restartRuntimeOnTimeout: false }
    )
    .finally(() => {
      activeSettled = true;
    });
  const cancelledProfile = testing.request(
    {
      kind: "getDatasetStats",
      sessionId: expectedSessionId,
      revision: metadata.revision,
      viewRequestId: cancelledRequestId,
      filterModel: metadata.filterModel
    },
    { priority: "background", timeoutMs: GRID_DISCOVERY_TIMEOUT_MS, restartRuntimeOnTimeout: false }
  );
  const interactivePage = testing.request(
    {
      kind: "getPage",
      sessionId: expectedSessionId,
      revision: metadata.revision,
      viewRequestId: pageRequestId,
      offset: 0,
      limit: 200,
      columnOffset: 0,
      columnLimit: Math.min(16, metadata.schema.length),
      filterModel: metadata.filterModel
    },
    { priority: "interactive", timeoutMs: GRID_DISCOVERY_TIMEOUT_MS, restartRuntimeOnTimeout: false }
  );

  const activeObserved = !activeSettled;
  testing.cancelViewRequests(expectedSessionId, [cancelledRequestId]);
  const cancelledResponse = await cancelledProfile;
  const [activeResponse, pageResponse] = await Promise.all([activeProfile, interactivePage]);
  assert.equal(activeResponse.kind, "summary", "The accepted active profile must settle authoritatively.");
  assert.equal(pageResponse.kind, "page", "A foreground page must complete while profiling uses its background lane.");
  assert.equal(cancelledResponse.kind, "cancelled", "The original queued profile must return its own cancellation.");
  assert.equal(cancelledResponse.viewRequestId, cancelledRequestId);
  assert.equal(activeObserved, true, "The cancelled profile must have queued behind accepted active profiling.");

  return {
    activeObserved: true,
    cancellationRequested: true,
    cancelAcknowledged: true,
    originalRequestSettled: true,
    originalResponseKind: "cancelled"
  };
}

async function frameHasUsableGrid(frame: Frame, shape: { rows: number; columns: number }): Promise<boolean> {
  const grid = frame.locator('table[role="grid"]').first();
  if ((await grid.count()) === 0 || !(await grid.isVisible())) return false;
  const attributes = await grid.evaluate((element) => ({
    busy: element.getAttribute("aria-busy"),
    rows: element.getAttribute("aria-rowcount"),
    columns: element.getAttribute("aria-colcount")
  }));
  if (
    attributes.busy !== "false" ||
    attributes.rows !== String(shape.rows + 1) ||
    attributes.columns !== String(shape.columns + 1)
  ) {
    return false;
  }
  for (const [row, column] of [
    [0, 0],
    [0, Math.min(1, shape.columns - 1)],
    [Math.min(1, shape.rows - 1), 0]
  ]) {
    const cell = frame.locator(`[data-grid-row="${row}"][data-grid-column="${column}"]`).first();
    if ((await cell.count()) === 0 || !(await cell.isVisible())) return false;
    if ((await cell.textContent()) !== String(row + column)) return false;
  }
  return true;
}

function rendererFrames(workbench: Page, browser: Browser | null): Frame[] {
  const discovered = browser?.contexts().flatMap((context) => context.pages()) ?? [workbench];
  const pages = [workbench, ...discovered.filter((page) => page !== workbench && !page.isClosed())];
  return [...new Set(pages)].flatMap((page) => page.frames()).slice(0, 64);
}

async function usableGridDiagnostics(workbench: Page, browser: Browser | null): Promise<unknown> {
  const discovered = browser?.contexts().flatMap((context) => context.pages()) ?? [workbench];
  const pages = [workbench, ...discovered.filter((page) => page !== workbench && !page.isClosed())];
  const uniquePages = [...new Set(pages)].slice(0, 16);
  const diagnostics: unknown[] = [];
  for (const [pageIndex, page] of uniquePages.entries()) {
    for (const [frameIndex, frame] of page.frames().slice(0, 16).entries()) {
      try {
        const grid = frame.locator('table[role="grid"]').first();
        const gridCount = await grid.count();
        const firstCell = frame.locator('[data-grid-row="0"][data-grid-column="0"]').first();
        const firstCellCount = await firstCell.count();
        const protocol = rendererProtocol(frame.url());
        diagnostics.push({
          pageIndex,
          frameIndex,
          protocol,
          workbench: page === workbench,
          mainFrame: frame === page.mainFrame(),
          rootCount: await frame.locator("#root").count(),
          workspaceCount: await frame.locator('[data-testid="app-workspace"]').count(),
          gridCount,
          gridVisible: gridCount > 0 && (await grid.isVisible()),
          busy: gridCount > 0 ? await grid.getAttribute("aria-busy") : null,
          rowCount: gridCount > 0 ? await grid.getAttribute("aria-rowcount") : null,
          columnCount: gridCount > 0 ? await grid.getAttribute("aria-colcount") : null,
          firstCellCount,
          firstCellVisible: firstCellCount > 0 && (await firstCell.isVisible())
        });
      } catch {
        diagnostics.push({ pageIndex, frameIndex, retired: true });
      }
      if (diagnostics.length >= 32) return diagnostics;
    }
  }
  return diagnostics;
}

function rendererProtocol(url: string): string {
  try {
    const protocol = new URL(url).protocol.toLowerCase();
    return ["about:", "file:", "http:", "https:", "vscode-file:", "vscode-webview:"].includes(protocol)
      ? protocol
      : "other";
  } catch {
    return "other";
  }
}

function assertWorkbenchAlive(workbench: Page, browser: Browser | null): void {
  if (workbench.isClosed()) throw new Error("The editor workbench closed during installed grid discovery.");
  if (browser && !browser.isConnected()) throw new Error("The private CDP browser disconnected.");
}

async function waitForHostSession(
  testing: TestApi,
  predicate: (metadata: SessionMetadata) => boolean,
  timeoutMs: number,
  label: string
): Promise<{ sessionId: string; metadata: SessionMetadata }> {
  let matched: { sessionId: string; metadata: SessionMetadata } | undefined;
  await waitFor(
    () => {
      const active = testing.activeSession();
      if (active !== undefined && predicate(active.metadata)) {
        matched = active;
        return true;
      }
      return false;
    },
    timeoutMs,
    label
  );
  assert.ok(matched);
  return matched;
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (predicate()) return;
    await delay(20);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}.`);
}

function soleFileWorkspace(): string {
  const folders = vscode.workspace.workspaceFolders;
  assert.equal(folders?.length, 1, "Installed performance requires exactly one private workspace.");
  const folder = folders?.[0];
  assert.ok(folder && folder.uri.scheme === "file", "Installed performance requires one local file workspace.");
  return folder.uri.fsPath;
}

function editorKey(): "vscode" | "cursor" {
  const value = requiredEnvironment("OPEN_WRANGLER_TEST_EDITOR");
  assert.ok(value === "vscode" || value === "cursor", "Installed performance supports VS Code or Cursor.");
  return value;
}

function requiredEnvironment(key: string): string {
  const value = process.env[key];
  assert.ok(value && !/[\0\r\n]/u.test(value), `Installed performance requires ${key}.`);
  return value;
}

function recordProgress(checkpoint: string): void {
  const progressPath = requiredEnvironment("OPEN_WRANGLER_TEST_PROGRESS");
  writeAcceptanceProgressCheckpoint(progressPath, {
    protocol: ACCEPTANCE_PROGRESS_PROTOCOL,
    runId: requiredEnvironment("OPEN_WRANGLER_TEST_RUN_ID"),
    phase: requiredEnvironment("OPEN_WRANGLER_TEST_PHASE"),
    checkpoint
  });
}

async function sha256(file: string): Promise<string> {
  const digest = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return digest.digest("hex");
}

function publishFragment(destination: string, value: unknown): void {
  mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  try {
    lstatSync(destination);
    throw new Error("The installed performance fragment destination must be unused.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  let published = false;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    const identity = fstatSync(descriptor, { bigint: true });
    assert.ok(identity.isFile() && identity.nlink === 1n);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    const complete = fstatSync(descriptor, { bigint: true });
    assert.ok(
      complete.isFile() && complete.nlink === 1n && complete.dev === identity.dev && complete.ino === identity.ino
    );
    closeSync(descriptor);
    descriptor = undefined;
    const atPath = lstatSync(temporary, { bigint: true });
    assert.ok(
      atPath.isFile() &&
        !atPath.isSymbolicLink() &&
        atPath.nlink === 1n &&
        atPath.dev === complete.dev &&
        atPath.ino === complete.ino
    );
    renameSync(temporary, destination);
    published = true;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (!published) rmSync(temporary, { force: true });
  }
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
