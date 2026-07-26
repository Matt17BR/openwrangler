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

interface RendererButtonProbe {
  count(): Promise<number>;
  isVisible(): Promise<boolean>;
  isEnabled(options?: { readonly timeout?: number }): Promise<boolean>;
}

interface KeyboardKeyPair {
  down(key: string): Promise<void>;
  up(key: string): Promise<void>;
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

export async function probeRendererButtonReadiness(
  button: RendererButtonProbe,
  enabledProbeTimeoutMs: number
): Promise<boolean> {
  if ((await button.count()) === 0) return false;
  if (!(await button.isVisible())) return false;
  return button.isEnabled({ timeout: enabledProbeTimeoutMs });
}

export async function pressKeyboardKeyPairWithoutTransitionGap(keyboard: KeyboardKeyPair, key: string): Promise<void> {
  // Playwright's press() awaits key-down before it queues key-up. A final
  // QuickInput can replace the active editor during that acknowledgement, so
  // queue both genuine keyboard events first and then await both responses.
  const keyDown = keyboard.down(key);
  const keyUp = keyboard.up(key);
  const [keyDownResult, keyUpResult] = await Promise.allSettled([keyDown, keyUp]);
  if (keyDownResult.status === "rejected" && keyUpResult.status === "rejected") {
    throw new AggregateError([keyDownResult.reason, keyUpResult.reason], "Both final-prompt keyboard events failed.");
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
