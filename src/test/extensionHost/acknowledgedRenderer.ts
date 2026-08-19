import * as assert from "node:assert/strict";

export interface RendererSynchronizationReceipt {
  readonly syncId: string;
  readonly sessionId: string;
  readonly revision: number;
}

export interface LayoutCommittedRendererSynchronizationReceipt extends RendererSynchronizationReceipt {
  readonly layoutTransitionPending: false;
}

export interface AcknowledgedRendererApi {
  panelHydrated(sessionId: string): boolean;
  panelSynchronizationReceipt(sessionId: string): RendererSynchronizationReceipt | undefined;
}

export interface LayoutCommittedRendererApi {
  panelHydrated(sessionId: string): boolean;
  panelSynchronizationReceipt(
    sessionId: string
  ): (RendererSynchronizationReceipt & Readonly<{ layoutTransitionPending: boolean }>) | undefined;
}

export async function consumeLayoutCommittedRendererValue<T>(
  testing: LayoutCommittedRendererApi,
  sessionId: string,
  revision: number,
  waitFor: (predicate: () => boolean, timeoutMs: number, expectation: string) => Promise<void>,
  consume: (receipt: LayoutCommittedRendererSynchronizationReceipt) => Promise<T>
): Promise<T> {
  let committed: LayoutCommittedRendererSynchronizationReceipt | undefined;
  await waitFor(
    () => {
      const current = testing.panelSynchronizationReceipt(sessionId);
      if (
        testing.panelHydrated(sessionId) &&
        current?.sessionId === sessionId &&
        current.revision === revision &&
        current.layoutTransitionPending === false
      ) {
        committed = current as LayoutCommittedRendererSynchronizationReceipt;
        return true;
      }
      return false;
    },
    10_000,
    "one exact acknowledged renderer to commit its existing layout"
  );
  assert.ok(committed, "The exact renderer never committed its layout before the acquisition deadline.");

  const assertSameCommittedReceipt = (phase: string): void => {
    assert.equal(testing.panelHydrated(sessionId), true, `${phase} The exact renderer must remain hydrated.`);
    const current = testing.panelSynchronizationReceipt(sessionId);
    assert.equal(
      sameRendererSynchronizationReceipt(committed, current),
      true,
      `${phase} The committed renderer receipt was superseded.`
    );
    assert.equal(current?.layoutTransitionPending, false, `${phase} The exact renderer layout is no longer committed.`);
  };

  assertSameCommittedReceipt("Before consuming the renderer-owned value.");
  const value = await consume(committed);
  assertSameCommittedReceipt("After consuming the renderer-owned value.");
  return value;
}

export async function reacquireLayoutCommittedRendererTarget<T>(
  testing: LayoutCommittedRendererApi,
  sessionId: string,
  expectedReceipt: LayoutCommittedRendererSynchronizationReceipt,
  reacquire: () => Promise<T>
): Promise<T> {
  const target = await reacquire();
  assert.equal(
    testing.panelHydrated(sessionId),
    true,
    "The reacquired committed renderer must remain hydrated before its DOM is read."
  );
  const current = testing.panelSynchronizationReceipt(sessionId);
  assert.equal(
    sameRendererSynchronizationReceipt(expectedReceipt, current),
    true,
    "The committed renderer receipt was superseded during reacquisition."
  );
  assert.equal(
    current?.layoutTransitionPending,
    false,
    "The reacquired renderer layout must remain committed before its DOM is read."
  );
  return target;
}

export interface CountedLocator {
  count(): Promise<number>;
}

export interface LocatorFrame<TLocator extends CountedLocator> {
  locator(selector: string): TLocator;
}

export async function exactSessionApp<TLocator extends CountedLocator>(
  frame: LocatorFrame<TLocator>,
  expectedSessionId: string,
  expectedRendererSynchronizationId?: string
): Promise<TLocator | undefined> {
  assert.match(expectedSessionId, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u);
  if (expectedRendererSynchronizationId !== undefined) {
    assert.match(expectedRendererSynchronizationId, /^[A-Za-z0-9]{32}$/u);
  }
  const synchronizationSelector =
    expectedRendererSynchronizationId === undefined
      ? ""
      : `[data-renderer-sync-id="${expectedRendererSynchronizationId}"]`;
  const app = frame.locator(`main.app[data-session-id="${expectedSessionId}"]${synchronizationSelector}`);
  return (await app.count()) === 1 ? app : undefined;
}

export function sameRendererSynchronizationReceipt(
  left: RendererSynchronizationReceipt | undefined,
  right: RendererSynchronizationReceipt | undefined
): boolean {
  return left?.syncId === right?.syncId && left?.sessionId === right?.sessionId && left?.revision === right?.revision;
}

export async function reacquireAcknowledgedSessionApp<TTarget, TLocator>(
  testing: AcknowledgedRendererApi,
  sessionId: string,
  expectation: string,
  findTarget: (receipt: RendererSynchronizationReceipt) => Promise<TTarget>,
  appForTarget: (target: TTarget, synchronizationId: string) => Promise<TLocator | undefined>
): Promise<TLocator> {
  const receipt = testing.panelSynchronizationReceipt(sessionId);
  assert.ok(receipt, `${expectation} The host must retain its acknowledged renderer receipt.`);
  assert.equal(testing.panelHydrated(sessionId), true, `${expectation} The current renderer must remain hydrated.`);
  const target = await findTarget(receipt);
  const app = await appForTarget(target, receipt.syncId);
  assert.ok(app, `${expectation} The current acknowledged renderer must expose the exact session.`);
  assert.equal(
    sameRendererSynchronizationReceipt(receipt, testing.panelSynchronizationReceipt(sessionId)),
    true,
    `${expectation} The renderer receipt must remain unchanged through acquisition.`
  );
  return app;
}
