import * as assert from "node:assert/strict";

export interface RendererSynchronizationReceipt {
  readonly syncId: string;
  readonly sessionId: string;
  readonly revision: number;
}

export interface AcknowledgedRendererApi {
  panelHydrated(sessionId: string): boolean;
  panelSynchronizationReceipt(sessionId: string): RendererSynchronizationReceipt | undefined;
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
