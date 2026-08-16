import * as assert from "node:assert/strict";
import type { RendererSynchronizationReceipt } from "./acknowledgedRenderer";

export interface ImportRendererRecoveryApi {
  panelHydrated(sessionId: string): boolean;
  panelSynchronizable(sessionId: string): boolean;
  panelSynchronizationReceipt(sessionId: string): RendererSynchronizationReceipt | undefined;
}

export interface ImportRendererRecoveryOptions {
  readonly retirementTimeoutMs: number;
  readonly recoveryTimeoutMs: number;
  readonly onRetired: () => void;
  readonly diagnostics: () => unknown;
  readonly waitForCondition: (
    condition: () => boolean,
    timeoutMs: number,
    description: string,
    diagnostics: () => string
  ) => Promise<void>;
}

export async function waitForImportRendererRecovery(
  testing: ImportRendererRecoveryApi,
  sessionId: string,
  expectedRevision: number,
  retainedReceipt: RendererSynchronizationReceipt,
  { retirementTimeoutMs, recoveryTimeoutMs, onRetired, diagnostics, waitForCondition }: ImportRendererRecoveryOptions
): Promise<RendererSynchronizationReceipt> {
  await waitForCondition(
    () =>
      !testing.panelHydrated(sessionId) &&
      !testing.panelSynchronizable(sessionId) &&
      testing.panelSynchronizationReceipt(sessionId) === undefined,
    retirementTimeoutMs,
    "the exact retiring renderer receipt to invalidate host readiness automatically",
    () =>
      JSON.stringify({
        panelHydrated: testing.panelHydrated(sessionId),
        panelSynchronizable: testing.panelSynchronizable(sessionId),
        receipt: testing.panelSynchronizationReceipt(sessionId),
        coordinator: diagnostics()
      })
  );
  onRetired();

  await waitForCondition(
    () => {
      const receipt = testing.panelSynchronizationReceipt(sessionId);
      return Boolean(
        testing.panelHydrated(sessionId) &&
        receipt?.sessionId === sessionId &&
        receipt.revision === expectedRevision &&
        receipt.syncId !== retainedReceipt.syncId
      );
    },
    recoveryTimeoutMs,
    "the existing bounded startup recovery to hydrate a replacement renderer without a test action",
    () =>
      JSON.stringify({
        priorReceipt: retainedReceipt,
        panelHydrated: testing.panelHydrated(sessionId),
        panelSynchronizable: testing.panelSynchronizable(sessionId),
        receipt: testing.panelSynchronizationReceipt(sessionId),
        coordinator: diagnostics()
      })
  );
  const recoveredReceipt = testing.panelSynchronizationReceipt(sessionId);
  assert.ok(recoveredReceipt, "Automatic renderer recovery must publish one exact replacement receipt.");
  assert.equal(recoveredReceipt.sessionId, sessionId, "Renderer recovery must retain the exact public session.");
  assert.equal(recoveredReceipt.revision, expectedRevision, "Renderer recovery must retain the exact host revision.");
  assert.notEqual(
    recoveredReceipt.syncId,
    retainedReceipt.syncId,
    "Renderer recovery must acknowledge a physically new document."
  );
  return recoveredReceipt;
}
