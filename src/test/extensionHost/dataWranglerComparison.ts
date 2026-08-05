import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { chromium, type Frame, type Locator, type Page } from "playwright-core";
import {
  DEFAULT_COMPARISON_GRID_READINESS_INPUT,
  observeComparisonGridReadiness,
  type ComparisonGridReadinessEvidence
} from "./comparisonGridReadiness";
import { ACCEPTANCE_PROGRESS_PROTOCOL, writeAcceptanceProgressCheckpoint } from "./progress";

const WORKBENCH_TIMEOUT_MS = 20_000;
const GRID_TIMEOUT_MS = 120_000;
const MAX_GRID_TIMEOUT_MS = 180_000;
const FRAME_PROBE_TIMEOUT_MS = 250;
const FRAME_PROBE_RETRY_DELAY_MS = 50;
const FRAME_PROBE_RETRIES = 1;

interface ComparisonWorkbenchReadinessEvidence {
  readonly targetEditorSelected: true;
  readonly noVisibleQuickInput: true;
  readonly noVisibleDialog: true;
  readonly noVisibleModal: true;
  readonly rendererFramePointerUsable: true;
}

interface Workbench {
  readonly page: Page;
}

export function allEditorTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap((group) => [...group.tabs]);
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
    Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= MAX_GRID_TIMEOUT_MS,
    `Comparison grid discovery timeout must be between 1 and ${MAX_GRID_TIMEOUT_MS} ms.`
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

export function recordProgress(checkpoint: string): void {
  writeAcceptanceProgressCheckpoint(requiredEnvironment("OPEN_WRANGLER_TEST_PROGRESS"), {
    protocol: ACCEPTANCE_PROGRESS_PROTOCOL,
    runId: requiredEnvironment("OPEN_WRANGLER_TEST_RUN_ID"),
    phase: requiredEnvironment("OPEN_WRANGLER_TEST_PHASE"),
    checkpoint
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

function comparisonDialogLabelIsNonBlockingNotification(accessibleName: string, ariaModal: string | null): boolean {
  return ariaModal !== "true" && /(?:^|,\s*)notification(?:,|$)/iu.test(normalizeText(accessibleName));
}

function buildComparisonWorkbenchReadinessEvidence({
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

function isPostClickComparisonSurface<TFrame, TPage>(
  frame: TFrame,
  baselineFrames: ReadonlySet<TFrame>,
  parentFrame: TFrame | null,
  page: TPage,
  baselinePages: ReadonlySet<TPage>
): boolean {
  return !baselineFrames.has(frame) && (parentFrame !== null || !baselinePages.has(page));
}

async function runBoundedComparisonFrameProbe<T>(
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

async function runComparisonFrameProbeWithRetry<T>(
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

function requiredEnvironment(key: string): string {
  const value = process.env[key];
  assert.ok(value && !/[\0\r\n]/u.test(value), `Comparison requires ${key}.`);
  return value;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}
