import * as assert from "node:assert/strict";

export interface ExactSessionPanelSynchronizationApi {
  synchronizePanel(sessionId: string): Promise<boolean>;
  ensurePanelSynchronized(sessionId: string, deadlineMs: number): Promise<boolean>;
  panelHydrated(sessionId: string): boolean;
  panelSynchronizable(sessionId: string): boolean;
  panelSynchronizationReceipt(
    sessionId: string
  ): Readonly<{ syncId: string; sessionId: string; revision: number }> | undefined;
}

export interface ActiveExactSessionPanelSynchronizationApi extends ExactSessionPanelSynchronizationApi {
  activeSession(): Readonly<{ sessionId: string; metadata: Readonly<{ revision: number }> }> | undefined;
}

export interface RequireFreshExactSessionPanelHydrationOptions {
  readonly timeoutMs: number;
  readonly pollIntervalMs?: number;
  readonly diagnosticState?: () => Readonly<Record<string, unknown>>;
}

export async function requireFreshExactSessionPanelHydration(
  testing: ActiveExactSessionPanelSynchronizationApi,
  sessionId: string,
  expectation: string,
  {
    timeoutMs,
    pollIntervalMs = 25,
    diagnosticState = () => ({
      expectedSessionId: sessionId,
      activeSessionId: testing.activeSession()?.sessionId,
      activeRevision: testing.activeSession()?.metadata.revision,
      panelHydrated: testing.panelHydrated(sessionId),
      panelSynchronizable: testing.panelSynchronizable(sessionId),
      panelSynchronizationReceipt: testing.panelSynchronizationReceipt(sessionId)
    })
  }: RequireFreshExactSessionPanelHydrationOptions
): Promise<void> {
  const active = testing.activeSession();
  assert.equal(active?.sessionId, sessionId, `${expectation} The exact session must remain active.`);
  assert.ok(active, `${expectation} The exact session must expose its current revision.`);
  const expectedRevision = active.metadata.revision;
  const synchronized = await waitForFreshExactSessionPanelHydration(testing, sessionId, {
    expectedRevision,
    timeoutMs,
    pollIntervalMs
  });
  assert.equal(
    synchronized,
    true,
    `${expectation} State: ${JSON.stringify({ expectedRevision, ...diagnosticState() })}`
  );
  const acknowledged = testing.activeSession();
  assert.equal(
    acknowledged?.sessionId,
    sessionId,
    `${expectation} The acknowledged renderer must still belong to the exact active session.`
  );
  assert.equal(
    acknowledged?.metadata.revision,
    expectedRevision,
    `${expectation} The active session must not advance while its renderer is being acknowledged.`
  );
}

export interface FreshExactSessionPanelHydrationOptions {
  readonly expectedRevision: number;
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
  readonly now?: () => number;
  readonly wait?: (durationMs: number) => Promise<void>;
}

/**
 * Forces a new renderer generation for the exact session, then follows an
 * authoritative replacement generation if a renderer recovery pull supersedes
 * the first marker while it is being acknowledged. Hydration from an older
 * session revision never satisfies the wait.
 */
export async function waitForFreshExactSessionPanelHydration(
  testing: ExactSessionPanelSynchronizationApi,
  sessionId: string,
  {
    expectedRevision,
    timeoutMs,
    pollIntervalMs,
    now = Date.now,
    wait = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs))
  }: FreshExactSessionPanelHydrationOptions
): Promise<boolean> {
  const deadline = now() + timeoutMs;
  const hasExpectedHydration = (): boolean => {
    const receipt = testing.panelSynchronizationReceipt(sessionId);
    return (
      testing.panelHydrated(sessionId) && receipt?.sessionId === sessionId && receipt.revision === expectedRevision
    );
  };
  const forced = await settlePanelSynchronization(testing.synchronizePanel(sessionId), deadline - now());
  if (forced.kind === "timeout") return false;
  if (hasExpectedHydration()) return true;

  while (!testing.panelSynchronizable(sessionId)) {
    if (hasExpectedHydration()) return true;
    const remaining = deadline - now();
    if (remaining <= 0) return false;
    await wait(Math.min(pollIntervalMs, remaining));
  }

  if (hasExpectedHydration()) return true;
  const remaining = deadline - now();
  if (remaining <= 0) return false;
  const ensured = await settlePanelSynchronization(testing.ensurePanelSynchronized(sessionId, deadline), remaining);
  if (ensured.kind === "timeout") return false;
  if (hasExpectedHydration()) return true;

  while (true) {
    const pollRemaining = deadline - now();
    if (pollRemaining <= 0) return false;
    await wait(Math.min(pollIntervalMs, pollRemaining));
    if (hasExpectedHydration()) return true;
  }
}

function settlePanelSynchronization(
  synchronization: Promise<boolean>,
  timeoutMs: number
): Promise<{ readonly kind: "settled"; readonly acknowledged: boolean } | { readonly kind: "timeout" }> {
  if (timeoutMs <= 0) return Promise.resolve({ kind: "timeout" });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
    void synchronization.then(
      (acknowledged) => {
        clearTimeout(timer);
        resolve({ kind: "settled", acknowledged });
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
