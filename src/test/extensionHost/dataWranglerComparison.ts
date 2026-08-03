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
const DATA_WRANGLER_FIRST_USE_SETUP_PHASE = "comparison-data-wrangler-setup" as const;
const OPEN_WRANGLER_FIRST_USE_SETUP_PHASE = "comparison-open-wrangler-setup" as const;
const ACTIONS = Object.freeze({
  "open-wrangler": "Open in Open Wrangler",
  "data-wrangler": "Open in Data Wrangler"
} as const);
const MAX_PRIVATE_JSON_BYTES = 16 * 1024;
const WORKBENCH_TIMEOUT_MS = 20_000;
const GRID_TIMEOUT_MS = 120_000;
const FIRST_USE_RUNTIME_TIMEOUT_MS = 30_000;
const FRAME_PROBE_TIMEOUT_MS = 250;
const FRAME_PROBE_RETRY_DELAY_MS = 50;
const FRAME_PROBE_RETRIES = 1;
const EDITOR_CLOSE_TIMEOUT_MS = 15_000;
const PACKAGE_VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$/u;
const COMPARISON_RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const COMPARISON_RUNTIME_SELECTOR_ACCESSIBLE_NAME =
  /(?:^(?:(?:select|choose|pick|change) (?:a )?)?(?:(?:python )?(?:runtime|kernel|interpreter)|python environment)(?: selector| picker)?$|\b(?:select|choose|pick|change|connect to)\b.{0,48}\b(?:(?:python )?(?:runtime|kernel|interpreter)|python environment)\b)/iu;
const COMPARISON_LOCAL_INTERPRETER_CONNECTION_ACCESSIBLE_NAME = /^Connect using local Python interpreter(?:,|$)/iu;
const COMPARISON_RUNTIME_DIAGNOSTIC_ACCESSIBLE_NAME =
  /(?:python|kernel|runtime|interpreter|environment|jupyter|conda|venv|open wrangler comparison)/iu;

type DiagnosticComparisonPhase = keyof typeof PHASES;
type ComparisonPhase =
  DiagnosticComparisonPhase | typeof DATA_WRANGLER_FIRST_USE_SETUP_PHASE | typeof OPEN_WRANGLER_FIRST_USE_SETUP_PHASE;
type ProductKey = (typeof PHASES)[DiagnosticComparisonPhase];
type FixtureFormat = "csv" | "parquet";
type ComparisonRuntimeRole = "button" | "combobox" | "menuitem" | "option" | "radio" | "treeitem";

interface ComparisonRoleMatch {
  readonly locator: Locator;
  readonly frame: Frame;
  readonly role: ComparisonRuntimeRole;
}

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

export interface Workbench {
  readonly page: Page;
}

interface ComparisonFirstUseSetupInput {
  readonly productKey: ProductKey;
  readonly workbench: Workbench;
  readonly source: string;
  readonly kernelLabel?: string;
}

type ComparisonHostPhasePreparation =
  | { readonly kind: "setup-only" }
  | { readonly kind: "diagnostic"; readonly manifest: InstalledPerformanceFixtureManifest };

interface ComparisonActionResult {
  readonly diagnosticDurationMs: number;
  readonly readiness: {
    readonly grid: ComparisonGridReadinessEvidence;
    readonly workbench: ComparisonWorkbenchReadinessEvidence;
  };
  readonly cacheProof: CacheProof | null;
}

export async function run(): Promise<InstalledPerformanceArtifactReceipt | undefined> {
  const phase = comparisonPhase(requiredEnvironment("OPEN_WRANGLER_TEST_PHASE"));
  const runId = requiredEnvironment("OPEN_WRANGLER_TEST_RUN_ID");
  const testPython = requiredEnvironment("OPEN_WRANGLER_TEST_PYTHON");
  const productKey = comparisonProduct(phase);
  const workspace = soleFileWorkspace();
  assertTelemetryDisabled();

  recordProgress("comparison:workbench-connect");
  const workbench = await connectToEditorWorkbench();
  await waitForWorkbenchReady(workbench.page);

  const preparedPhase = await prepareComparisonHostPhase({ phase, productKey, runId, workspace, workbench });
  if (preparedPhase.kind === "setup-only") return undefined;
  const { manifest } = preparedPhase;

  recordProgress("comparison:configured-python-provenance");
  const configuredPythonEnvironment = await configuredPythonEnvironmentProvenance(testPython);

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

export async function prepareComparisonHostPhase(
  {
    phase,
    productKey,
    runId,
    workspace,
    workbench
  }: {
    readonly phase: ComparisonPhase;
    readonly productKey: ProductKey;
    readonly runId: string;
    readonly workspace: string;
    readonly workbench: Workbench;
  },
  {
    runFirstUseSetup = runProductFirstUseSetup,
    readManifest = readFixtureManifest
  }: {
    readonly runFirstUseSetup?: (input: ComparisonFirstUseSetupInput) => Promise<void>;
    readonly readManifest?: (manifestPath: string) => InstalledPerformanceFixtureManifest;
  } = {}
): Promise<ComparisonHostPhasePreparation> {
  if (phase === DATA_WRANGLER_FIRST_USE_SETUP_PHASE || phase === OPEN_WRANGLER_FIRST_USE_SETUP_PHASE) {
    await runFirstUseSetup({
      productKey,
      workbench,
      source: path.join(workspace, "warmup.csv"),
      ...(productKey === "data-wrangler" ? { kernelLabel: dataWranglerComparisonKernelLabel(runId) } : {})
    });
    return Object.freeze({ kind: "setup-only" });
  }

  const manifest = readManifest(path.join(workspace, "performance-fixtures.json"));
  assert.equal(manifest.smoke, true, "The comparison host is restricted to smoke-sized fixtures.");
  return Object.freeze({ kind: "diagnostic", manifest });
}

async function runWarmup({
  productKey,
  workbench,
  source,
  firstUseKernelLabel
}: {
  productKey: ProductKey;
  workbench: Workbench;
  source: string;
  firstUseKernelLabel?: string;
}): Promise<void> {
  const expectedBytes = Buffer.from("c00,c01\n0,1\n1,2\n", "utf8");
  assert.deepEqual(readFileSync(source), expectedBytes, "The deterministic warm-up source changed before launch.");
  await openThroughVisibleExplorerAction({
    productKey,
    workbench,
    source,
    format: "csv",
    timed: false,
    firstUseKernelLabel
  });
  assert.deepEqual(readFileSync(source), expectedBytes, "The deterministic warm-up source changed during launch.");
}

async function runProductFirstUseSetup({
  productKey,
  workbench,
  source,
  kernelLabel
}: {
  productKey: ProductKey;
  workbench: Workbench;
  source: string;
  kernelLabel?: string;
}): Promise<void> {
  let setupError: unknown;
  let closeError: unknown;
  try {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await waitForNoEditorTabs();
    recordProgress(`comparison:${productKey}-setup:start`);
    await runWarmup({
      productKey,
      workbench,
      source,
      firstUseKernelLabel: kernelLabel
    });
    recordProgress(`comparison:${productKey}-setup:grid-ready`);
  } catch (error) {
    setupError = error;
  } finally {
    try {
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await waitForNoEditorTabs();
    } catch (error) {
      closeError = error;
    }
  }
  if (setupError !== undefined && closeError !== undefined) {
    throw new AggregateError(
      [setupError, closeError],
      `${productKey} first-use setup failed and its editor tabs could not close.`
    );
  }
  if (setupError !== undefined) throw setupError;
  if (closeError !== undefined) throw closeError;
  recordProgress(`comparison:${productKey}-setup:closed`);
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
  prepareCache,
  firstUseKernelLabel
}: {
  productKey: ProductKey;
  workbench: Workbench;
  source: string;
  format: FixtureFormat;
  timed: boolean;
  beforeTimedAction?: () => Promise<void>;
  prepareCache?: () => CacheProof;
  firstUseKernelLabel?: string;
}): Promise<ComparisonActionResult> {
  const tabsBefore = Object.freeze([...allEditorTabs()]);
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
  if (firstUseKernelLabel !== undefined) {
    await waitFor(
      () => {
        const target = vscode.window.tabGroups.activeTabGroup.activeTab;
        return (
          target !== undefined &&
          target !== sourceTab &&
          (target.input instanceof vscode.TabInputCustom || target.input instanceof vscode.TabInputWebview)
        );
      },
      WORKBENCH_TIMEOUT_MS,
      "the selected Data Wrangler target editor"
    );
    recordProgress("comparison:data-wrangler-setup:runtime-selection");
    await selectDataWranglerFirstUseRuntime(workbench.page, firstUseKernelLabel, baselineFrames, baselinePages);
    recordProgress("comparison:data-wrangler-setup:runtime-selected");
  }
  const gridReadiness = await waitForGenericGridReadiness(workbench.page, baselineFrames, baselinePages);
  const workbenchReadiness = await comparisonWorkbenchReadiness(
    workbench.page,
    sourceTab,
    gridReadiness.rendererFramePointerUsable
  );
  const targetTab = vscode.window.tabGroups.activeTabGroup.activeTab;
  assert.ok(
    targetTab !== undefined &&
      targetTab !== sourceTab &&
      (targetTab.input instanceof vscode.TabInputCustom || targetTab.input instanceof vscode.TabInputWebview),
    "Comparison readiness requires the exact active target to be a created custom or webview editor."
  );
  const ownedTabs = comparisonTabsOpenedAfter(tabsBefore, allEditorTabs());
  assert.equal(ownedTabs.length, 2, "Each comparison launch must own exactly one source and one target editor tab.");
  assert.ok(
    ownedTabs.includes(sourceTab) && ownedTabs.includes(targetTab),
    "Each comparison lease must own its exact source and selected target tabs."
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

async function selectDataWranglerFirstUseRuntime(
  workbench: Page,
  kernelLabel: string,
  baselineFrames: ReadonlySet<Frame>,
  baselinePages: ReadonlySet<Page>
): Promise<void> {
  if (kernelLabel !== dataWranglerComparisonKernelLabel(requiredEnvironment("OPEN_WRANGLER_TEST_RUN_ID"))) {
    throw new Error("Data Wrangler first-use setup received a mis-correlated comparison kernel label.");
  }
  const deadline = Date.now() + FIRST_USE_RUNTIME_TIMEOUT_MS;
  let latestSelectorDiagnostics: readonly Record<string, unknown>[] = Object.freeze([]);
  try {
    await runDataWranglerRuntimeSelectionTopology({
      discoverOptions: () =>
        visibleComparisonRoleMatches(
          comparisonFrames(workbench),
          ["option", "menuitem", "treeitem", "radio", "button"],
          comparisonRuntimeOptionNamePattern(kernelLabel),
          "runtime option"
        ),
      discoverSelectors: async () => {
        const matches = await visibleComparisonRoleMatches(
          comparisonFrames(workbench),
          ["combobox", "button"],
          COMPARISON_RUNTIME_SELECTOR_ACCESSIBLE_NAME,
          "runtime selector"
        );
        latestSelectorDiagnostics = Object.freeze(
          await Promise.all(matches.map((candidate) => describeComparisonRoleMatch(candidate, workbench)))
        );
        return prioritizeDataWranglerRuntimeSelectors(matches, (candidate) => {
          if (
            isPostClickComparisonSurface(
              candidate.frame,
              baselineFrames,
              candidate.frame.parentFrame(),
              candidate.frame.page(),
              baselinePages
            )
          ) {
            return "post-click";
          }
          return candidate.frame === workbench.mainFrame() ? "workbench-main" : "other";
        });
      },
      discoverLocalInterpreterConnections: async () => {
        const matches = await visibleComparisonRoleMatches(
          comparisonFrames(workbench),
          ["option", "menuitem", "treeitem", "radio", "button"],
          COMPARISON_LOCAL_INTERPRETER_CONNECTION_ACCESSIBLE_NAME,
          "local Python interpreter connection"
        );
        return prioritizeDataWranglerRuntimeSelectors(
          matches,
          (candidate) =>
            isPostClickComparisonSurface(
              candidate.frame,
              baselineFrames,
              candidate.frame.parentFrame(),
              candidate.frame.page(),
              baselinePages
            )
              ? "post-click"
              : candidate.frame === workbench.mainFrame()
                ? "workbench-main"
                : "other",
          { allowWorkbenchMainFallback: true }
        );
      },
      activate: (candidate) => candidate.locator.click(),
      waitForRetry: () => workbench.waitForTimeout(25),
      isWithinDeadline: () => {
        assert.equal(workbench.isClosed(), false, "The official VS Code workbench closed during runtime selection.");
        return Date.now() < deadline;
      }
    });
  } catch (error) {
    const relatedControls = await visibleComparisonRoleMatches(
      comparisonFrames(workbench),
      ["option", "menuitem", "treeitem", "radio", "button", "combobox"],
      COMPARISON_RUNTIME_DIAGNOSTIC_ACCESSIBLE_NAME,
      "runtime diagnostic control"
    );
    const publicLabels = [
      ...new Set(
        await Promise.all(
          relatedControls.map(async (candidate) => (await comparisonLocatorAccessibility(candidate.locator)).label)
        )
      )
    ]
      .filter((label) => label.length > 0)
      .sort()
      .slice(0, 32);
    const message = error instanceof Error ? error.message : "Data Wrangler runtime selection failed.";
    throw new Error(
      `${message} Selector diagnostics: ${JSON.stringify(latestSelectorDiagnostics)}. ` +
        `Visible runtime-related public controls: ${JSON.stringify(publicLabels)}.`
    );
  }
}

async function visibleComparisonRoleMatches(
  frames: readonly Frame[],
  roles: readonly ComparisonRuntimeRole[],
  accessibleName: RegExp,
  description: string
): Promise<ComparisonRoleMatch[]> {
  const result: ComparisonRoleMatch[] = [];
  for (const frame of frames) {
    if (frame.isDetached()) continue;
    if (!(await frameChainIsVisibleAndPointerUsable(frame).catch(() => false))) continue;
    for (const role of roles) {
      const candidates = await frame
        .getByRole(role, { name: accessibleName })
        .all()
        .catch(() => [] as Locator[]);
      assert.ok(candidates.length <= 128, `Comparison ${description} discovery exceeded 128 ${role} candidates.`);
      for (const candidate of candidates) {
        if (!(await candidate.isVisible().catch(() => false))) continue;
        const box = await candidate.boundingBox().catch(() => null);
        if (!box || box.width <= 0 || box.height <= 0) continue;
        result.push(Object.freeze({ locator: candidate, frame, role }));
      }
    }
  }
  return result;
}

async function describeComparisonRoleMatch(
  match: ComparisonRoleMatch,
  workbench: Page
): Promise<Record<string, unknown>> {
  let frameDepth = 0;
  let current = match.frame;
  while (current.parentFrame()) {
    frameDepth += 1;
    current = current.parentFrame() as Frame;
  }
  const page = match.frame.page();
  const surface =
    page === workbench
      ? match.frame === workbench.mainFrame()
        ? "workbench-main"
        : "workbench-child"
      : match.frame.parentFrame()
        ? "auxiliary-child"
        : "auxiliary-top-level";
  const box = await match.locator.boundingBox().catch(() => null);
  return Object.freeze({
    role: match.role,
    label: (await comparisonLocatorAccessibility(match.locator)).label,
    surface,
    frameDepth,
    box: box
      ? Object.freeze({
          x: Math.round(box.x),
          y: Math.round(box.y),
          width: Math.round(box.width),
          height: Math.round(box.height)
        })
      : null
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

export async function comparisonWorkbenchReadiness(
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

async function visibleComparisonWorkbenchObstructions(page: Page): Promise<{
  readonly visibleQuickInputs: number;
  readonly visibleDialogs: number;
  readonly visibleModals: number;
  readonly visibleDialogLabels: readonly string[];
}> {
  const [visibleQuickInputs, visibleDialogSummary, visibleModals] = await Promise.all([
    boundedVisibleLocatorCount(page.locator(".quick-input-widget"), "Quick Input"),
    boundedVisibleLocatorSummary(page.getByRole("dialog"), "dialog", { ignoreNonModalNotifications: true }),
    boundedVisibleLocatorCount(page.locator('.monaco-dialog-box, .monaco-modal-dialog, [aria-modal="true"]'), "modal")
  ]);
  return Object.freeze({
    visibleQuickInputs,
    visibleDialogs: visibleDialogSummary.count,
    visibleModals,
    visibleDialogLabels: visibleDialogSummary.labels
  });
}

async function boundedVisibleLocatorCount(locator: Locator, label: string): Promise<number> {
  return (await boundedVisibleLocatorSummary(locator, label)).count;
}

async function boundedVisibleLocatorSummary(
  locator: Locator,
  label: string,
  { ignoreNonModalNotifications = false }: { readonly ignoreNonModalNotifications?: boolean } = {}
): Promise<{ readonly count: number; readonly labels: readonly string[] }> {
  const candidates = await locator.all();
  assert.ok(candidates.length <= 64, `Comparison workbench ${label} discovery exceeded 64 candidates.`);
  let visible = 0;
  const labels = new Set<string>();
  for (const candidate of candidates) {
    if (!(await candidate.isVisible().catch(() => false))) continue;
    const box = await candidate.boundingBox().catch(() => null);
    if (!box || box.width <= 0 || box.height <= 0) continue;
    const accessibility = await comparisonLocatorAccessibility(candidate);
    const normalized = accessibility.label;
    if (
      ignoreNonModalNotifications &&
      comparisonDialogLabelIsNonBlockingNotification(normalized, accessibility.ariaModal)
    ) {
      continue;
    }
    visible += 1;
    labels.add(normalized.length > 0 ? normalized : "(unnamed)");
  }
  return Object.freeze({ count: visible, labels: Object.freeze([...labels].sort()) });
}

async function comparisonLocatorAccessibility(
  candidate: Locator
): Promise<{ readonly label: string; readonly ariaModal: string | null }> {
  const accessibility = await candidate
    .evaluate((element) => {
      const direct = element.getAttribute("aria-label") ?? element.getAttribute("title");
      if (direct) return { label: direct, ariaModal: element.getAttribute("aria-modal") };
      const labelledBy = element.getAttribute("aria-labelledby");
      const labelledText = labelledBy
        ? labelledBy
            .split(/\s+/u)
            .map((id: string) => element.ownerDocument.getElementById(id)?.textContent ?? "")
            .join(" ")
        : "";
      return {
        label: labelledText,
        ariaModal: element.getAttribute("aria-modal")
      };
    })
    .catch(() => ({ label: "", ariaModal: null }));
  const ariaSnapshot =
    accessibility.label.length === 0
      ? await candidate
          .ariaSnapshot({ timeout: 250 })
          .then((snapshot) => normalizeText(snapshot))
          .catch(() => "")
      : "";
  return Object.freeze({
    label: normalizeText(accessibility.label || ariaSnapshot).slice(0, 160),
    ariaModal: accessibility.ariaModal
  });
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

export async function waitForGenericGridReadiness(
  workbench: Page,
  baselineFrames: ReadonlySet<Frame>,
  baselinePages: ReadonlySet<Page>,
  timeoutMs = GRID_TIMEOUT_MS
): Promise<{
  readonly grid: ComparisonGridReadinessEvidence;
  readonly rendererFramePointerUsable: true;
  readonly frame: Frame;
}> {
  assert.ok(
    Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= GRID_TIMEOUT_MS,
    `Comparison grid discovery timeout must be between 1 and ${GRID_TIMEOUT_MS} ms.`
  );
  const deadline = Date.now() + timeoutMs;
  const stalledFrames = new Set<Frame>();
  const observedChildFrames = new Set<Frame>();
  const observedTopLevelPages = new Set<Page>();
  let maxDiscoveredFrames = 0;
  let completedNullProbes = 0;
  let rejectedProbes = 0;
  let timedOutProbes = 0;
  let obstructedPolls = 0;
  let maximumVisibleQuickInputs = 0;
  let maximumVisibleDialogs = 0;
  let maximumVisibleModals = 0;
  let lastVisibleQuickInputs = 0;
  let lastVisibleDialogs = 0;
  let lastVisibleModals = 0;
  let lastVisibleDialogLabels: readonly string[] = Object.freeze([]);
  const recordObstructions = (state: Awaited<ReturnType<typeof visibleComparisonWorkbenchObstructions>>): boolean => {
    lastVisibleQuickInputs = state.visibleQuickInputs;
    lastVisibleDialogs = state.visibleDialogs;
    lastVisibleModals = state.visibleModals;
    lastVisibleDialogLabels = state.visibleDialogLabels;
    maximumVisibleQuickInputs = Math.max(maximumVisibleQuickInputs, state.visibleQuickInputs);
    maximumVisibleDialogs = Math.max(maximumVisibleDialogs, state.visibleDialogs);
    maximumVisibleModals = Math.max(maximumVisibleModals, state.visibleModals);
    return state.visibleQuickInputs !== 0 || state.visibleDialogs !== 0 || state.visibleModals !== 0;
  };
  do {
    assert.equal(workbench.isClosed(), false, "The official VS Code workbench closed during grid discovery.");
    if (recordObstructions(await visibleComparisonWorkbenchObstructions(workbench))) {
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
        if (recordObstructions(await visibleComparisonWorkbenchObstructions(workbench))) {
          obstructedPolls += 1;
          continue;
        }
        return Object.freeze({
          grid: probe.value,
          rendererFramePointerUsable: true,
          frame
        });
      } else if (probe.status === "completed") {
        completedNullProbes += 1;
      } else {
        rejectedProbes += 1;
      }
    }
    await workbench.waitForTimeout(20);
  } while (Date.now() < deadline);
  const frameDiagnostics = await comparisonFrameStructureDiagnostics(workbench, baselineFrames, baselinePages);
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
        maximumVisibleQuickInputs,
        maximumVisibleDialogs,
        maximumVisibleModals,
        lastVisibleQuickInputs,
        lastVisibleDialogs,
        lastVisibleModals,
        lastVisibleDialogLabels,
        quarantinedFrames: stalledFrames.size,
        frameDiagnostics
      })}`
  );
}

async function comparisonFrameStructureDiagnostics(
  workbench: Page,
  baselineFrames: ReadonlySet<Frame>,
  baselinePages: ReadonlySet<Page>
): Promise<readonly Record<string, unknown>[]> {
  const diagnostics: Record<string, unknown>[] = [];
  const frames = comparisonFrames(workbench).slice(0, 32);
  for (const [frameOrdinal, frame] of frames.entries()) {
    const parent = frame.parentFrame();
    if (!isPostClickComparisonSurface(frame, baselineFrames, parent, frame.page(), baselinePages)) continue;
    let depth = 0;
    let current = frame;
    while (current.parentFrame()) {
      depth += 1;
      current = current.parentFrame() as Frame;
    }
    const documentState = await frame
      .evaluate(() => {
        const document_ = (
          globalThis as unknown as {
            readonly document: { readonly visibilityState: string; hasFocus(): boolean };
          }
        ).document;
        return { visibilityState: document_.visibilityState, hasFocus: document_.hasFocus() };
      })
      .catch(() => ({ visibilityState: "unavailable", hasFocus: false }));
    const roleCounts = Object.fromEntries(
      await Promise.all(
        (["grid", "table", "row", "columnheader", "gridcell", "cell", "alert", "status", "heading"] as const).map(
          async (role) => [
            role,
            Math.min(
              await frame
                .getByRole(role)
                .count()
                .catch(() => 0),
              512
            )
          ]
        )
      )
    );
    const [c00Headers, c01Headers] = await Promise.all([
      boundedVisibleLocatorCount(frame.getByRole("columnheader", { name: "c00", exact: true }), "c00 header"),
      boundedVisibleLocatorCount(frame.getByRole("columnheader", { name: "c01", exact: true }), "c01 header")
    ]);
    const publicStates = Object.fromEntries(
      await Promise.all(
        (["alert", "status", "heading"] as const).map(async (role) => [
          role,
          (await boundedVisibleLocatorSummary(frame.getByRole(role), `${role} diagnostic`)).labels.slice(0, 8)
        ])
      )
    );
    diagnostics.push(
      Object.freeze({
        frameOrdinal,
        depth,
        surface: frame.page() === workbench ? "workbench" : "auxiliary",
        ...documentState,
        roleCounts,
        publicStates,
        visibleExpectedHeaders: Object.freeze({ c00: c00Headers, c01: c01Headers })
      })
    );
  }
  return Object.freeze(diagnostics);
}

async function observeFrameReadiness(frame: Frame): Promise<ComparisonGridReadinessEvidence | null> {
  if (!(await frameChainIsVisibleAndPointerUsable(frame))) return null;
  return frame.evaluate(observeComparisonGridReadiness, DEFAULT_COMPARISON_GRID_READINESS_INPUT);
}

export async function frameChainIsVisibleAndPointerUsable(frame: Frame): Promise<boolean> {
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

export function comparisonFrames(workbench: Page): Frame[] {
  const browser = workbench.context().browser();
  const discovered = browser?.contexts().flatMap((context) => context.pages()) ?? [workbench];
  const pages = [workbench, ...discovered.filter((page) => page !== workbench && !page.isClosed())];
  return [...new Set(pages)].flatMap((page) => page.frames());
}

export async function connectToEditorWorkbench(): Promise<Workbench> {
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

export async function waitForWorkbenchReady(page: Page): Promise<void> {
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

export function allEditorTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap((group) => [...group.tabs]);
}

async function waitForNoEditorTabs(): Promise<void> {
  await waitFor(() => allEditorTabs().length === 0, EDITOR_CLOSE_TIMEOUT_MS, "all comparison editor tabs to close");
}

export function comparisonTabsOpenedAfter<T>(baselineTabs: readonly T[], currentTabs: readonly T[]): readonly T[] {
  if (
    !Array.isArray(baselineTabs) ||
    !Array.isArray(currentTabs) ||
    baselineTabs.length > 64 ||
    currentTabs.length > 64 ||
    new Set(baselineTabs).size !== baselineTabs.length ||
    new Set(currentTabs).size !== currentTabs.length
  ) {
    throw new TypeError("Comparison tab discovery requires two bounded identity-unique snapshots.");
  }
  const current = new Set(currentTabs);
  if (baselineTabs.some((tab) => !current.has(tab))) {
    throw new Error("A pre-existing comparison tab disappeared while the product launch was measured.");
  }
  const baseline = new Set(baselineTabs);
  return Object.freeze(currentTabs.filter((tab) => !baseline.has(tab)));
}

function tabInputUri(input: unknown): vscode.Uri | undefined {
  if (input instanceof vscode.TabInputText) return input.uri;
  if (input instanceof vscode.TabInputCustom) return input.uri;
  if (input instanceof vscode.TabInputNotebook) return input.uri;
  return undefined;
}

function comparisonPhase(value: string): ComparisonPhase {
  assert.ok(
    Object.hasOwn(PHASES, value) ||
      value === DATA_WRANGLER_FIRST_USE_SETUP_PHASE ||
      value === OPEN_WRANGLER_FIRST_USE_SETUP_PHASE,
    "The comparison phase must identify exactly one product or first-use setup."
  );
  return value as ComparisonPhase;
}

function comparisonProduct(phase: ComparisonPhase): ProductKey {
  if (phase === DATA_WRANGLER_FIRST_USE_SETUP_PHASE) return "data-wrangler";
  if (phase === OPEN_WRANGLER_FIRST_USE_SETUP_PHASE) return "open-wrangler";
  return PHASES[phase];
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

export function recordProgress(checkpoint: string): void {
  writeAcceptanceProgressCheckpoint(requiredEnvironment("OPEN_WRANGLER_TEST_PROGRESS"), {
    protocol: ACCEPTANCE_PROGRESS_PROTOCOL,
    runId: requiredEnvironment("OPEN_WRANGLER_TEST_RUN_ID"),
    phase: requiredEnvironment("OPEN_WRANGLER_TEST_PHASE"),
    checkpoint
  });
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  label: string
): Promise<void> {
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

export function dataWranglerComparisonKernelLabel(runId: string): string {
  if (!COMPARISON_RUN_ID.test(runId)) {
    throw new TypeError("Data Wrangler comparison kernel selection requires one correlated v4 run ID.");
  }
  return `Open Wrangler comparison runtime ${runId}`;
}

export function comparisonRuntimeSelectorMatches(accessibleName: string): boolean {
  return COMPARISON_RUNTIME_SELECTOR_ACCESSIBLE_NAME.test(normalizeText(accessibleName));
}

export function comparisonDialogLabelIsNonBlockingNotification(
  accessibleName: string,
  ariaModal: string | null
): boolean {
  return ariaModal !== "true" && /(?:^|,\s*)notification(?:,|$)/iu.test(normalizeText(accessibleName));
}

export function comparisonRuntimeOptionNamePattern(expectedLabel: string): RegExp {
  const prefix = "Open Wrangler comparison runtime ";
  const runId = expectedLabel.startsWith(prefix) ? expectedLabel.slice(prefix.length) : "";
  if (!COMPARISON_RUN_ID.test(runId) || expectedLabel !== dataWranglerComparisonKernelLabel(runId)) {
    throw new TypeError("Data Wrangler runtime-option discovery requires its exact correlated kernel label.");
  }
  return new RegExp(expectedLabel.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u");
}

export function comparisonRuntimeOptionMatches(expectedLabel: string, accessibleName: string): boolean {
  try {
    return comparisonRuntimeOptionNamePattern(expectedLabel).test(normalizeText(accessibleName));
  } catch {
    return false;
  }
}

export async function runDataWranglerRuntimeSelectionTopology<T>({
  discoverOptions,
  discoverSelectors,
  discoverLocalInterpreterConnections,
  activate,
  waitForRetry,
  isWithinDeadline
}: {
  discoverOptions: () => Promise<readonly T[]>;
  discoverSelectors: () => Promise<readonly T[]>;
  discoverLocalInterpreterConnections?: () => Promise<readonly T[]>;
  activate: (candidate: T) => Promise<void>;
  waitForRetry: () => Promise<void>;
  isWithinDeadline: () => boolean;
}): Promise<"direct-option" | "selector-option"> {
  if (
    typeof discoverOptions !== "function" ||
    typeof discoverSelectors !== "function" ||
    (discoverLocalInterpreterConnections !== undefined && typeof discoverLocalInterpreterConnections !== "function") ||
    typeof activate !== "function" ||
    typeof waitForRetry !== "function" ||
    typeof isWithinDeadline !== "function"
  ) {
    throw new TypeError("Data Wrangler runtime selection requires bounded public-role discovery callbacks.");
  }
  let selectorActivated = false;
  let localInterpreterConnectionActivated = false;
  let persistentAmbiguity: "configured runtime" | "runtime selector" | "local interpreter connection" | undefined;
  while (isWithinDeadline()) {
    const optionCandidates = await discoverOptions();
    if (!Array.isArray(optionCandidates) || optionCandidates.length > 128) {
      throw new Error("Data Wrangler first-use setup returned a malformed configured-runtime option set.");
    }
    if (optionCandidates.length > 1) {
      persistentAmbiguity = "configured runtime";
      await waitForRetry();
      continue;
    }
    if (optionCandidates.length === 1) {
      await activate(optionCandidates[0] as T);
      return selectorActivated ? "selector-option" : "direct-option";
    }

    if (!selectorActivated) {
      const selectorCandidates = await discoverSelectors();
      if (!Array.isArray(selectorCandidates) || selectorCandidates.length > 128) {
        throw new Error("Data Wrangler first-use setup returned a malformed public runtime-selector set.");
      }
      if (selectorCandidates.length > 1) {
        persistentAmbiguity = "runtime selector";
        await waitForRetry();
        continue;
      }
      if (selectorCandidates.length === 1) {
        await activate(selectorCandidates[0] as T);
        selectorActivated = true;
      }
    } else if (!localInterpreterConnectionActivated && discoverLocalInterpreterConnections) {
      const connectionCandidates = await discoverLocalInterpreterConnections();
      if (!Array.isArray(connectionCandidates) || connectionCandidates.length > 128) {
        throw new Error("Data Wrangler first-use setup returned a malformed local-interpreter connection set.");
      }
      if (connectionCandidates.length > 1) {
        persistentAmbiguity = "local interpreter connection";
        await waitForRetry();
        continue;
      }
      if (connectionCandidates.length === 1) {
        await activate(connectionCandidates[0] as T);
        localInterpreterConnectionActivated = true;
      }
    }
    persistentAmbiguity = undefined;
    await waitForRetry();
  }
  if (persistentAmbiguity !== undefined) {
    throw new Error(`Data Wrangler first-use setup retained an ambiguous ${persistentAmbiguity} control set.`);
  }
  throw new Error(
    selectorActivated
      ? localInterpreterConnectionActivated
        ? "Data Wrangler first-use setup did not expose exactly one matching configured runtime after choosing the local Python interpreter connection."
        : "Data Wrangler first-use setup did not expose exactly one matching configured runtime option."
      : "Data Wrangler first-use setup did not expose one direct configured option or exactly one public runtime selector."
  );
}

export function prioritizeDataWranglerRuntimeSelectors<T>(
  candidates: readonly T[],
  classify: (candidate: T) => "post-click" | "workbench-main" | "other",
  { allowWorkbenchMainFallback = false }: { readonly allowWorkbenchMainFallback?: boolean } = {}
): readonly T[] {
  if (
    !Array.isArray(candidates) ||
    candidates.length > 128 ||
    typeof classify !== "function" ||
    typeof allowWorkbenchMainFallback !== "boolean"
  ) {
    throw new TypeError("Data Wrangler runtime-selector prioritization requires a bounded candidate set.");
  }
  const buckets = {
    "post-click": [] as T[],
    "workbench-main": [] as T[],
    other: [] as T[]
  };
  for (const candidate of candidates) {
    const classification = classify(candidate);
    if (!Object.hasOwn(buckets, classification)) {
      throw new TypeError("Data Wrangler runtime-selector prioritization received an unknown surface.");
    }
    buckets[classification].push(candidate);
  }
  if (buckets["post-click"].length > 0) return Object.freeze([...buckets["post-click"]]);
  return Object.freeze(allowWorkbenchMainFallback ? [...buckets["workbench-main"]] : []);
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
