import { diagnoseThenReacquireAcceptanceAction } from "./playwrightLifecycle";

export interface CurrentWebviewAction<TTarget, TAction> {
  readonly target: TTarget;
  readonly action: TAction;
}

export interface FindCurrentWebviewActionOptions<TTarget, TAction> {
  readonly name: string;
  readonly requireEnabled: boolean;
  readonly deadline: number;
  readonly targets: () => readonly TTarget[];
  readonly isRetired: (target: TTarget) => boolean;
  readonly actionForTarget: (target: TTarget, name: string) => TAction;
  readonly probe: (action: TAction, remainingMs: number, requireEnabled: boolean) => Promise<boolean>;
  readonly withinDeadline: (probe: Promise<boolean>, remainingMs: number, description: string) => Promise<boolean>;
  readonly assertLifecycle: () => void;
  readonly ignoreProbeFailure: (target: TTarget, error: unknown) => void;
  readonly now?: () => number;
}

export async function findCurrentWebviewAction<TTarget, TAction>({
  name,
  requireEnabled,
  deadline,
  targets,
  isRetired,
  actionForTarget,
  probe,
  withinDeadline,
  assertLifecycle,
  ignoreProbeFailure,
  now = Date.now
}: FindCurrentWebviewActionOptions<TTarget, TAction>): Promise<CurrentWebviewAction<TTarget, TAction> | undefined> {
  assertLifecycle();
  for (const target of targets()) {
    if (isRetired(target)) continue;
    try {
      const action = actionForTarget(target, name);
      const remainingMs = deadline - now();
      if (remainingMs <= 0) return undefined;
      const available = await withinDeadline(
        probe(action, remainingMs, requireEnabled),
        remainingMs,
        `the Open Wrangler ${JSON.stringify(name)} button`
      );
      assertLifecycle();
      if (available && !isRetired(target)) return { target, action };
    } catch (error) {
      if (now() >= deadline) return undefined;
      ignoreProbeFailure(target, error);
    }
  }
  return undefined;
}

export interface WaitForReplaceableWebviewActionOptions<TAction, TDiagnostics> {
  readonly name: string;
  readonly requireEnabled: boolean;
  readonly discoveryTimeoutMs: number;
  readonly diagnosticTimeoutMs: number;
  readonly findCurrent: (deadline: number) => Promise<TAction | undefined>;
  readonly diagnose: (deadline: number) => Promise<TDiagnostics>;
  readonly assertLifecycle: () => void;
  readonly now?: () => number;
  readonly wait?: (durationMs: number) => Promise<void>;
}

export async function waitForReplaceableWebviewAction<TAction, TDiagnostics>({
  name,
  requireEnabled,
  discoveryTimeoutMs,
  diagnosticTimeoutMs,
  findCurrent,
  diagnose,
  assertLifecycle,
  now = Date.now,
  wait = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs))
}: WaitForReplaceableWebviewActionOptions<TAction, TDiagnostics>): Promise<TAction> {
  const deadline = now() + discoveryTimeoutMs;
  do {
    const available = await findCurrent(deadline);
    if (available) return available;
    await wait(Math.min(50, Math.max(0, deadline - now())));
  } while (now() < deadline);

  const { action, diagnostics } = await diagnoseThenReacquireAcceptanceAction({
    timeoutMs: diagnosticTimeoutMs,
    diagnose,
    reacquire: findCurrent,
    now
  });
  if (action) return action;
  assertLifecycle();
  throw new Error(
    `The Open Wrangler webview did not expose a visible${requireEnabled ? " enabled" : ""} ` +
      `${JSON.stringify(name)} button: ${JSON.stringify(diagnostics)}`
  );
}
