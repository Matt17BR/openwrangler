interface BrowserLifecycle {
  isConnected(): boolean;
}

interface FrameLifecycle {
  isDetached(): boolean;
}

interface PageLifecycle {
  isClosed(): boolean;
  mainFrame(): FrameLifecycle;
}

interface AcceptancePollOptions {
  readonly timeoutMs: number;
  readonly intervalMs: number;
  readonly now?: () => number;
  readonly wait?: (durationMs: number) => Promise<void>;
}

interface PreparedAcceptanceActionOptions<T> extends AcceptancePollOptions {
  readonly acquire: () => Promise<T | undefined>;
  readonly prepare: (action: T) => Promise<void>;
  readonly dispose: (action: T) => Promise<void>;
  readonly isRetryablePreparationError: (error: unknown) => boolean;
}

interface RendererButtonProbe {
  count(): Promise<number>;
  isVisible(): Promise<boolean>;
  isEnabled(options?: { readonly timeout?: number }): Promise<boolean>;
}

interface KeyboardKeyPair {
  down(key: string): Promise<void>;
  up(key: string): Promise<void>;
}

interface OneShotAcceptanceAction<T> {
  readonly click: () => Promise<void>;
  readonly receipt: () => Promise<T>;
  readonly naturalDismissal?: () => Promise<void>;
  readonly description: string;
}

export class IndeterminateAcceptanceActionError extends Error {
  constructor(description: string, cause: unknown) {
    super(`${description} may have been dispatched, but its browser click did not settle.`, { cause });
    this.name = "IndeterminateAcceptanceActionError";
  }
}

export async function invokeAcceptanceActionOnce<T>({
  click,
  receipt,
  naturalDismissal,
  description
}: OneShotAcceptanceAction<T>): Promise<T> {
  try {
    await click();
  } catch (error) {
    throw new IndeterminateAcceptanceActionError(description, error);
  }

  const receiptResult = receipt();
  if (!naturalDismissal) return receiptResult;

  const [receiptOutcome, dismissalOutcome] = await Promise.allSettled([receiptResult, naturalDismissal()]);
  if (receiptOutcome.status === "rejected" && dismissalOutcome.status === "rejected") {
    throw new AggregateError(
      [receiptOutcome.reason, dismissalOutcome.reason],
      `${description} did not publish its receipt or dismiss its launch surface naturally.`
    );
  }
  if (receiptOutcome.status === "rejected") throw receiptOutcome.reason;
  if (dismissalOutcome.status === "rejected") throw dismissalOutcome.reason;
  return receiptOutcome.value;
}

export async function withAcceptanceOperationDeadline<T>(
  operation: PromiseLike<T>,
  timeoutMs: number,
  description: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${description} after ${timeoutMs} ms.`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function pollAcceptanceCondition(
  probe: () => Promise<boolean>,
  { timeoutMs, intervalMs, now = Date.now, wait = waitForPollInterval }: AcceptancePollOptions
): Promise<boolean> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("Acceptance polling requires a positive safe-integer timeout.");
  }
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
    throw new Error("Acceptance polling requires a positive safe-integer interval.");
  }

  const deadline = now() + timeoutMs;
  while (true) {
    if (await probe()) return true;
    const remainingMs = deadline - now();
    if (remainingMs <= 0) return false;
    await wait(Math.min(intervalMs, remainingMs));
  }
}

export async function acquirePreparedAcceptanceAction<T>({
  acquire,
  prepare,
  dispose,
  isRetryablePreparationError,
  timeoutMs,
  intervalMs,
  now = Date.now,
  wait = waitForPollInterval
}: PreparedAcceptanceActionOptions<T>): Promise<T | undefined> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("Acceptance-action preparation requires a positive safe-integer timeout.");
  }
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
    throw new Error("Acceptance-action preparation requires a positive safe-integer interval.");
  }

  const deadline = now() + timeoutMs;
  let firstAttempt = true;
  while (true) {
    if (!firstAttempt && now() >= deadline) return undefined;
    firstAttempt = false;

    let candidate: T | undefined;
    try {
      candidate = await acquire();
    } catch (error) {
      if (!isRetryablePreparationError(error)) throw error;
    }

    if (candidate !== undefined) {
      let transferred = false;
      try {
        await prepare(candidate);
        transferred = true;
        return candidate;
      } catch (error) {
        if (!isRetryablePreparationError(error)) throw error;
      } finally {
        if (!transferred) await dispose(candidate);
      }
    }

    const remainingMs = deadline - now();
    if (remainingMs <= 0) return undefined;
    await wait(Math.min(intervalMs, remainingMs));
  }
}

export async function probeRendererButtonReadiness(
  button: RendererButtonProbe,
  enabledProbeTimeoutMs: number
): Promise<boolean> {
  if ((await button.count()) === 0) return false;
  if (!(await button.isVisible())) return false;
  return button.isEnabled({ timeout: enabledProbeTimeoutMs });
}

export async function pressKeyboardKeyPairWithoutTransitionGap(keyboard: KeyboardKeyPair, key: string): Promise<void> {
  // Playwright's press() awaits key-down before it queues key-up. A transitioning
  // QuickInput can close and show its successor during that acknowledgement, so
  // queue both genuine keyboard events first and then await both responses.
  const keyDown = keyboard.down(key);
  const keyUp = keyboard.up(key);
  const [keyDownResult, keyUpResult] = await Promise.allSettled([keyDown, keyUp]);
  if (keyDownResult.status === "rejected" && keyUpResult.status === "rejected") {
    throw new AggregateError(
      [keyDownResult.reason, keyUpResult.reason],
      "Both transitioning-QuickInput keyboard events failed."
    );
  }
  if (keyDownResult.status === "rejected") throw keyDownResult.reason;
  if (keyUpResult.status === "rejected") throw keyUpResult.reason;
}

export function isRetiredRendererTarget(workbench: PageLifecycle, page: PageLifecycle, frame: FrameLifecycle): boolean {
  return (page !== workbench && page.isClosed()) || (frame !== workbench.mainFrame() && frame.isDetached());
}

export function ignoreRetiredRendererProbeFailure(
  workbench: PageLifecycle,
  browser: BrowserLifecycle | null,
  page: PageLifecycle,
  frame: FrameLifecycle,
  error: unknown
): void {
  if (
    workbench.isClosed() ||
    (browser !== null && !browser.isConnected()) ||
    !isRetiredRendererTarget(workbench, page, frame)
  ) {
    throw error;
  }
}

function waitForPollInterval(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}
