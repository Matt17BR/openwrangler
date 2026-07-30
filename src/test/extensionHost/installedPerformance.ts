import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import * as vscode from "vscode";
import { chromium, type Browser, type Frame, type Locator, type Page } from "playwright-core";
import type { BridgeRequestOptions } from "../../extension/dataBridge";
import type { SessionRequestExecutionCheckpoint } from "../../extension/sessionCoordinator";
import { decodeInstalledPerformanceFixtureManifest } from "../../shared/installedPerformanceFixtureManifest.cjs";
import type {
  InstalledPerformanceFixtureEntry,
  InstalledPerformanceFixtureManifest
} from "../../shared/installedPerformanceFixtureManifestTypes";
import type { OpenWranglerRequest, OpenWranglerResponse, SessionMetadata } from "../../shared/protocol";
import { parseStrictJson } from "../../shared/strictJson.cjs";
import { publishInstalledPerformanceFragment, type InstalledPerformanceArtifactReceipt } from "./fragmentPublication";
import { ACCEPTANCE_PROGRESS_PROTOCOL, writeAcceptanceProgressCheckpoint } from "./progress";
import {
  createAlternatingGridScrollTargets,
  installedPerformanceCachedGridWarmupTransitionCount,
  installedPerformanceGridRowHeight,
  installedPerformanceMaximumCanvasHeight,
  measureRendererGridScroll,
  rendererHasUsableGridGeometry,
  waitForInstalledPerformanceRendererAcknowledgement
} from "./rendererGridScrollMeasurement";

const PHASE_PROTOCOL = "openwrangler-installed-performance-phase-v6";
const CACHE_PROOF_PROTOCOL = "openwrangler-source-cache-proof-v1";
const FIRST_GRID_BOUNDARY =
  "vscode.openWith dispatch to a visible production grid block with exact shape and aria-busy=false";
const FIRST_GRID_SAMPLE_COUNT = 10;
const GRID_INTERACTION_SAMPLE_COUNT = 40;
const SMOKE_GRID_INTERACTION_SAMPLE_COUNT = 10;
const GRID_DISCOVERY_TIMEOUT_MS = 60_000;
const SESSION_CLOSE_TIMEOUT_MS = 15_000;
const FIRST_GRID_PHASE_PATTERN = /^perf-(csv|parquet)-(cold|warm)$/u;
const GRID_INTERACTION_PHASE = "perf-grid-interaction";
const MAX_PRIVATE_JSON_BYTES = 16 * 1024;

interface TestApi {
  activeSession(): { sessionId: string; metadata: SessionMetadata } | undefined;
  request(request: OpenWranglerRequest, options?: BridgeRequestOptions): Promise<OpenWranglerResponse>;
  cancelViewRequests(sessionId: string, viewRequestIds: readonly string[]): void;
  requestExecutionCheckpoint(
    sessionId: string,
    requestKind: "getSummary" | "getDatasetStats",
    viewRequestId: string
  ): SessionRequestExecutionCheckpoint | undefined;
  diagnostics(): { sessionCount: number };
  runtimeRunning(): boolean;
  synchronizePanel(sessionId: string): Promise<boolean>;
}

interface ExtensionApi {
  testing?: TestApi;
}

interface RuntimeProbe {
  pythonVersion: string;
  pythonImplementation: string;
  polarsVersion: string;
}

interface CacheProof {
  protocol: string;
  requestedState: "evicted" | "resident";
  fdatasyncApplied: boolean;
  adviceAccepted: boolean;
  verification: "linux-mincore" | "unavailable";
  pageSizeBytes: number;
  totalPages: number;
  residentPagesBefore: number | null;
  residentPagesAfter: number | null;
  identityStable: boolean;
  verified: boolean;
}

interface ProductConfiguration {
  defaultBackend: "auto";
  fileStartMode: "editing";
  insightsOnOpen: true;
  fetchBlockSize: 200;
  fetchColumnBlockSize: 16;
}

export async function run(): Promise<InstalledPerformanceArtifactReceipt> {
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
  const productConfiguration = await configureBenchmarkProfile(testPython);
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
      : await measureGridInteraction({
          testing,
          workbench,
          sourceUri,
          fixture,
          sampleCount: manifest.smoke ? SMOKE_GRID_INTERACTION_SAMPLE_COUNT : GRID_INTERACTION_SAMPLE_COUNT
        });
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
    productConfiguration,
    fixture: {
      format,
      rows: fixture.rows,
      columns: fixture.columns,
      sha256: fixture.sha256
    },
    measurement
  };
  const receipt = publishInstalledPerformanceFragment(path.join(workspace, "results", `${phase}.json`), fragment);
  recordProgress("fragment:published");
  return receipt;
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
  fixture: InstalledPerformanceFixtureEntry;
  sourceCache: "cold" | "warm";
}): Promise<Record<string, unknown>> {
  const warmup = vscode.Uri.file(path.join(workspace, "warmup.csv"));
  const samplesMs: number[] = [];
  const cacheProofs: CacheProof[] = [];

  recordProgress("warmup:open");
  await vscode.commands.executeCommand("vscode.openWith", warmup, "openWrangler.viewer", vscode.ViewColumn.One);
  const warmupSession = await waitForHostSession(
    testing,
    (metadata) =>
      metadata.source.kind === "file" &&
      metadata.source.path === warmup.fsPath &&
      metadata.backend === "polars" &&
      metadata.mode === "editing",
    GRID_DISCOVERY_TIMEOUT_MS,
    "the runtime warm-up session"
  );
  recordProgress("warmup:host-session");
  await waitForPanelSynchronization(testing, warmupSession.sessionId);
  recordProgress("warmup:renderer-synchronized");
  await waitForUsableGrid(workbench, { rows: 2, columns: 2 });
  recordProgress("warmup:complete");

  for (let sample = 0; sample < FIRST_GRID_SAMPLE_COUNT; sample += 1) {
    recordProgress(`sample-${sample + 1}:cache`);
    const prepared = prepareSourceCache(testPython, workspace, source, sourceCache);
    cacheProofs.push(prepared);

    const started = performance.now();
    await vscode.commands.executeCommand("vscode.openWith", sourceUri, "openWrangler.viewer", vscode.ViewColumn.One);
    await waitForHostSession(
      testing,
      (metadata) =>
        metadata.source.kind === "file" &&
        metadata.source.path === sourceUri.fsPath &&
        metadata.backend === "polars" &&
        metadata.mode === "editing" &&
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

  assert.equal(samplesMs.length, FIRST_GRID_SAMPLE_COUNT);
  assert.equal(cacheProofs.length, samplesMs.length, "Every timed first-grid sample must retain one cache proof.");
  return {
    kind: "first-grid",
    boundary: FIRST_GRID_BOUNDARY,
    sourceCache,
    cacheProofs,
    samplesMs
  };
}

async function measureGridInteraction({
  testing,
  workbench,
  sourceUri,
  fixture,
  sampleCount
}: {
  testing: TestApi;
  workbench: Page;
  sourceUri: vscode.Uri;
  fixture: InstalledPerformanceFixtureEntry;
  sampleCount: number;
}): Promise<Record<string, unknown>> {
  assert.ok(
    sampleCount === GRID_INTERACTION_SAMPLE_COUNT || sampleCount === SMOKE_GRID_INTERACTION_SAMPLE_COUNT,
    "Grid-interaction sample count must match the release or smoke contract."
  );
  recordProgress("interaction:open");
  await vscode.commands.executeCommand("vscode.openWith", sourceUri, "openWrangler.viewer", vscode.ViewColumn.One);
  const session = await waitForHostSession(
    testing,
    (metadata) =>
      metadata.source.kind === "file" &&
      metadata.source.path === sourceUri.fsPath &&
      metadata.backend === "polars" &&
      metadata.mode === "editing" &&
      metadata.shape.rows === fixture.rows &&
      metadata.shape.columns === fixture.columns,
    GRID_DISCOVERY_TIMEOUT_MS,
    "the grid-interaction host session"
  );
  recordProgress("interaction:host-session");
  await waitForPanelSynchronization(testing, session.sessionId);
  const frame = await waitForUsableGrid(workbench, { rows: fixture.rows, columns: fixture.columns });
  recordProgress("interaction:usable-grid");

  const cachedRows = [0, 400] as const;
  for (const row of cachedRows) {
    await scrollGridToRow(frame, row, fixture.rows, fixture.columns, row);
  }
  await scrollGridToRow(frame, cachedRows[0]!, fixture.rows, fixture.columns, cachedRows[0]!);

  // Prime the renderer/compositor's repeated cached-transition path before
  // timing. Startup remains covered by the independent first-grid phases.
  for (const row of createAlternatingGridScrollTargets(
    cachedRows,
    installedPerformanceCachedGridWarmupTransitionCount
  )) {
    await scrollGridToRow(frame, row, fixture.rows, fixture.columns, row);
  }
  recordProgress("interaction:cached-warmup-complete");

  const cachedSamplesMs: number[] = [];
  for (const [sample, row] of createAlternatingGridScrollTargets(cachedRows, sampleCount).entries()) {
    cachedSamplesMs.push(await scrollGridToRow(frame, row, fixture.rows, fixture.columns, row));
    recordProgress(`interaction:cached-${sample + 1}`);
  }

  const uncachedRows = Array.from({ length: sampleCount }, (_, index) => 800 + index * 400);
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
  const filteredRows = fixture.rows - Math.floor(fixture.rows / 2);
  let filterSettled = false;
  const filterOperation = (async () => {
    await activateLocator(frame.getByRole("button", { name: "Add predicate", exact: true }));
    await waitForGridState(frame, {
      rows: filteredRows,
      columns: fixture.columns,
      row: 0,
      column: 0,
      value: Math.floor(fixture.rows / 2)
    });
  })().finally(() => {
    filterSettled = true;
  });
  const [filterResponsiveness] = await Promise.all([
    measureOutstandingResponsiveness(frame, testing, session.sessionId, () =>
      assert.equal(
        filterSettled,
        false,
        "The filter UI operation must still be outstanding when responsiveness probes start."
      )
    ),
    filterOperation
  ]);
  const filter = {
    completed: true,
    latencyMs: roundMilliseconds(performance.now() - filterStarted),
    responsiveness: filterResponsiveness
  };
  recordProgress("interaction:filter");

  const sortStarted = performance.now();
  const sortAction = await prepareColumnAction(frame, "c00", "Sort descending");
  let sortSettled = false;
  const sortOperation = (async () => {
    await activateLocator(sortAction);
    await waitForGridState(frame, {
      rows: filteredRows,
      columns: fixture.columns,
      row: 0,
      column: 0,
      value: fixture.rows - 1
    });
  })().finally(() => {
    sortSettled = true;
  });
  const [sortResponsiveness] = await Promise.all([
    measureOutstandingResponsiveness(frame, testing, session.sessionId, () =>
      assert.equal(
        sortSettled,
        false,
        "The sort UI operation must still be outstanding when responsiveness probes start."
      )
    ),
    sortOperation
  ]);
  const sort = {
    completed: true,
    latencyMs: roundMilliseconds(performance.now() - sortStarted),
    responsiveness: sortResponsiveness
  };
  recordProgress("interaction:sort");

  const profiling = await proveAuthoritativeProfileCancellation(testing, frame, session.sessionId);
  recordProgress("interaction:profiling-cancelled");

  assert.equal(cachedSamplesMs.length, sampleCount);
  assert.equal(uncachedSamplesMs.length, sampleCount);
  assert.equal(heartbeatSamplesMs.length, sampleCount);
  return {
    kind: "grid-interaction",
    cachedGridWarmupTransitionCount: installedPerformanceCachedGridWarmupTransitionCount,
    cachedSamplesMs,
    uncachedSamplesMs,
    heartbeatSamplesMs,
    filter,
    sort,
    profiling
  };
}

async function configureBenchmarkProfile(testPython: string): Promise<ProductConfiguration> {
  await vscode.workspace
    .getConfiguration("openWrangler")
    .update("pythonPath", testPython, vscode.ConfigurationTarget.Global);
  const configuration = vscode.workspace.getConfiguration("openWrangler");
  assert.equal(configuration.get("pythonPath"), testPython, "The benchmark must use its private Python interpreter.");
  const expected: ProductConfiguration = {
    defaultBackend: "auto",
    fileStartMode: "editing",
    insightsOnOpen: true,
    fetchBlockSize: 200,
    fetchColumnBlockSize: 16
  };
  for (const [key, value] of Object.entries(expected)) {
    const inspection = configuration.inspect(key);
    assert.ok(inspection, `The packaged extension must contribute ${key}.`);
    assert.equal(inspection.defaultValue, value, `${key} must retain its shipped default.`);
    assert.equal(inspection.globalValue, undefined, `${key} must not have a benchmark override.`);
    assert.equal(inspection.workspaceValue, undefined, `${key} must not have a workspace override.`);
    assert.equal(inspection.workspaceFolderValue, undefined, `${key} must not have a workspace-folder override.`);
    assert.equal(configuration.get(key), value, `${key} must resolve to its shipped default.`);
  }
  return expected;
}

function readFixtureManifest(manifestPath: string): InstalledPerformanceFixtureManifest {
  return decodeInstalledPerformanceFixtureManifest(
    parseStrictJson(readFileSync(manifestPath, "utf8"), {
      maxBytes: MAX_PRIVATE_JSON_BYTES
    })
  ) as InstalledPerformanceFixtureManifest;
}

function prepareSourceCache(testPython: string, workspace: string, source: string, mode: "cold" | "warm"): CacheProof {
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
  const parsed = parseStrictJson(output, { maxBytes: MAX_PRIVATE_JSON_BYTES });
  assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed));
  const result = parsed as CacheProof;
  assert.deepEqual(Object.keys(result).sort(), [
    "adviceAccepted",
    "fdatasyncApplied",
    "identityStable",
    "pageSizeBytes",
    "protocol",
    "requestedState",
    "residentPagesAfter",
    "residentPagesBefore",
    "totalPages",
    "verification",
    "verified"
  ]);
  assert.equal(result.protocol, CACHE_PROOF_PROTOCOL);
  assert.equal(result.requestedState, mode === "cold" ? "evicted" : "resident");
  assert.equal(typeof result.fdatasyncApplied, "boolean");
  assert.equal(typeof result.adviceAccepted, "boolean");
  assert.ok(["linux-mincore", "unavailable"].includes(result.verification));
  assert.ok(Number.isSafeInteger(result.pageSizeBytes) && result.pageSizeBytes > 0);
  assert.ok(Number.isSafeInteger(result.totalPages) && result.totalPages > 0);
  for (const count of [result.residentPagesBefore, result.residentPagesAfter]) {
    assert.ok(
      count === null || (Number.isSafeInteger(count) && count >= 0 && count <= result.totalPages),
      "Cache residency counts must be null or bounded page counts."
    );
  }
  assert.equal(typeof result.identityStable, "boolean");
  assert.equal(typeof result.verified, "boolean");
  if (result.verification === "linux-mincore") {
    assert.notEqual(result.residentPagesBefore, null);
    assert.notEqual(result.residentPagesAfter, null);
  } else {
    assert.equal(result.residentPagesBefore, null);
    assert.equal(result.residentPagesAfter, null);
  }
  if (result.verified) {
    assert.equal(result.fdatasyncApplied, true);
    assert.equal(result.identityStable, true);
    assert.equal(result.verification, "linux-mincore");
    assert.equal(
      result.residentPagesAfter,
      mode === "cold" ? 0 : result.totalPages,
      "Verified cache proof must show the requested final residency."
    );
    assert.equal(result.adviceAccepted, mode === "cold");
  }
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
  const parsed = parseStrictJson(output, { maxBytes: MAX_PRIVATE_JSON_BYTES });
  assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed));
  const probe = parsed as RuntimeProbe;
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
  const synchronized = await waitForInstalledPerformanceRendererAcknowledgement({
    attempt: () => testing.synchronizePanel(sessionId),
    timeoutMs: GRID_DISCOVERY_TIMEOUT_MS,
    retryDelayMs: 25
  });
  if (synchronized) return;
  throw new Error("The installed renderer did not acknowledge its authoritative host snapshot.");
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
  const duration = await frame.evaluate(measureRendererGridScroll, {
    row,
    column: 0,
    totalRows,
    totalColumns,
    expectedText: String(expectedValue),
    rowHeight: installedPerformanceGridRowHeight,
    maximumCanvasHeight: installedPerformanceMaximumCanvasHeight,
    timeoutMs: GRID_DISCOVERY_TIMEOUT_MS
  });
  return roundMilliseconds(duration);
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

async function openColumnAction(frame: Frame, column: string, action: string): Promise<void> {
  await activateLocator(await prepareColumnAction(frame, column, action));
}

async function prepareColumnAction(frame: Frame, column: string, action: string): Promise<Locator> {
  const header = frame.locator(`th[data-column="${column}"]`).first();
  const details = header.locator("details.columnMenu").first();
  const summary = details.getByLabel(`Column actions for ${column}`);
  if (!(await details.evaluate((element) => element.hasAttribute("open")))) {
    await activateLocator(summary);
  }
  return details.getByRole("button", { name: action, exact: true });
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
  frame: Frame,
  expectedSessionId: string
): Promise<{
  activeObserved: true;
  activeCheckpoint: SessionRequestExecutionCheckpoint;
  queuedCheckpoint: SessionRequestExecutionCheckpoint;
  cancellationRequested: true;
  cancelAcknowledged: true;
  originalRequestSettled: true;
  originalResponseKind: "cancelled";
  responsiveness: OutstandingResponsiveness;
}> {
  const active = testing.activeSession();
  assert.ok(active && active.sessionId === expectedSessionId, "The interaction session must remain active.");
  const { metadata } = active;
  const [firstColumn, ...remainingColumns] = metadata.schema;
  assert.ok(firstColumn, "The interaction fixture must expose at least one column.");
  const activeRequestId = `installed-profile-active-${randomUUID()}`;
  const cancelledRequestId = `installed-profile-cancelled-${randomUUID()}`;
  const activeProfile = testing.request(
    {
      kind: "getSummary",
      sessionId: expectedSessionId,
      revision: metadata.revision,
      viewRequestId: activeRequestId,
      filterModel: metadata.filterModel,
      columnIds: [firstColumn.id, ...remainingColumns.map((column) => column.id)]
    },
    { priority: "background", timeoutMs: GRID_DISCOVERY_TIMEOUT_MS, restartRuntimeOnTimeout: false }
  );
  const activeCheckpoint = await waitForExecutionCheckpoint(
    testing,
    expectedSessionId,
    "getSummary",
    activeRequestId,
    "active",
    "background"
  );
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
  const queuedCheckpoint = await waitForExecutionCheckpoint(
    testing,
    expectedSessionId,
    "getDatasetStats",
    cancelledRequestId,
    "queued",
    "background"
  );
  const responsivenessPromise = measureOutstandingResponsiveness(frame, testing, expectedSessionId, () => {
    assert.deepEqual(
      testing.requestExecutionCheckpoint(expectedSessionId, "getSummary", activeRequestId),
      activeCheckpoint,
      "The exact accepted profile must still own the background lane when responsiveness probes start."
    );
    assert.deepEqual(
      testing.requestExecutionCheckpoint(expectedSessionId, "getDatasetStats", cancelledRequestId),
      queuedCheckpoint,
      "The exact cancellable profile must still be queued when responsiveness probes start."
    );
  });
  testing.cancelViewRequests(expectedSessionId, [cancelledRequestId]);
  const cancelledResponse = await cancelledProfile;
  const [activeResponse, responsiveness] = await Promise.all([activeProfile, responsivenessPromise]);
  assert.equal(activeResponse.kind, "summary", "The accepted active profile must settle authoritatively.");
  assert.equal(cancelledResponse.kind, "cancelled", "The original queued profile must return its own cancellation.");
  assert.equal(cancelledResponse.viewRequestId, cancelledRequestId);

  return {
    activeObserved: true,
    activeCheckpoint,
    queuedCheckpoint,
    cancellationRequested: true,
    cancelAcknowledged: true,
    originalRequestSettled: true,
    originalResponseKind: "cancelled",
    responsiveness
  };
}

async function waitForExecutionCheckpoint(
  testing: TestApi,
  sessionId: string,
  requestKind: "getSummary" | "getDatasetStats",
  viewRequestId: string,
  state: SessionRequestExecutionCheckpoint["state"],
  lane: SessionRequestExecutionCheckpoint["lane"]
): Promise<SessionRequestExecutionCheckpoint> {
  let observed: SessionRequestExecutionCheckpoint | undefined;
  await waitFor(
    () => {
      const checkpoint = testing.requestExecutionCheckpoint(sessionId, requestKind, viewRequestId);
      if (checkpoint?.state !== state || checkpoint.lane !== lane) return false;
      observed = checkpoint;
      return true;
    },
    GRID_DISCOVERY_TIMEOUT_MS,
    `${requestKind} ${viewRequestId} to enter the exact ${state} ${lane} scheduler lane`
  );
  assert.deepEqual(observed, { sessionId, state, lane, requestKind, viewRequestId });
  return observed;
}

interface OutstandingResponsiveness {
  outstandingObserved: true;
  rendererHeartbeatMs: number;
  foregroundPageLatencyMs: number;
  foregroundResponseKind: "page";
}

async function measureOutstandingResponsiveness(
  frame: Frame,
  testing: TestApi,
  expectedSessionId: string,
  assertOutstanding: () => void
): Promise<OutstandingResponsiveness> {
  assertOutstanding();
  const heartbeat = measureRendererHeartbeat(frame);
  const foregroundPage = measureForegroundPage(testing, expectedSessionId);
  const [rendererHeartbeatMs, page] = await Promise.all([heartbeat, foregroundPage]);
  return {
    outstandingObserved: true,
    rendererHeartbeatMs,
    foregroundPageLatencyMs: page.latencyMs,
    foregroundResponseKind: page.responseKind
  };
}

async function measureForegroundPage(
  testing: TestApi,
  expectedSessionId: string
): Promise<{ latencyMs: number; responseKind: "page" }> {
  const active = testing.activeSession();
  assert.ok(active && active.sessionId === expectedSessionId, "The responsiveness session must remain active.");
  const { metadata } = active;
  assert.ok(metadata.schema.length > 0, "The responsiveness fixture must expose at least one column.");
  const started = performance.now();
  const response = await testing.request(
    {
      kind: "getPage",
      sessionId: expectedSessionId,
      revision: metadata.revision,
      viewRequestId: `installed-foreground-page-${randomUUID()}`,
      offset: 0,
      limit: 200,
      columnOffset: 0,
      columnLimit: Math.min(16, metadata.schema.length),
      filterModel: metadata.filterModel
    },
    { priority: "interactive", timeoutMs: GRID_DISCOVERY_TIMEOUT_MS, restartRuntimeOnTimeout: false }
  );
  assert.equal(response.kind, "page", "A foreground page must complete while the measured operation is outstanding.");
  return { latencyMs: roundMilliseconds(performance.now() - started), responseKind: "page" };
}

async function frameHasUsableGrid(frame: Frame, shape: { rows: number; columns: number }): Promise<boolean> {
  const grid = frame.locator('table[role="grid"]').first();
  if ((await grid.count()) === 0 || !(await grid.isVisible())) return false;
  const scroller = frame.getByTestId("data-grid-scroller").first();
  if ((await scroller.count()) === 0 || !(await scroller.isVisible())) return false;
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
  const requiredCells = [
    [0, 0],
    [0, Math.min(1, shape.columns - 1)],
    [Math.min(1, shape.rows - 1), 0]
  ] as const;
  for (const [row, column] of requiredCells) {
    const cell = frame.locator(`[data-grid-row="${row}"][data-grid-column="${column}"]`).first();
    if ((await cell.count()) === 0 || !(await cell.isVisible())) return false;
    if ((await cell.textContent()) !== String(row + column)) return false;
  }
  if (!(await frame.evaluate(rendererHasUsableGridGeometry, { cells: requiredCells }))) return false;
  const insightsToggle = frame.getByRole("button", { name: "Hide insights", exact: true });
  if ((await insightsToggle.count()) === 0 || !(await insightsToggle.isVisible())) return false;
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

function roundMilliseconds(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
