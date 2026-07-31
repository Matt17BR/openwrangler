import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, lstatSync, readFileSync, type BigIntStats } from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import * as vscode from "vscode";
import { chromium, type Frame, type Locator, type Page } from "playwright-core";
import { decodeInstalledPerformanceFixtureManifest } from "../../shared/installedPerformanceFixtureManifest.cjs";
import type {
  InstalledPerformanceFixtureEntry,
  InstalledPerformanceFixtureManifest
} from "../../shared/installedPerformanceFixtureManifestTypes";
import { parseStrictJson } from "../../shared/strictJson.cjs";
import {
  DEFAULT_COMPARISON_GRID_READINESS_INPUT,
  observeComparisonGridReadiness,
  type ComparisonGridReadinessEvidence
} from "./comparisonGridReadiness";
import { publishInstalledPerformanceFragment, type InstalledPerformanceArtifactReceipt } from "./fragmentPublication";
import { ACCEPTANCE_PROGRESS_PROTOCOL, writeAcceptanceProgressCheckpoint } from "./progress";

const COMPARISON_PRODUCT_FRAGMENT_PROTOCOL = "openwrangler-comparison-product-fragment-v1";
const COMPARISON_BOUNDARY =
  "visible Explorer context-menu action click to a selected unobstructed target editor with a stable pointer-usable generic ARIA grid or table and matched deterministic sentinels";
const CACHE_PROOF_PROTOCOL = "openwrangler-source-cache-proof-v1";
const PHASES = Object.freeze({
  "comparison-open-wrangler": "open-wrangler",
  "comparison-data-wrangler": "data-wrangler"
} as const);
const ACTIONS = Object.freeze({
  "open-wrangler": "Open in Open Wrangler",
  "data-wrangler": "Open in Data Wrangler"
} as const);
const MAX_PRIVATE_JSON_BYTES = 16 * 1024;
const WORKBENCH_TIMEOUT_MS = 20_000;
const GRID_TIMEOUT_MS = 120_000;
const FRAME_PROBE_TIMEOUT_MS = 250;
const FRAME_PROBE_RETRY_DELAY_MS = 50;
const FRAME_PROBE_RETRIES = 1;
const EDITOR_CLOSE_TIMEOUT_MS = 15_000;
const PACKAGE_VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$/u;

type ComparisonPhase = keyof typeof PHASES;
type ProductKey = (typeof PHASES)[ComparisonPhase];
type FixtureFormat = "csv" | "parquet";

interface ConfiguredPythonEnvironment {
  readonly pythonVersion: string;
  readonly pythonImplementation: "CPython";
  readonly pythonExecutableSha256: string;
  readonly installedPandasVersion: string;
  readonly installedPyarrowVersion: string;
  readonly installedJupyterCoreVersion: string;
  readonly installedIpykernelVersion: string;
}

export interface ComparisonWorkbenchReadinessEvidence {
  readonly targetEditorSelected: true;
  readonly noVisibleQuickInput: true;
  readonly noVisibleDialog: true;
  readonly noVisibleModal: true;
  readonly rendererFramePointerUsable: true;
}

interface CacheProof {
  readonly protocol: typeof CACHE_PROOF_PROTOCOL;
  readonly requestedState: "resident";
  readonly fdatasyncApplied: true;
  readonly adviceAccepted: false;
  readonly verification: "linux-mincore";
  readonly pageSizeBytes: number;
  readonly totalPages: number;
  readonly residentPagesBefore: number;
  readonly residentPagesAfter: number;
  readonly identityStable: true;
  readonly verified: true;
}

interface StableSourceIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly nlink: bigint;
  readonly uid: bigint;
  readonly gid: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

interface SourceReceipt {
  readonly identity: StableSourceIdentity;
  readonly sha256: string;
}

interface ComparisonSample {
  readonly fixture: {
    readonly format: FixtureFormat;
    readonly rows: number;
    readonly columns: number;
    readonly bytes: number;
    readonly sha256: string;
  };
  readonly diagnostic: {
    readonly boundary: typeof COMPARISON_BOUNDARY;
    readonly warmupCompleted: true;
    readonly diagnosticDurationMs: number;
    readonly cacheProof: CacheProof;
    readonly readiness: {
      readonly grid: ComparisonGridReadinessEvidence;
      readonly workbench: ComparisonWorkbenchReadinessEvidence;
    };
  };
  readonly proofs: {
    readonly telemetryDisabled: true;
    readonly sourceIdentityStable: true;
    readonly sourceUnchanged: true;
  };
}

interface Workbench {
  readonly page: Page;
}

interface ComparisonActionResult {
  readonly diagnosticDurationMs: number;
  readonly readiness: {
    readonly grid: ComparisonGridReadinessEvidence;
    readonly workbench: ComparisonWorkbenchReadinessEvidence;
  };
  readonly cacheProof: CacheProof | null;
}

export async function run(): Promise<InstalledPerformanceArtifactReceipt> {
  const phase = comparisonPhase(requiredEnvironment("OPEN_WRANGLER_TEST_PHASE"));
  const runId = requiredEnvironment("OPEN_WRANGLER_TEST_RUN_ID");
  const testPython = requiredEnvironment("OPEN_WRANGLER_TEST_PYTHON");
  const productKey = PHASES[phase];
  const workspace = soleFileWorkspace();
  const manifest = readFixtureManifest(path.join(workspace, "performance-fixtures.json"));
  assert.equal(manifest.smoke, true, "The comparison host is restricted to smoke-sized fixtures.");
  assertTelemetryDisabled();

  recordProgress("comparison:configured-python-provenance");
  const configuredPythonEnvironment = await configuredPythonEnvironmentProvenance(testPython);
  recordProgress("comparison:workbench-connect");
  const workbench = await connectToEditorWorkbench();
  await waitForWorkbenchReady(workbench.page);

  let samples: readonly ComparisonSample[] | undefined;
  let diagnosticError: unknown;
  let closeError: unknown;
  try {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await waitForNoEditorTabs();

    recordProgress("comparison:warmup:start");
    await runWarmup({
      productKey,
      workbench,
      source: path.join(workspace, "warmup.csv")
    });
    recordProgress("comparison:warmup:complete");
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await waitForNoEditorTabs();
    recordProgress("comparison:warmup:closed");

    const diagnostics: ComparisonSample[] = [];
    for (const format of ["csv", "parquet"] as const) {
      recordProgress(`comparison:${format}:prepare`);
      diagnostics.push(
        await runFixtureDiagnostic({
          productKey,
          workbench,
          testPython,
          workspace,
          fixture: manifest.fixtures[format]
        })
      );
      recordProgress(`comparison:${format}:complete`);
    }
    samples = Object.freeze(diagnostics);
  } catch (error) {
    diagnosticError = error;
  } finally {
    try {
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await waitForNoEditorTabs();
    } catch (error) {
      closeError = error;
    }
  }

  if (diagnosticError !== undefined && closeError !== undefined) {
    throw new AggregateError(
      [diagnosticError, closeError],
      "Comparison feasibility diagnostic failed and its editor tabs could not close."
    );
  }
  if (diagnosticError !== undefined) throw diagnosticError;
  if (closeError !== undefined) throw closeError;
  assert.ok(samples && samples.length === 2, "The product phase must complete exactly two diagnostic launches.");

  const fragment = {
    protocol: COMPARISON_PRODUCT_FRAGMENT_PROTOCOL,
    runId,
    phase,
    productKey,
    configuredPythonEnvironment,
    samples
  };
  const receipt = publishInstalledPerformanceFragment(path.join(workspace, "results", `${phase}.json`), fragment);
  recordProgress("comparison:fragment-published");
  return receipt;
}

async function runWarmup({
  productKey,
  workbench,
  source
}: {
  productKey: ProductKey;
  workbench: Workbench;
  source: string;
}): Promise<void> {
  const expectedBytes = Buffer.from("c00,c01\n0,1\n1,2\n", "utf8");
  assert.deepEqual(readFileSync(source), expectedBytes, "The deterministic warm-up source changed before launch.");
  await openThroughVisibleExplorerAction({
    productKey,
    workbench,
    source,
    format: "csv",
    timed: false
  });
  assert.deepEqual(readFileSync(source), expectedBytes, "The deterministic warm-up source changed during launch.");
}

async function runFixtureDiagnostic({
  productKey,
  workbench,
  testPython,
  workspace,
  fixture
}: {
  productKey: ProductKey;
  workbench: Workbench;
  testPython: string;
  workspace: string;
  fixture: InstalledPerformanceFixtureEntry;
}): Promise<ComparisonSample> {
  const format = fixture.format;
  const source = path.join(workspace, "fixtures", fixture.fileName);
  const before = await captureSourceReceipt(source, fixture);

  let result: ComparisonActionResult | undefined;
  let diagnosticError: unknown;
  let closeError: unknown;
  try {
    result = await openThroughVisibleExplorerAction({
      productKey,
      workbench,
      source,
      format,
      timed: true,
      beforeTimedAction: () => assertSourceReceipt(source, fixture, before),
      prepareCache: () => prepareResidentSourceCache(testPython, workspace, source)
    });
    await assertSourceReceipt(source, fixture, before);
  } catch (error) {
    diagnosticError = error;
  } finally {
    try {
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await waitForNoEditorTabs();
    } catch (error) {
      closeError = error;
    }
  }

  if (diagnosticError !== undefined && closeError !== undefined) {
    throw new AggregateError(
      [diagnosticError, closeError],
      `The ${format} comparison diagnostic failed and its created tabs could not close.`
    );
  }
  if (diagnosticError !== undefined) throw diagnosticError;
  if (closeError !== undefined) throw closeError;
  assert.ok(result, `The ${format} comparison sample did not produce readiness evidence.`);
  assert.ok(result.cacheProof, `The ${format} comparison sample did not retain its resident-cache proof.`);

  return Object.freeze({
    fixture: Object.freeze({
      format,
      rows: fixture.rows,
      columns: fixture.columns,
      bytes: fixture.bytes,
      sha256: fixture.sha256
    }),
    diagnostic: Object.freeze({
      boundary: COMPARISON_BOUNDARY,
      warmupCompleted: true,
      diagnosticDurationMs: result.diagnosticDurationMs,
      cacheProof: result.cacheProof,
      readiness: result.readiness
    }),
    proofs: Object.freeze({
      telemetryDisabled: true,
      sourceIdentityStable: true,
      sourceUnchanged: true
    })
  });
}

async function openThroughVisibleExplorerAction({
  productKey,
  workbench,
  source,
  format,
  timed,
  beforeTimedAction,
  prepareCache
}: {
  productKey: ProductKey;
  workbench: Workbench;
  source: string;
  format: FixtureFormat;
  timed: boolean;
  beforeTimedAction?: () => Promise<void>;
  prepareCache?: () => CacheProof;
}): Promise<ComparisonActionResult> {
  const sourceUri = vscode.Uri.file(source);
  await vscode.commands.executeCommand("vscode.open", sourceUri, {
    preview: false,
    viewColumn: vscode.ViewColumn.One
  });
  await waitFor(
    () => allEditorTabs().some((tab) => tabInputUri(tab.input)?.toString() === sourceUri.toString()),
    WORKBENCH_TIMEOUT_MS,
    `the ${format} source editor`
  );
  const sourceTab = selectedComparisonSourceTab(sourceUri);

  await workbench.page.bringToFront();
  await workbench.page.keyboard.press("Control+Shift+E");
  const explorerItem = await waitForVisibleExplorerItem(workbench.page, path.basename(source));
  await workbench.page.keyboard.press("Escape");
  await explorerItem.click({ button: "right" });

  const actionName = ACTIONS[productKey];
  const action = await waitForVisibleMenuAction(workbench.page, actionName);
  // VS Code intentionally delays a context-menu item's mouse-up handler so
  // the click that opened the menu cannot also activate the action.
  const { baselineFrames, cacheProof } = await prepareComparisonAction({
    beforeAction: beforeTimedAction,
    captureFrames: () => comparisonFrames(workbench.page),
    waitForActivationDelay: () => workbench.page.waitForTimeout(200),
    prepareCache
  });
  const baselinePages = new Set([...baselineFrames].map((frame) => frame.page()));
  const started = performance.now();
  await action.click();
  const gridReadiness = await waitForGenericGridReadiness(workbench.page, baselineFrames, baselinePages);
  const workbenchReadiness = await comparisonWorkbenchReadiness(
    workbench.page,
    sourceTab,
    gridReadiness.rendererFramePointerUsable
  );
  const diagnosticDurationMs = timed ? roundMilliseconds(performance.now() - started) : 0.001;
  return Object.freeze({
    diagnosticDurationMs,
    readiness: Object.freeze({
      grid: gridReadiness.grid,
      workbench: workbenchReadiness
    }),
    cacheProof
  });
}

async function waitForVisibleExplorerItem(page: Page, fileName: string): Promise<Locator> {
  const deadline = Date.now() + WORKBENCH_TIMEOUT_MS;
  let expandedFixtures = false;
  do {
    const visibleTrees: Locator[] = [];
    for (const tree of await page.getByRole("tree").all()) {
      if (!(await tree.isVisible().catch(() => false))) continue;
      const accessibleName = normalizeText((await tree.getAttribute("aria-label")) ?? "");
      if (accessibleName === "Files Explorer") visibleTrees.push(tree);
    }
    const tree = requireUniqueComparisonMatch(visibleTrees, "the visible Files Explorer");
    if (tree) {
      const matchingItems: Locator[] = [];
      for (const item of await tree.getByRole("treeitem").all()) {
        if (!(await item.isVisible().catch(() => false))) continue;
        const text = await item.innerText().catch(() => "");
        const label = (await item.getAttribute("aria-label").catch(() => null)) ?? "";
        if (comparisonExplorerItemMatches(fileName, text, label)) matchingItems.push(item);
      }
      const exactItem = requireUniqueComparisonMatch(
        matchingItems,
        `the exact visible Files Explorer resource ${JSON.stringify(fileName)}`
      );
      if (exactItem) return exactItem;

      if (!expandedFixtures) {
        for (const item of await tree.getByRole("treeitem").all()) {
          if (!(await item.isVisible().catch(() => false))) continue;
          const text = normalizeText(await item.innerText().catch(() => ""));
          const label = normalizeText((await item.getAttribute("aria-label").catch(() => null)) ?? "");
          if (text === "fixtures" || label === "fixtures" || label.startsWith("fixtures ")) {
            await item.click();
            await item.press("ArrowRight");
            expandedFixtures = true;
            break;
          }
        }
      }
    }
    await page.waitForTimeout(25);
  } while (Date.now() < deadline);
  throw new Error(`The visible Files Explorer did not expose ${JSON.stringify(fileName)}.`);
}

async function waitForVisibleMenuAction(page: Page, actionName: string): Promise<Locator> {
  const action = page.getByRole("menuitem", { name: actionName, exact: true }).last();
  await action.waitFor({ state: "visible", timeout: WORKBENCH_TIMEOUT_MS });
  return action;
}

function selectedComparisonSourceTab(sourceUri: vscode.Uri): vscode.Tab {
  const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
  assert.ok(activeTab, "The comparison source must own the active editor tab before action dispatch.");
  assert.equal(
    tabInputUri(activeTab.input)?.toString(),
    sourceUri.toString(),
    "The exact comparison source must remain selected before action dispatch."
  );
  return activeTab;
}

async function comparisonWorkbenchReadiness(
  page: Page,
  sourceTab: vscode.Tab,
  rendererFramePointerUsable: boolean
): Promise<ComparisonWorkbenchReadinessEvidence> {
  const obstructions = await visibleComparisonWorkbenchObstructions(page);
  const targetTab = vscode.window.tabGroups.activeTabGroup.activeTab;
  const targetEditorSelected =
    targetTab !== undefined &&
    targetTab !== sourceTab &&
    (targetTab.input instanceof vscode.TabInputCustom || targetTab.input instanceof vscode.TabInputWebview);
  return buildComparisonWorkbenchReadinessEvidence({
    targetEditorSelected,
    visibleQuickInputs: obstructions.visibleQuickInputs,
    visibleDialogs: obstructions.visibleDialogs,
    visibleModals: obstructions.visibleModals,
    rendererFramePointerUsable
  });
}

async function comparisonWorkbenchIsUnobstructed(page: Page): Promise<boolean> {
  const state = await visibleComparisonWorkbenchObstructions(page);
  return state.visibleQuickInputs === 0 && state.visibleDialogs === 0 && state.visibleModals === 0;
}

async function visibleComparisonWorkbenchObstructions(page: Page): Promise<{
  readonly visibleQuickInputs: number;
  readonly visibleDialogs: number;
  readonly visibleModals: number;
}> {
  const [visibleQuickInputs, visibleDialogs, visibleModals] = await Promise.all([
    boundedVisibleLocatorCount(page.locator(".quick-input-widget"), "Quick Input"),
    boundedVisibleLocatorCount(page.getByRole("dialog"), "dialog"),
    boundedVisibleLocatorCount(page.locator('.monaco-dialog-box, .monaco-modal-dialog, [aria-modal="true"]'), "modal")
  ]);
  return Object.freeze({ visibleQuickInputs, visibleDialogs, visibleModals });
}

async function boundedVisibleLocatorCount(locator: Locator, label: string): Promise<number> {
  const candidates = await locator.all();
  assert.ok(candidates.length <= 64, `Comparison workbench ${label} discovery exceeded 64 candidates.`);
  let visible = 0;
  for (const candidate of candidates) {
    if (!(await candidate.isVisible().catch(() => false))) continue;
    const box = await candidate.boundingBox().catch(() => null);
    if (box && box.width > 0 && box.height > 0) visible += 1;
  }
  return visible;
}

export function buildComparisonWorkbenchReadinessEvidence({
  targetEditorSelected,
  visibleQuickInputs,
  visibleDialogs,
  visibleModals,
  rendererFramePointerUsable
}: {
  readonly targetEditorSelected: boolean;
  readonly visibleQuickInputs: number;
  readonly visibleDialogs: number;
  readonly visibleModals: number;
  readonly rendererFramePointerUsable: boolean;
}): ComparisonWorkbenchReadinessEvidence {
  for (const [value, label] of [
    [visibleQuickInputs, "Quick Input"],
    [visibleDialogs, "dialog"],
    [visibleModals, "modal"]
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 64) {
      throw new TypeError(`Comparison workbench ${label} count must be between zero and 64.`);
    }
  }
  if (targetEditorSelected !== true) {
    throw new Error("Comparison readiness requires the launched target editor to be selected.");
  }
  if (visibleQuickInputs !== 0 || visibleDialogs !== 0 || visibleModals !== 0) {
    throw new Error("Comparison readiness requires an unobstructed workbench without visible prompts or dialogs.");
  }
  if (rendererFramePointerUsable !== true) {
    throw new Error("Comparison readiness requires an unoccluded pointer-usable renderer frame.");
  }
  return Object.freeze({
    targetEditorSelected: true,
    noVisibleQuickInput: true,
    noVisibleDialog: true,
    noVisibleModal: true,
    rendererFramePointerUsable: true
  });
}

async function waitForGenericGridReadiness(
  workbench: Page,
  baselineFrames: ReadonlySet<Frame>,
  baselinePages: ReadonlySet<Page>
): Promise<{
  readonly grid: ComparisonGridReadinessEvidence;
  readonly rendererFramePointerUsable: true;
}> {
  const deadline = Date.now() + GRID_TIMEOUT_MS;
  const stalledFrames = new Set<Frame>();
  const observedChildFrames = new Set<Frame>();
  const observedTopLevelPages = new Set<Page>();
  let maxDiscoveredFrames = 0;
  let completedNullProbes = 0;
  let rejectedProbes = 0;
  let timedOutProbes = 0;
  let obstructedPolls = 0;
  do {
    assert.equal(workbench.isClosed(), false, "The official VS Code workbench closed during grid discovery.");
    if (!(await comparisonWorkbenchIsUnobstructed(workbench))) {
      obstructedPolls += 1;
      await workbench.waitForTimeout(20);
      continue;
    }
    const browser = workbench.context().browser();
    assert.ok(browser, "The official VS Code workbench is not attached to a browser.");
    assert.equal(browser.isConnected(), true, "The official VS Code CDP connection closed during grid discovery.");
    const discoveredFrames = comparisonFrames(workbench);
    maxDiscoveredFrames = Math.max(maxDiscoveredFrames, discoveredFrames.length);
    for (const frame of discoveredFrames) {
      const parentFrame = frame.parentFrame();
      const page = frame.page();
      if (
        stalledFrames.has(frame) ||
        !isPostClickComparisonSurface(frame, baselineFrames, parentFrame, page, baselinePages)
      ) {
        continue;
      }
      if (parentFrame) observedChildFrames.add(frame);
      else observedTopLevelPages.add(page);
      const probe = await runComparisonFrameProbeWithRetry(
        () => observeFrameReadiness(frame),
        FRAME_PROBE_TIMEOUT_MS,
        FRAME_PROBE_RETRIES,
        () => workbench.waitForTimeout(FRAME_PROBE_RETRY_DELAY_MS)
      );
      if (probe.status === "timed-out") {
        timedOutProbes += 1;
        stalledFrames.add(frame);
      } else if (probe.status === "completed" && probe.value) {
        if (!(await frameChainIsVisibleAndPointerUsable(frame))) continue;
        if (!(await comparisonWorkbenchIsUnobstructed(workbench))) {
          obstructedPolls += 1;
          continue;
        }
        return Object.freeze({
          grid: probe.value,
          rendererFramePointerUsable: true
        });
      } else if (probe.status === "completed") {
        completedNullProbes += 1;
      } else {
        rejectedProbes += 1;
      }
    }
    await workbench.waitForTimeout(20);
  } while (Date.now() < deadline);
  throw new Error(
    "No stable visible generic ARIA grid or table exposed the deterministic comparison headers and cells. " +
      `Structural counts: ${JSON.stringify({
        baselineFrames: baselineFrames.size,
        baselinePages: baselinePages.size,
        maxDiscoveredFrames,
        postClickChildFrames: observedChildFrames.size,
        postClickTopLevelPages: observedTopLevelPages.size,
        completedNullProbes,
        rejectedProbes,
        timedOutProbes,
        obstructedPolls,
        quarantinedFrames: stalledFrames.size
      })}`
  );
}

async function observeFrameReadiness(frame: Frame): Promise<ComparisonGridReadinessEvidence | null> {
  if (!(await frameChainIsVisibleAndPointerUsable(frame))) return null;
  return frame.evaluate(observeComparisonGridReadiness, DEFAULT_COMPARISON_GRID_READINESS_INPUT);
}

async function frameChainIsVisibleAndPointerUsable(frame: Frame): Promise<boolean> {
  let current = frame;
  while (current.parentFrame()) {
    const host = await current.frameElement();
    if (!(await host.isVisible())) return false;
    const pointerUsable = await host.evaluate((node) => {
      if (!node.isConnected || !("getBoundingClientRect" in node) || typeof node.getBoundingClientRect !== "function") {
        return false;
      }
      const document = node.ownerDocument;
      if (!document) return false;
      const element = node as typeof node & {
        getBoundingClientRect(): {
          readonly top: number;
          readonly right: number;
          readonly bottom: number;
          readonly left: number;
          readonly width: number;
          readonly height: number;
        };
      };
      const rectangle = element.getBoundingClientRect();
      const view = document.defaultView;
      if (!view || rectangle.width <= 0 || rectangle.height <= 0) return false;
      const left = Math.max(0, rectangle.left);
      const right = Math.min(view.innerWidth, rectangle.right);
      const top = Math.max(0, rectangle.top);
      const bottom = Math.min(view.innerHeight, rectangle.bottom);
      if (right <= left || bottom <= top) return false;
      const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
      return hit !== null && (hit === element || element.contains(hit));
    });
    if (!pointerUsable) return false;
    current = current.parentFrame() as Frame;
  }
  return true;
}

function comparisonFrames(workbench: Page): Frame[] {
  const browser = workbench.context().browser();
  const discovered = browser?.contexts().flatMap((context) => context.pages()) ?? [workbench];
  const pages = [workbench, ...discovered.filter((page) => page !== workbench && !page.isClosed())];
  return [...new Set(pages)].flatMap((page) => page.frames());
}

async function connectToEditorWorkbench(): Promise<Workbench> {
  const cdpPort = Number(requiredEnvironment("OPEN_WRANGLER_EDITOR_CDP_PORT"));
  assert.ok(Number.isInteger(cdpPort) && cdpPort > 0, "Comparison requires a private CDP port.");
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  const deadline = Date.now() + WORKBENCH_TIMEOUT_MS;
  do {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if (
          !page.isClosed() &&
          page.url().includes("workbench") &&
          (await page
            .locator("body")
            .isVisible()
            .catch(() => false))
        ) {
          return Object.freeze({ page });
        }
      }
    }
    await delay(25);
  } while (Date.now() < deadline);
  throw new Error("The private CDP endpoint did not expose the official VS Code workbench.");
}

async function waitForWorkbenchReady(page: Page): Promise<void> {
  await waitFor(
    async () => {
      await page.bringToFront();
      await page.keyboard.press("Control+Shift+E");
      for (const tree of await page.getByRole("tree").all()) {
        if (!(await tree.isVisible().catch(() => false))) continue;
        const name = ((await tree.getAttribute("aria-label")) ?? "").trim();
        if (/(?:files|explorer)/iu.test(name)) return true;
      }
      return false;
    },
    WORKBENCH_TIMEOUT_MS,
    "the visible Files Explorer"
  );
}

function prepareResidentSourceCache(testPython: string, workspace: string, source: string): CacheProof {
  const output = execFileSync(
    testPython,
    comparisonWarmCacheArguments(path.join(workspace, "benchmarks", "source_cache_control.py"), source),
    {
      encoding: "utf8",
      maxBuffer: MAX_PRIVATE_JSON_BYTES,
      timeout: 30_000,
      windowsHide: true
    }
  );
  const parsed = parseStrictJson(output, { maxBytes: MAX_PRIVATE_JSON_BYTES });
  assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed));
  const proof = parsed as Record<string, unknown>;
  assertExactKeys(
    proof,
    [
      "protocol",
      "requestedState",
      "fdatasyncApplied",
      "adviceAccepted",
      "verification",
      "pageSizeBytes",
      "totalPages",
      "residentPagesBefore",
      "residentPagesAfter",
      "identityStable",
      "verified"
    ],
    "resident source-cache proof"
  );
  assert.equal(proof.protocol, CACHE_PROOF_PROTOCOL);
  assert.equal(proof.requestedState, "resident");
  assert.equal(proof.fdatasyncApplied, true);
  assert.equal(proof.adviceAccepted, false);
  assert.equal(proof.verification, "linux-mincore");
  assert.ok(Number.isSafeInteger(proof.pageSizeBytes) && Number(proof.pageSizeBytes) > 0);
  assert.ok(Number.isSafeInteger(proof.totalPages) && Number(proof.totalPages) > 0);
  assert.ok(
    Number.isSafeInteger(proof.residentPagesBefore) &&
      Number(proof.residentPagesBefore) >= 0 &&
      Number(proof.residentPagesBefore) <= Number(proof.totalPages)
  );
  assert.equal(proof.residentPagesAfter, proof.totalPages);
  assert.equal(proof.identityStable, true);
  assert.equal(proof.verified, true);
  return proof as unknown as CacheProof;
}

async function configuredPythonEnvironmentProvenance(testPython: string): Promise<ConfiguredPythonEnvironment> {
  const output = execFileSync(testPython, ["-I", "-c", comparisonRuntimeProbeSource()], {
    encoding: "utf8",
    maxBuffer: MAX_PRIVATE_JSON_BYTES,
    timeout: 30_000,
    windowsHide: true
  });
  const parsed = parseStrictJson(output, { maxBytes: MAX_PRIVATE_JSON_BYTES });
  assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed));
  const probe = parsed as Record<string, unknown>;
  assertExactKeys(
    probe,
    [
      "pythonVersion",
      "pythonImplementation",
      "installedPandasVersion",
      "installedPyarrowVersion",
      "installedJupyterCoreVersion",
      "installedIpykernelVersion"
    ],
    "comparison configured Python environment provenance"
  );
  assert.equal(probe.pythonImplementation, "CPython");
  assert.match(String(probe.pythonVersion), /^(?:3)\.(?:10|11|12|13|14)\.(?:0|[1-9]\d*)$/u);
  for (const key of [
    "installedPandasVersion",
    "installedPyarrowVersion",
    "installedJupyterCoreVersion",
    "installedIpykernelVersion"
  ]) {
    assert.equal(typeof probe[key], "string");
    assert.match(String(probe[key]), PACKAGE_VERSION);
  }
  return Object.freeze({
    pythonVersion: String(probe.pythonVersion),
    pythonImplementation: "CPython",
    pythonExecutableSha256: await sha256(testPython),
    installedPandasVersion: String(probe.installedPandasVersion),
    installedPyarrowVersion: String(probe.installedPyarrowVersion),
    installedJupyterCoreVersion: String(probe.installedJupyterCoreVersion),
    installedIpykernelVersion: String(probe.installedIpykernelVersion)
  });
}

function assertTelemetryDisabled(): void {
  const configuration = vscode.workspace.getConfiguration("telemetry");
  assert.equal(configuration.get("telemetryLevel"), "off", "The comparison profile must disable VS Code telemetry.");
}

function readFixtureManifest(manifestPath: string): InstalledPerformanceFixtureManifest {
  return decodeInstalledPerformanceFixtureManifest(
    parseStrictJson(readFileSync(manifestPath, "utf8"), {
      maxBytes: MAX_PRIVATE_JSON_BYTES
    })
  ) as InstalledPerformanceFixtureManifest;
}

async function captureSourceReceipt(source: string, fixture: InstalledPerformanceFixtureEntry): Promise<SourceReceipt> {
  const before = lstatSync(source, { bigint: true });
  requireSourceFile(before, fixture);
  const digest = await sha256(source);
  const after = lstatSync(source, { bigint: true });
  requireSourceFile(after, fixture);
  assert.deepEqual(stableSourceIdentity(after), stableSourceIdentity(before), "The source changed while it was read.");
  assert.equal(digest, fixture.sha256, "The source content does not match its deterministic fixture manifest.");
  return Object.freeze({
    identity: Object.freeze(stableSourceIdentity(after)),
    sha256: digest
  });
}

async function assertSourceReceipt(
  source: string,
  fixture: InstalledPerformanceFixtureEntry,
  receipt: SourceReceipt
): Promise<void> {
  const before = lstatSync(source, { bigint: true });
  requireSourceFile(before, fixture);
  assert.deepEqual(stableSourceIdentity(before), receipt.identity, "The source identity changed during comparison.");
  const digest = await sha256(source);
  const after = lstatSync(source, { bigint: true });
  requireSourceFile(after, fixture);
  assert.deepEqual(stableSourceIdentity(after), receipt.identity, "The source identity changed during comparison.");
  assert.equal(digest, receipt.sha256, "The source content changed during comparison.");
}

function requireSourceFile(metadata: BigIntStats, fixture: InstalledPerformanceFixtureEntry): void {
  assert.equal(metadata.isFile(), true, "The deterministic source must remain a regular file.");
  assert.equal(metadata.isSymbolicLink(), false, "The deterministic source must not be a symbolic link.");
  assert.equal(metadata.nlink, 1n, "The deterministic source must retain one link.");
  assert.equal(metadata.size, BigInt(fixture.bytes), "The deterministic source size changed.");
}

function stableSourceIdentity(metadata: BigIntStats): StableSourceIdentity {
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
    nlink: metadata.nlink,
    uid: metadata.uid,
    gid: metadata.gid,
    size: metadata.size,
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs
  };
}

async function sha256(file: string): Promise<string> {
  const digest = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return digest.digest("hex");
}

function allEditorTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap((group) => [...group.tabs]);
}

async function waitForNoEditorTabs(): Promise<void> {
  await waitFor(() => allEditorTabs().length === 0, EDITOR_CLOSE_TIMEOUT_MS, "all comparison editor tabs to close");
}

function tabInputUri(input: unknown): vscode.Uri | undefined {
  if (input instanceof vscode.TabInputText) return input.uri;
  if (input instanceof vscode.TabInputCustom) return input.uri;
  if (input instanceof vscode.TabInputNotebook) return input.uri;
  return undefined;
}

function comparisonPhase(value: string): ComparisonPhase {
  assert.ok(Object.hasOwn(PHASES, value), "The comparison phase must identify exactly one product.");
  return value as ComparisonPhase;
}

function soleFileWorkspace(): string {
  const folders = vscode.workspace.workspaceFolders;
  assert.equal(folders?.length, 1, "Comparison requires exactly one private workspace.");
  const folder = folders?.[0];
  assert.ok(folder && folder.uri.scheme === "file", "Comparison requires one local file workspace.");
  return folder.uri.fsPath;
}

function requiredEnvironment(key: string): string {
  const value = process.env[key];
  assert.ok(value && !/[\0\r\n]/u.test(value), `Comparison requires ${key}.`);
  return value;
}

function recordProgress(checkpoint: string): void {
  writeAcceptanceProgressCheckpoint(requiredEnvironment("OPEN_WRANGLER_TEST_PROGRESS"), {
    protocol: ACCEPTANCE_PROGRESS_PROTOCOL,
    runId: requiredEnvironment("OPEN_WRANGLER_TEST_RUN_ID"),
    phase: requiredEnvironment("OPEN_WRANGLER_TEST_PHASE"),
    checkpoint
  });
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await predicate()) return;
    await delay(20);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}.`);
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  assert.deepEqual(actual, canonical, `${label} has missing or unknown fields.`);
}

function normalizeText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

export function comparisonRuntimeProbeSource(): string {
  return [
    "import json, platform",
    "import ipykernel, jupyter_core, pandas, pyarrow",
    "print(json.dumps({",
    "'pythonVersion': platform.python_version(),",
    "'pythonImplementation': platform.python_implementation(),",
    "'installedPandasVersion': pandas.__version__,",
    "'installedPyarrowVersion': pyarrow.__version__,",
    "'installedJupyterCoreVersion': jupyter_core.__version__,",
    "'installedIpykernelVersion': ipykernel.__version__",
    "}, sort_keys=True))"
  ].join("\n");
}

export function comparisonWarmCacheArguments(script: string, source: string): string[] {
  return [script, "--source", source, "--mode", "warm"];
}

export function comparisonExplorerItemMatches(fileName: string, text: string, label: string): boolean {
  return normalizeText(text) === fileName || normalizeText(label) === fileName;
}

export function requireUniqueComparisonMatch<T>(matches: readonly T[], label: string): T | undefined {
  if (matches.length > 1) {
    throw new Error(`Comparison discovery found more than one match for ${label}.`);
  }
  return matches[0];
}

export function isPostClickComparisonSurface<TFrame, TPage>(
  frame: TFrame,
  baselineFrames: ReadonlySet<TFrame>,
  parentFrame: TFrame | null,
  page: TPage,
  baselinePages: ReadonlySet<TPage>
): boolean {
  return !baselineFrames.has(frame) && (parentFrame !== null || !baselinePages.has(page));
}

export async function prepareComparisonAction<TFrame, TProof>({
  beforeAction,
  captureFrames,
  waitForActivationDelay,
  prepareCache
}: {
  beforeAction?: () => Promise<void>;
  captureFrames: () => readonly TFrame[];
  waitForActivationDelay: () => Promise<void>;
  prepareCache?: () => TProof;
}): Promise<{ readonly baselineFrames: ReadonlySet<TFrame>; readonly cacheProof: TProof | null }> {
  await beforeAction?.();
  await waitForActivationDelay();
  const cacheProof = prepareCache?.() ?? null;
  const baselineFrames = new Set(captureFrames());
  return Object.freeze({ baselineFrames, cacheProof });
}

export async function runBoundedComparisonFrameProbe<T>(
  probe: () => Promise<T>,
  timeoutMs: number
): Promise<
  | { readonly status: "completed"; readonly value: T }
  | { readonly status: "rejected" }
  | { readonly status: "timed-out" }
> {
  if (typeof probe !== "function" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1_000) {
    throw new TypeError("Comparison frame probe requires one callback and a 1-1000 ms deadline.");
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      probe().then(
        (value) => Object.freeze({ status: "completed" as const, value }),
        () => Object.freeze({ status: "rejected" as const })
      ),
      new Promise<{ readonly status: "timed-out" }>((resolve) => {
        timer = setTimeout(() => resolve(Object.freeze({ status: "timed-out" as const })), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runComparisonFrameProbeWithRetry<T>(
  probe: () => Promise<T>,
  timeoutMs: number,
  retries: number,
  waitForRetry: () => Promise<void>
): Promise<
  | { readonly status: "completed"; readonly value: T }
  | { readonly status: "rejected" }
  | { readonly status: "timed-out" }
> {
  if (typeof waitForRetry !== "function" || !Number.isSafeInteger(retries) || retries < 0 || retries > 3) {
    throw new TypeError("Comparison frame retries require one wait callback and zero to three retries.");
  }
  let outcome = await runBoundedComparisonFrameProbe(probe, timeoutMs);
  for (let retry = 0; outcome.status === "timed-out" && retry < retries; retry += 1) {
    await waitForRetry();
    outcome = await runBoundedComparisonFrameProbe(probe, timeoutMs);
  }
  return outcome;
}

function roundMilliseconds(value: number): number {
  assert.ok(Number.isFinite(value) && value > 0 && value <= 300_000);
  return Math.max(0.001, Math.round(value * 1_000) / 1_000);
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}
