export interface ExactSessionPanelSynchronizationApi {
  synchronizePanel(sessionId: string): Promise<boolean>;
  ensurePanelSynchronized(sessionId: string, deadlineMs: number): Promise<boolean>;
  panelHydrated(sessionId: string): boolean;
  panelSynchronizable(sessionId: string): boolean;
}

export interface FreshExactSessionPanelHydrationOptions {
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
  readonly now?: () => number;
  readonly wait?: (durationMs: number) => Promise<void>;
}

/**
 * Forces a new renderer generation for the exact session, then follows an
 * authoritative replacement generation if a renderer recovery pull supersedes
 * the first marker while it is being acknowledged.
 */
export async function waitForFreshExactSessionPanelHydration(
  testing: ExactSessionPanelSynchronizationApi,
  sessionId: string,
  {
    timeoutMs,
    pollIntervalMs,
    now = Date.now,
    wait = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs))
  }: FreshExactSessionPanelHydrationOptions
): Promise<boolean> {
  const deadline = now() + timeoutMs;
  const forced = await settlePanelSynchronization(testing.synchronizePanel(sessionId), deadline - now());
  if (forced.kind === "timeout") return false;
  if (testing.panelHydrated(sessionId)) return true;

  while (!testing.panelSynchronizable(sessionId)) {
    if (testing.panelHydrated(sessionId)) return true;
    const remaining = deadline - now();
    if (remaining <= 0) return false;
    await wait(Math.min(pollIntervalMs, remaining));
  }

  if (testing.panelHydrated(sessionId)) return true;
  const remaining = deadline - now();
  if (remaining <= 0) return false;
  const ensured = await settlePanelSynchronization(testing.ensurePanelSynchronized(sessionId, deadline), remaining);
  if (ensured.kind === "timeout") return false;
  if (testing.panelHydrated(sessionId)) return true;

  while (true) {
    const pollRemaining = deadline - now();
    if (pollRemaining <= 0) return false;
    await wait(Math.min(pollIntervalMs, pollRemaining));
    if (testing.panelHydrated(sessionId)) return true;
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
