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

interface AcceptanceFailureReacquisitionOptions<T, D> {
  readonly timeoutMs: number;
  readonly diagnose: (deadline: number) => Promise<D>;
  readonly reacquire: (deadline: number) => Promise<T | undefined>;
  readonly now?: () => number;
}

interface KeyboardKeyPair {
  down(key: string): Promise<void>;
  up(key: string): Promise<void>;
}

interface OneShotAcceptanceAction<T> {
  readonly activate: () => Promise<void>;
  readonly receipt: () => Promise<T>;
  readonly naturalDismissal?: () => Promise<void>;
  readonly description: string;
}

interface AuthoritativelyReceiptedOneShotAcceptanceAction<T> extends OneShotAcceptanceAction<T> {
  readonly authoritativeReceiptAfterActivationFailure: () => Promise<T>;
}

interface PreDispatchReacquisitionOptions<T> {
  readonly acquire: () => Promise<T>;
  readonly activate: (action: T) => Promise<void>;
  readonly dispose: (action: T) => Promise<void>;
}

interface ReplaceableAcceptanceLocator {
  click(options: { readonly timeout: number }): Promise<void>;
}

interface ExactAcceptanceElement {
  click(options: { readonly force: true; readonly timeout: number }): Promise<void>;
  evaluate<Result>(pageFunction: (element: unknown) => Result | Promise<Result>): Promise<Result>;
}

export class IndeterminateAcceptanceActionError extends Error {
  constructor(description: string, cause: unknown) {
    super(`${description} may have been dispatched, but its one-shot user activation did not settle.`, { cause });
    this.name = "IndeterminateAcceptanceActionError";
  }
}

export class AcceptanceActionNotDispatchedError extends Error {
  constructor(description: string, cause: unknown) {
    super(`${description} failed before its click boundary.`, { cause });
    this.name = "AcceptanceActionNotDispatchedError";
  }
}

export async function invokeAcceptanceActionOnce<T>({
  activate,
  receipt,
  naturalDismissal,
  description
}: OneShotAcceptanceAction<T>): Promise<T> {
  try {
    await activate();
  } catch (error) {
    throw new IndeterminateAcceptanceActionError(description, error);
  }

  return observeAcceptanceActionReceipt(receipt, naturalDismissal, description);
}

export async function invokeAcceptanceActionOnceWithAuthoritativeReceipt<T>({
  activate,
  receipt,
  authoritativeReceiptAfterActivationFailure,
  naturalDismissal,
  description
}: AuthoritativelyReceiptedOneShotAcceptanceAction<T>): Promise<T> {
  try {
    await activate();
  } catch (error) {
    if (error instanceof AcceptanceActionNotDispatchedError) throw error;
    const indeterminate = new IndeterminateAcceptanceActionError(description, error);
    try {
      return await authoritativeReceiptAfterActivationFailure();
    } catch (receiptError) {
      throw new AggregateError(
        [indeterminate, receiptError],
        `${description} did not settle and its authoritative receipt could not prove dispatch.`
      );
    }
  }

  return observeAcceptanceActionReceipt(receipt, naturalDismissal, description);
}

export async function activateWithOnePreDispatchReacquisition<T>({
  acquire,
  activate,
  dispose
}: PreDispatchReacquisitionOptions<T>): Promise<void> {
  let ownedAction: T | undefined;
  const acquireBeforeClick = async (): Promise<T> => {
    try {
      return await acquire();
    } catch (error) {
      throw new AcceptanceActionNotDispatchedError("The acceptance action target acquisition", error);
    }
  };
  const release = async (): Promise<void> => {
    if (ownedAction === undefined) return;
    const action = ownedAction;
    ownedAction = undefined;
    await dispose(action);
  };

  ownedAction = await acquireBeforeClick();
  try {
    try {
      await activate(ownedAction);
      return;
    } catch (error) {
      if (!(error instanceof AcceptanceActionNotDispatchedError)) throw error;
    }

    try {
      await release();
    } catch (error) {
      throw new AcceptanceActionNotDispatchedError("The retired acceptance action cleanup", error);
    }
    ownedAction = await acquireBeforeClick();
    try {
      await activate(ownedAction);
    } catch (error) {
      if (error instanceof AcceptanceActionNotDispatchedError) {
        try {
          await release();
        } catch (cleanupError) {
          throw new AcceptanceActionNotDispatchedError("The replacement acceptance action cleanup", cleanupError);
        }
      }
      throw error;
    }
  } finally {
    await release();
  }
}

export function activateReplaceableAcceptanceLocator(
  locator: ReplaceableAcceptanceLocator,
  timeoutMs: number
): Promise<void> {
  return locator.click({ timeout: timeoutMs });
}

export async function activateExactAcceptanceElementOnce(
  target: ExactAcceptanceElement,
  timeoutMs: number,
  immediatelyBeforeClick?: () => void
): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("Exact acceptance-element activation requires a positive safe-integer timeout.");
  }
  if (immediatelyBeforeClick !== undefined && typeof immediatelyBeforeClick !== "function") {
    throw new TypeError("An acceptance click-boundary callback must be a function.");
  }
  const deadline = Date.now() + timeoutMs;
  const remaining = (description: string): number => {
    const remainingMs = deadline - Date.now();
    if (remainingMs < 1) {
      throw new Error(`Timed out waiting for ${description} after ${timeoutMs} ms.`);
    }
    return remainingMs;
  };

  const readinessDescription = "the exact acceptance element readiness";
  let readiness: string;
  try {
    readiness = await withAcceptanceOperationDeadline(
      target.evaluate((candidate) => {
        type ClickableElement = {
          readonly disabled?: boolean;
          readonly isConnected: boolean;
          readonly ownerDocument: {
            elementFromPoint(x: number, y: number): ClickableElement | null;
          };
          dataset: Record<string, string | undefined>;
          addEventListener(
            type: "click",
            listener: (event: { readonly isTrusted: boolean }) => void,
            options: { once: boolean }
          ): void;
          contains(node: ClickableElement | null): boolean;
          getAttribute(name: string): string | null;
          getBoundingClientRect(): {
            readonly left: number;
            readonly top: number;
            readonly width: number;
            readonly height: number;
          };
        };
        const element = candidate as ClickableElement;
        if (!element.isConnected) return "disconnected";
        if (element.disabled === true || element.getAttribute("aria-disabled") === "true") return "disabled";
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return "geometry";
        const hit = element.ownerDocument.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        if (hit !== element && !element.contains(hit)) return "covered";
        element.dataset.openWranglerAcceptanceActivation = "pending";
        element.addEventListener(
          "click",
          (event) => {
            if (event.isTrusted) element.dataset.openWranglerAcceptanceActivation = "seen";
          },
          { once: true }
        );
        return "ready";
      }),
      remaining(readinessDescription),
      readinessDescription
    );
    if (readiness !== "ready") {
      throw new Error(`The exact acceptance element is not ready for one click (${readiness}).`);
    }
  } catch (error) {
    throw new AcceptanceActionNotDispatchedError("The exact acceptance element", error);
  }

  immediatelyBeforeClick?.();
  await target.click({ force: true, timeout: remaining("the exact acceptance element trusted click") });
  const receiptDescription = "the exact acceptance element trusted-click receipt";
  const activation = await withAcceptanceOperationDeadline(
    target.evaluate(
      (element) =>
        (element as { readonly dataset: Record<string, string | undefined> }).dataset.openWranglerAcceptanceActivation
    ),
    remaining(receiptDescription),
    receiptDescription
  );
  if (activation !== "seen") {
    throw new Error("The exact acceptance element did not receive one trusted click.");
  }
}

async function observeAcceptanceActionReceipt<T>(
  receipt: () => Promise<T>,
  naturalDismissal: (() => Promise<void>) | undefined,
  description: string
): Promise<T> {
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

export async function probeAcceptanceBeforeDeadline<T>(
  probe: () => PromiseLike<T>,
  deadline: number,
  now: () => number = Date.now
): Promise<T | undefined> {
  const remainingMs = deadline - now();
  if (remainingMs <= 0) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      Promise.resolve()
        .then(probe)
        .then(
          (value) => ({ kind: "fulfilled" as const, value }),
          (error: unknown) => ({ kind: "rejected" as const, error })
        ),
      new Promise<{ readonly kind: "timedOut" }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timedOut" }), remainingMs);
      })
    ]);
    if (outcome.kind === "rejected") throw outcome.error;
    return outcome.kind === "fulfilled" ? outcome.value : undefined;
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
  enabledProbeTimeoutMs: number,
  requireEnabled = true
): Promise<boolean> {
  if ((await button.count()) !== 1) return false;
  if (!(await button.isVisible())) return false;
  return !requireEnabled || button.isEnabled({ timeout: enabledProbeTimeoutMs });
}

export async function diagnoseThenReacquireAcceptanceAction<T, D>({
  timeoutMs,
  diagnose,
  reacquire,
  now = Date.now
}: AcceptanceFailureReacquisitionOptions<T, D>): Promise<{
  readonly action: T | undefined;
  readonly diagnostics: D;
}> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("Acceptance failure reacquisition requires a positive safe-integer timeout.");
  }
  const deadline = now() + timeoutMs;
  const diagnostics = await diagnose(deadline);
  const action = await reacquire(deadline);
  return { action, diagnostics };
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

export async function observeExactRendererRetirement(
  workbench: PageLifecycle,
  browser: BrowserLifecycle | null,
  page: PageLifecycle,
  frame: FrameLifecycle,
  observe: () => PromiseLike<void>
): Promise<void> {
  assertRendererRetirementLifecycle(workbench, browser);
  try {
    await observe();
  } catch (error) {
    if (!rendererRetirementLifecycleIsLive(workbench, browser)) throw error;
    const firstMessageLine = error instanceof Error ? error.message.split(/\r?\n/u, 1)[0] : undefined;
    if (
      firstMessageLine !== "locator.waitFor: Frame was detached" ||
      !isRetiredRendererTarget(workbench, page, frame)
    ) {
      throw error;
    }
    if (!rendererRetirementLifecycleIsLive(workbench, browser)) throw error;
    return;
  }
  assertRendererRetirementLifecycle(workbench, browser);
}

function rendererRetirementLifecycleIsLive(
  workbench: PageLifecycle,
  browser: BrowserLifecycle | null
): browser is BrowserLifecycle {
  return !workbench.isClosed() && browser !== null && browser.isConnected();
}

function assertRendererRetirementLifecycle(
  workbench: PageLifecycle,
  browser: BrowserLifecycle | null
): asserts browser is BrowserLifecycle {
  if (workbench.isClosed()) {
    throw new Error("The editor workbench closed while observing exact renderer retirement.");
  }
  if (browser === null || !browser.isConnected()) {
    throw new Error("The editor CDP browser disconnected while observing exact renderer retirement.");
  }
}

function waitForPollInterval(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}
