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
  readonly activate: () => Promise<void>;
  readonly receipt: () => Promise<T>;
  readonly naturalDismissal?: () => Promise<void>;
  readonly description: string;
}

interface AuthoritativelyReceiptedOneShotAcceptanceAction<T> extends OneShotAcceptanceAction<T> {
  readonly authoritativeReceiptAfterActivationFailure: () => Promise<T>;
}

interface ReplaceableAcceptanceLocator {
  click(options: { readonly timeout: number }): Promise<void>;
}

interface AcceptancePointerTarget {
  readonly pointer: AcceptancePointer;
  boundingBox(): Promise<{
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  } | null>;
  evaluate<Result>(pageFunction: (element: unknown) => Result | Promise<Result>): Promise<Result>;
}

interface AcceptancePointer {
  click(x: number, y: number): Promise<void>;
}

export class IndeterminateAcceptanceActionError extends Error {
  constructor(description: string, cause: unknown) {
    super(`${description} may have been dispatched, but its one-shot user activation did not settle.`, { cause });
    this.name = "IndeterminateAcceptanceActionError";
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

export function activateReplaceableAcceptanceLocator(
  locator: ReplaceableAcceptanceLocator,
  timeoutMs: number
): Promise<void> {
  return locator.click({ timeout: timeoutMs });
}

export function activateAcceptancePointerTargetAtCurrentCenter(
  target: AcceptancePointerTarget,
  timeoutMs: number
): Promise<void> {
  return withAcceptanceOperationDeadline(
    activateAcceptancePointerTargetAtCurrentCenterWithoutDeadline(target),
    timeoutMs,
    "the exact acceptance pointer target to receive one physical click"
  );
}

async function activateAcceptancePointerTargetAtCurrentCenterWithoutDeadline(
  target: AcceptancePointerTarget
): Promise<void> {
  const [box, ownsCenter] = await Promise.all([
    target.boundingBox(),
    target.evaluate((candidate) => {
      type PointerElement = {
        readonly disabled?: boolean;
        readonly isConnected: boolean;
        readonly ownerDocument: {
          elementFromPoint(x: number, y: number): PointerElement | null;
        };
        contains(node: PointerElement | null): boolean;
        getBoundingClientRect(): {
          readonly left: number;
          readonly top: number;
          readonly width: number;
          readonly height: number;
        };
      };
      const element = candidate as PointerElement;
      const rect = element.getBoundingClientRect();
      if (!element.isConnected || element.disabled === true || rect.width <= 0 || rect.height <= 0) return false;
      const hit = element.ownerDocument.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return hit === element || element.contains(hit);
    })
  ]);
  if (!box || box.width <= 0 || box.height <= 0) {
    throw new Error("The exact acceptance pointer target has no clickable geometry.");
  }
  if (!ownsCenter) {
    throw new Error("The exact acceptance pointer target does not own its current center point.");
  }
  await target.pointer.click(box.x + box.width / 2, box.y + box.height / 2);
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
