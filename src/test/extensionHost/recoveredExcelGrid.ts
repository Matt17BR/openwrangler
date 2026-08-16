import * as assert from "node:assert/strict";
import type { Locator } from "playwright-core";
import {
  AcceptanceActionNotDispatchedError,
  activateExactAcceptanceElementOnce,
  withAcceptanceOperationDeadline
} from "./playwrightLifecycle";
import { sameRendererSynchronizationReceipt, type RendererSynchronizationReceipt } from "./acknowledgedRenderer";

type LocatorElementHandle = NonNullable<Awaited<ReturnType<Locator["elementHandle"]>>>;

interface RecoveredExcelSession {
  readonly sessionId: string;
  readonly metadata: Readonly<{ readonly revision: number }>;
}

interface RecoveredExcelGridRect {
  readonly bottom: number;
  readonly height: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly width: number;
}

interface RecoveredExcelCellElement {
  readonly dataset: { readonly gridColumn?: string; readonly gridRow?: string };
  readonly ownerDocument: {
    readonly activeElement?: unknown;
    elementFromPoint(x: number, y: number): unknown;
    hasFocus(): boolean;
  };
  readonly isConnected: boolean;
  readonly clientHeight: number;
  readonly clientLeft: number;
  readonly clientTop: number;
  readonly clientWidth: number;
  closest(selector: string): RecoveredExcelGridElement | null;
  contains(target: unknown): boolean;
  getBoundingClientRect(): RecoveredExcelGridRect;
}

interface RecoveredExcelGridElement extends RecoveredExcelCellElement {
  querySelectorAll(selector: string): ArrayLike<RecoveredExcelCellElement>;
}

export interface RecoveredExcelActivationProbe {
  readonly diagnostics: Readonly<{
    readonly candidateCount: number;
    readonly exposedBounds: Readonly<{ left: number; top: number; right: number; bottom: number }> | undefined;
    readonly dataColumnCount: number;
    readonly fullyExposedCellCount: number;
    readonly pointerExposedCellCount: number;
    readonly scrollerFound: boolean;
  }>;
  readonly target: Readonly<{ row: number; column: number }> | undefined;
}

export interface RecoveredExcelNeighborExposure {
  readonly connected: boolean;
  readonly focused: boolean;
  readonly fullyExposed: boolean;
  readonly cellRect: Readonly<{ bottom: number; left: number; right: number; top: number }> | undefined;
  readonly exposedBounds: Readonly<{ left: number; top: number; right: number; bottom: number }> | undefined;
}

export interface RecoveredExcelGridOptions<Target> {
  readonly sessionId: string;
  readonly revision: number;
  readonly sourceLabel: string;
  readonly discoveryTimeoutMs: number;
  readonly operationTimeoutMs: number;
  readonly activeSession: () => RecoveredExcelSession | undefined;
  readonly currentReceipt: () => RendererSynchronizationReceipt | undefined;
  readonly panelHydrated: () => boolean;
  readonly panelSynchronizable: () => boolean;
  readonly activeTabDiagnostic: () => unknown;
  readonly findCurrentTarget: (
    receipt: RendererSynchronizationReceipt,
    deadline: number
  ) => PromiseLike<Target | undefined>;
  readonly bindExactApp: (target: Target, synchronizationId: string) => PromiseLike<Locator | undefined>;
  readonly targetIsRetired: (target: Target) => boolean;
  readonly assertTargetLifecycle: (target: Target) => void;
  readonly ignoreRetiredProbeFailure: (target: Target, error: unknown) => void;
  readonly pressTargetKey: (target: Target, key: string) => PromiseLike<void>;
  readonly recordProgress: (checkpoint: string) => void;
  readonly withDeadline?: <T>(promise: PromiseLike<T>, timeoutMs: number, description: string) => Promise<T>;
  readonly activateElementOnce?: (
    element: LocatorElementHandle,
    timeoutMs: number,
    beforeDispatch: () => void
  ) => Promise<void>;
  readonly now?: () => number;
  readonly wait?: (durationMs: number) => Promise<void>;
}

export function findRecoveredExcelGridActivationTarget(
  table: unknown,
  dataColumnCount: number
): RecoveredExcelActivationProbe {
  const gridElement = table as RecoveredExcelGridElement;
  const scroller = gridElement.closest(".tableScroller");
  if (!scroller) {
    return {
      diagnostics: {
        candidateCount: 0,
        exposedBounds: undefined,
        dataColumnCount,
        fullyExposedCellCount: 0,
        pointerExposedCellCount: 0,
        scrollerFound: false
      },
      target: undefined
    };
  }

  const scrollerRect = scroller.getBoundingClientRect();
  const viewportLeft = scrollerRect.left + scroller.clientLeft;
  const viewportTop = scrollerRect.top + scroller.clientTop;
  const viewportRight = viewportLeft + scroller.clientWidth;
  const viewportBottom = viewportTop + scroller.clientHeight;
  const headerBottom = Math.max(
    viewportTop,
    ...Array.from(gridElement.querySelectorAll("thead th"), (header) => header.getBoundingClientRect().bottom)
  );
  const rowHeaderRight = Math.max(
    viewportLeft,
    ...Array.from(gridElement.querySelectorAll("thead th.rowHeader"), (header) => header.getBoundingClientRect().right)
  );
  const exposedBounds = { left: rowHeaderRight, top: headerBottom, right: viewportRight, bottom: viewportBottom };
  const tolerance = 1;
  const fullyExposed = (rect: RecoveredExcelGridRect): boolean =>
    rect.width > 0 &&
    rect.height > 0 &&
    rect.left >= exposedBounds.left - tolerance &&
    rect.top >= exposedBounds.top - tolerance &&
    rect.right <= exposedBounds.right + tolerance &&
    rect.bottom <= exposedBounds.bottom + tolerance;
  const cells = Array.from(gridElement.querySelectorAll("tbody td.gridCell[data-grid-row][data-grid-column]"));
  const candidates = cells
    .flatMap((cell) => {
      const row = Number(cell.dataset.gridRow);
      const column = Number(cell.dataset.gridColumn);
      return Number.isSafeInteger(row) &&
        row >= 0 &&
        Number.isSafeInteger(column) &&
        column >= 0 &&
        column + 1 < dataColumnCount
        ? [{ cell, column, row }]
        : [];
    })
    .sort((left, right) => right.column - left.column || left.row - right.row);
  let fullyExposedCellCount = 0;
  let pointerExposedCellCount = 0;
  const diagnostics = () => ({
    candidateCount: cells.length,
    fullyExposedCellCount,
    exposedBounds,
    dataColumnCount,
    pointerExposedCellCount,
    scrollerFound: true
  });

  for (const { cell, column, row } of candidates) {
    const rect = cell.getBoundingClientRect();
    if (!fullyExposed(rect)) continue;
    fullyExposedCellCount += 1;
    const hit = cell.ownerDocument.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    if (hit !== cell && (!hit || !cell.contains(hit))) continue;
    pointerExposedCellCount += 1;
    return { diagnostics: diagnostics(), target: { row, column } };
  }
  return { diagnostics: diagnostics(), target: undefined };
}

export function measureRecoveredExcelNeighborExposure(element: unknown): RecoveredExcelNeighborExposure {
  const cell = element as RecoveredExcelCellElement;
  const gridElement = cell.closest('[role="grid"]');
  const scroller = cell.closest(".tableScroller");
  if (!gridElement || !scroller) {
    return {
      connected: cell.isConnected,
      focused: cell.ownerDocument.activeElement === cell,
      fullyExposed: false,
      cellRect: undefined,
      exposedBounds: undefined
    };
  }
  const rect = cell.getBoundingClientRect();
  const scrollerRect = scroller.getBoundingClientRect();
  const viewportLeft = scrollerRect.left + scroller.clientLeft;
  const viewportTop = scrollerRect.top + scroller.clientTop;
  const exposedBounds = {
    left: Math.max(
      viewportLeft,
      ...Array.from(
        gridElement.querySelectorAll("thead th.rowHeader"),
        (header) => header.getBoundingClientRect().right
      )
    ),
    top: Math.max(
      viewportTop,
      ...Array.from(gridElement.querySelectorAll("thead th"), (header) => header.getBoundingClientRect().bottom)
    ),
    right: viewportLeft + scroller.clientWidth,
    bottom: viewportTop + scroller.clientHeight
  };
  const tolerance = 1;
  return {
    connected: cell.isConnected,
    focused: cell.ownerDocument.activeElement === cell,
    fullyExposed:
      rect.width > 0 &&
      rect.height > 0 &&
      rect.left >= exposedBounds.left - tolerance &&
      rect.top >= exposedBounds.top - tolerance &&
      rect.right <= exposedBounds.right + tolerance &&
      rect.bottom <= exposedBounds.bottom + tolerance,
    cellRect: { bottom: rect.bottom, left: rect.left, right: rect.right, top: rect.top },
    exposedBounds
  };
}

export async function verifyRecoveredExcelGrid<Target>({
  sessionId,
  revision,
  sourceLabel,
  discoveryTimeoutMs,
  operationTimeoutMs,
  activeSession,
  currentReceipt,
  panelHydrated,
  panelSynchronizable,
  activeTabDiagnostic,
  findCurrentTarget,
  bindExactApp,
  targetIsRetired,
  assertTargetLifecycle,
  ignoreRetiredProbeFailure,
  pressTargetKey,
  recordProgress,
  withDeadline = withAcceptanceOperationDeadline,
  activateElementOnce = activateExactAcceptanceElementOnce,
  now = Date.now,
  wait = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs))
}: RecoveredExcelGridOptions<Target>): Promise<void> {
  const deadline = now() + discoveryTimeoutMs;
  const operationTimeout = (): number => {
    const remainingMs = deadline - now();
    if (remainingMs <= 0) throw new Error("The recovered XLSX renderer verification reached its deadline.");
    return Math.min(operationTimeoutMs, remainingMs);
  };

  do {
    let activationBoundaryEntered = false;
    const active = activeSession();
    assert.equal(active?.sessionId, sessionId, "XLSX renderer recovery must retain the exact active session.");
    assert.equal(active?.metadata.revision, revision, "XLSX renderer recovery must retain the confirmed revision.");

    const receipt = currentReceipt();
    if (!panelHydrated() || receipt?.sessionId !== sessionId || receipt.revision !== revision) {
      await wait(Math.min(50, Math.max(0, deadline - now())));
      continue;
    }

    const target = await findCurrentTarget(receipt, deadline);
    if (!target) {
      await wait(Math.min(50, Math.max(0, deadline - now())));
      continue;
    }

    try {
      const app = await bindExactApp(target, receipt.syncId);
      if (!app) {
        if (!sameRendererSynchronizationReceipt(receipt, currentReceipt())) continue;
        throw new Error("The acknowledged XLSX renderer no longer exposes its exact session application.");
      }

      const grid = app.getByRole("grid", { name: `Data grid for ${sourceLabel}` });
      await grid.waitFor({ state: "visible", timeout: operationTimeout() });
      const [columnCount, rowCount] = await withDeadline(
        Promise.all([grid.getAttribute("aria-colcount"), grid.getAttribute("aria-rowcount")]),
        operationTimeout(),
        "the recovered XLSX grid dimensions"
      );
      assert.equal(columnCount, "7");
      assert.equal(rowCount, "65");
      const firstCell = app.locator('td[data-grid-row="0"][data-grid-column="0"]').first();
      await firstCell.waitFor({ state: "visible", timeout: operationTimeout() });
      const firstValue = await withDeadline(firstCell.innerText(), operationTimeout(), "the recovered XLSX first cell");
      assert.equal(firstValue.trim(), "OW-240001");

      assertTargetLifecycle(target);
      if (targetIsRetired(target) || !sameRendererSynchronizationReceipt(receipt, currentReceipt())) continue;
      recordProgress("excel-dependency-install:grid-bound");

      const activationProbe = await withDeadline(
        grid.evaluate(findRecoveredExcelGridActivationTarget, Number(columnCount) - 1),
        operationTimeout(),
        "an exposed cell in the recovered XLSX grid"
      );
      const activationTarget = activationProbe.target;
      assert.ok(
        activationTarget,
        `The recovered XLSX grid must expose one body cell below the sticky headers. Geometry: ${JSON.stringify(
          activationProbe.diagnostics
        )}`
      );
      assertTargetLifecycle(target);
      if (targetIsRetired(target) || !sameRendererSynchronizationReceipt(receipt, currentReceipt())) continue;
      recordProgress("excel-dependency-install:grid-activation-target");

      const activationCell = app
        .locator(`td[data-grid-row="${activationTarget.row}"][data-grid-column="${activationTarget.column}"]`)
        .first();
      const activationElement = await activationCell.elementHandle({ timeout: operationTimeout() });
      assert.ok(activationElement, "The recovered XLSX grid must retain its exposed activation cell.");
      let focusState: { connected: boolean; documentFocused: boolean; cellFocused: boolean };
      try {
        await activateElementOnce(activationElement, operationTimeout(), () => {
          const current = activeSession();
          if (
            current?.sessionId !== sessionId ||
            current.metadata.revision !== revision ||
            targetIsRetired(target) ||
            !sameRendererSynchronizationReceipt(receipt, currentReceipt())
          ) {
            throw new AcceptanceActionNotDispatchedError(
              "The recovered XLSX grid activation",
              new Error("Its exact session, renderer, or revision changed before the trusted click boundary.")
            );
          }
          activationBoundaryEntered = true;
        });
        recordProgress("excel-dependency-install:grid-activation-dispatched");
        focusState = await withDeadline(
          activationElement.evaluate((element) => ({
            connected: element.isConnected,
            documentFocused: element.ownerDocument.hasFocus(),
            cellFocused: element.ownerDocument.activeElement === element
          })),
          operationTimeout(),
          "the recovered XLSX grid focus"
        );
      } finally {
        await activationElement.dispose();
      }
      assertTargetLifecycle(target);
      assert.equal(
        targetIsRetired(target),
        false,
        "The recovered XLSX renderer must remain live after its trusted cell activation."
      );
      assert.equal(
        sameRendererSynchronizationReceipt(receipt, currentReceipt()),
        true,
        "The recovered XLSX renderer receipt must not change after its trusted cell activation."
      );
      assert.equal(activeSession()?.sessionId, sessionId);
      assert.equal(activeSession()?.metadata.revision, revision);
      assert.deepEqual(
        focusState,
        { connected: true, documentFocused: true, cellFocused: true },
        "The recovered XLSX cell must own focus in the current renderer before keyboard navigation."
      );
      recordProgress("excel-dependency-install:grid-focused");

      await withDeadline(
        pressTargetKey(target, "ArrowRight"),
        operationTimeout(),
        "the recovered XLSX grid ArrowRight action"
      );
      assertTargetLifecycle(target);
      assert.equal(targetIsRetired(target), false, "The recovered XLSX renderer must remain live after ArrowRight.");
      assert.equal(
        sameRendererSynchronizationReceipt(receipt, currentReceipt()),
        true,
        "The recovered XLSX renderer receipt must not change after ArrowRight."
      );
      recordProgress("excel-dependency-install:grid-arrow-sent");
      const focusedNeighbor = app
        .locator(`td[data-grid-row="${activationTarget.row}"][data-grid-column="${activationTarget.column + 1}"]:focus`)
        .first();
      await focusedNeighbor.waitFor({ state: "visible", timeout: operationTimeout() });
      const neighborExposure = await withDeadline(
        focusedNeighbor.evaluate(measureRecoveredExcelNeighborExposure),
        operationTimeout(),
        "the recovered XLSX grid neighbor exposure"
      );

      assertTargetLifecycle(target);
      assert.equal(
        targetIsRetired(target),
        false,
        "The recovered XLSX renderer must remain live after neighbor focus."
      );
      assert.equal(
        sameRendererSynchronizationReceipt(receipt, currentReceipt()),
        true,
        "The recovered XLSX renderer receipt must not change after neighbor focus."
      );
      assert.equal(
        neighborExposure.connected && neighborExposure.focused && neighborExposure.fullyExposed,
        true,
        `ArrowRight must focus and reveal the recovered XLSX neighbor inside the data viewport. Geometry: ${JSON.stringify(
          neighborExposure
        )}`
      );
      const confirmedActive = activeSession();
      assert.equal(
        confirmedActive?.sessionId,
        sessionId,
        "XLSX keyboard verification must retain the exact active session."
      );
      assert.equal(
        confirmedActive?.metadata.revision,
        revision,
        "XLSX keyboard verification must retain the confirmed revision."
      );
      recordProgress("excel-dependency-install:grid-keyboard");
      return;
    } catch (error) {
      if (activationBoundaryEntered) throw error;
      if (error instanceof AcceptanceActionNotDispatchedError) {
        await wait(Math.min(25, operationTimeout()));
        continue;
      }
      if (!sameRendererSynchronizationReceipt(receipt, currentReceipt())) continue;
      ignoreRetiredProbeFailure(target, error);
    }
  } while (now() < deadline);

  throw new Error(
    `The recovered XLSX grid did not remain available in one acknowledged renderer. State: ${JSON.stringify({
      expectedSessionId: sessionId,
      expectedRevision: revision,
      activeSessionId: activeSession()?.sessionId,
      activeRevision: activeSession()?.metadata.revision,
      panelHydrated: panelHydrated(),
      panelSynchronizable: panelSynchronizable(),
      panelSynchronizationReceipt: currentReceipt(),
      activeTab: activeTabDiagnostic()
    })}`
  );
}
