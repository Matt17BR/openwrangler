import * as assert from "node:assert/strict";
import type { Locator } from "playwright-core";
import { sameRendererSynchronizationReceipt, type RendererSynchronizationReceipt } from "./acknowledgedRenderer";

export type BackendSwitchLabel = "Polars" | "Pandas";

export interface BackendSwitchPhysicalViewSample {
  readonly backendLabel: string | null;
  readonly backendWidth: number | null;
  readonly connected: boolean;
  readonly headerSelected: string | null;
  readonly headerWidth: number | null;
  readonly rowHeight: number | null;
  readonly rowPresent: boolean;
  readonly scrollLeft: number | null;
  readonly scrollTop: number | null;
  readonly syncId: string | null;
}

interface BackendSwitchPhysicalViewElement {
  readonly scrollLeft: number;
  readonly scrollTop: number;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): Readonly<{ readonly width: number; readonly height: number }>;
  closest(selector: string): BackendSwitchPhysicalViewElement | null;
}

export interface BackendSwitchPhysicalViewRoot extends BackendSwitchPhysicalViewElement {
  readonly isConnected: boolean;
  querySelector(selector: string): BackendSwitchPhysicalViewElement | null;
}

interface BackendSwitchActiveSession {
  readonly sessionId: string;
  readonly metadata: Readonly<{ readonly revision: number }>;
}

export interface BackendSwitchPhysicalViewOptions<Target> {
  readonly sessionId: string;
  readonly backend: BackendSwitchLabel;
  readonly expectedRevision: number;
  readonly discoveryTimeoutMs: number;
  readonly activeSession: () => BackendSwitchActiveSession | undefined;
  readonly currentReceipt: () => RendererSynchronizationReceipt | undefined;
  readonly panelHydrated: () => boolean;
  readonly requireHydration: (expectation: string, timeoutMs: number) => PromiseLike<void>;
  readonly assertLifecycle: () => void;
  readonly findCurrentTarget: (
    receipt: RendererSynchronizationReceipt,
    deadline: number
  ) => PromiseLike<Target | undefined>;
  readonly bindExactApp: (target: Target, synchronizationId: string) => PromiseLike<Locator | undefined>;
  readonly targetIsRetired: (target: Target) => boolean;
  readonly withDeadline: <T>(promise: PromiseLike<T>, timeoutMs: number, description: string) => Promise<T>;
  readonly now?: () => number;
  readonly wait?: (durationMs: number) => Promise<void>;
}

export function sampleBackendSwitchPhysicalView(root: BackendSwitchPhysicalViewRoot): BackendSwitchPhysicalViewSample {
  const backendBadge = root.querySelector('[data-session-badge="backend"]');
  const header = root.querySelector('th[data-column="market"]');
  const restoredCell = root.querySelector('td[data-grid-row="37"][data-grid-column="1"]');
  const restoredRow = restoredCell?.closest("tr");
  const scroller = root.querySelector('[data-testid="data-grid-scroller"]');
  const backendBox = backendBadge?.getBoundingClientRect();
  const headerBox = header?.getBoundingClientRect();
  const rowBox = restoredRow?.getBoundingClientRect();
  return {
    backendLabel: backendBadge?.getAttribute("aria-label") ?? null,
    backendWidth: backendBox?.width ?? null,
    connected: root.isConnected,
    headerSelected: header?.getAttribute("aria-selected") ?? null,
    headerWidth: headerBox?.width ?? null,
    rowHeight: rowBox?.height ?? null,
    rowPresent: restoredCell !== null,
    scrollLeft: scroller?.scrollLeft ?? null,
    scrollTop: scroller?.scrollTop ?? null,
    syncId: root.getAttribute("data-renderer-sync-id")
  };
}

export function backendSwitchPhysicalViewMatches(
  sample: BackendSwitchPhysicalViewSample,
  synchronizationId: string,
  backend: BackendSwitchLabel
): boolean {
  return (
    sample.backendLabel === `Change dataframe engine. Current engine: ${backend}` &&
    sample.backendWidth !== null &&
    sample.backendWidth > 0 &&
    sample.connected &&
    sample.syncId === synchronizationId &&
    sample.headerSelected === "true" &&
    sample.headerWidth !== null &&
    Math.abs(sample.headerWidth - 287) <= 1.5 &&
    sample.rowPresent &&
    sample.rowHeight !== null &&
    sample.rowHeight > 0 &&
    sample.scrollLeft !== null &&
    Math.abs(sample.scrollLeft - 113) <= 1 &&
    sample.scrollTop !== null &&
    Math.abs(sample.scrollTop / sample.rowHeight - 37) <= 0.1
  );
}

export async function verifyBackendSwitchPhysicalView<Target>({
  sessionId,
  backend,
  expectedRevision,
  discoveryTimeoutMs,
  activeSession,
  currentReceipt,
  panelHydrated,
  requireHydration,
  assertLifecycle,
  findCurrentTarget,
  bindExactApp,
  targetIsRetired,
  withDeadline,
  now = Date.now,
  wait = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs))
}: BackendSwitchPhysicalViewOptions<Target>): Promise<void> {
  const physicalDeadline = now() + discoveryTimeoutMs;
  const expectation = `The ${backend} renderer must acknowledge the switched file session before its physical view is checked.`;
  await requireHydration(expectation, Math.max(1, physicalDeadline - now()));
  let bound:
    | Readonly<{
        app: Locator;
        receipt: RendererSynchronizationReceipt;
        target: Target;
      }>
    | undefined;
  const supersededSynchronizationIds = new Set<string>();
  let lastSample: BackendSwitchPhysicalViewSample | undefined;
  const receiptIsCurrent = (receipt: RendererSynchronizationReceipt): boolean =>
    sameRendererSynchronizationReceipt(receipt, currentReceipt());
  const supersede = (receipt: RendererSynchronizationReceipt): void => {
    supersededSynchronizationIds.add(receipt.syncId);
    bound = undefined;
  };

  while (now() < physicalDeadline) {
    assertLifecycle();
    const active = activeSession();
    assert.equal(active?.sessionId, sessionId, `${expectation} The exact session must remain active.`);
    assert.equal(
      active?.metadata.revision,
      expectedRevision,
      `${expectation} The switched revision must remain unchanged through physical verification.`
    );

    if (bound === undefined) {
      const receipt = currentReceipt();
      if (
        receipt?.sessionId === sessionId &&
        receipt.revision === expectedRevision &&
        panelHydrated() &&
        !supersededSynchronizationIds.has(receipt.syncId)
      ) {
        let target: Target | undefined;
        try {
          target = await findCurrentTarget(receipt, physicalDeadline);
        } catch (error) {
          assertLifecycle();
          if (receiptIsCurrent(receipt)) throw error;
          supersede(receipt);
          continue;
        }
        const receiptAfterDiscovery = currentReceipt();
        if (
          !sameRendererSynchronizationReceipt(receipt, receiptAfterDiscovery) ||
          (target && targetIsRetired(target))
        ) {
          supersede(receipt);
        } else if (target) {
          try {
            const app = await bindExactApp(target, receipt.syncId);
            if (app && receiptIsCurrent(receipt) && !targetIsRetired(target)) {
              bound = { app, receipt, target };
            } else if (!receiptIsCurrent(receipt) || targetIsRetired(target)) {
              supersede(receipt);
            } else {
              throw new Error(`${expectation} The acknowledged renderer did not expose its exact synchronized app.`);
            }
          } catch (error) {
            if (receiptIsCurrent(receipt) && !targetIsRetired(target)) throw error;
            supersede(receipt);
          }
        }
      }
    } else {
      const boundReceipt = bound.receipt;
      const boundTarget = bound.target;
      if (!receiptIsCurrent(boundReceipt) || targetIsRetired(boundTarget)) {
        supersede(boundReceipt);
        continue;
      }

      let sample: BackendSwitchPhysicalViewSample;
      try {
        sample = await withDeadline(
          bound.app.evaluate(sampleBackendSwitchPhysicalView),
          Math.max(1, physicalDeadline - now()),
          `the ${backend} receipt-bound physical grid sample`
        );
      } catch (error) {
        assertLifecycle();
        if (receiptIsCurrent(boundReceipt) && !targetIsRetired(boundTarget)) throw error;
        supersede(boundReceipt);
        continue;
      }

      if (!receiptIsCurrent(boundReceipt) || targetIsRetired(boundTarget)) {
        supersede(boundReceipt);
        continue;
      }
      lastSample = sample;
      if (backendSwitchPhysicalViewMatches(sample, boundReceipt.syncId, backend)) return;
    }
    const remainingMs = physicalDeadline - now();
    if (remainingMs > 0) await wait(Math.min(25, remainingMs));
  }

  throw new Error(
    `The ${backend} switched physical view exceeded its shared renderer deadline. ${JSON.stringify({
      receipt: currentReceipt(),
      lastSample,
      supersededSynchronizationIds: Array.from(supersededSynchronizationIds).slice(-8)
    })}`
  );
}
