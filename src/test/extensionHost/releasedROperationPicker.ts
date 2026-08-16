import * as assert from "node:assert/strict";
import type { Frame, Locator, Page } from "playwright-core";
import {
  exactSessionApp,
  reacquireAcknowledgedSessionApp as reacquireAcknowledgedSessionAppOwner,
  sameRendererSynchronizationReceipt,
  type RendererSynchronizationReceipt
} from "./acknowledgedRenderer";
import type { TestApi } from "./extensionHostTestApi";
import {
  AcceptanceActionNotDispatchedError,
  activateExactAcceptanceElementOnce,
  withAcceptanceOperationDeadline
} from "./playwrightLifecycle";

interface OpenWranglerGridTarget {
  readonly frame: Frame;
}

export interface ReleasedROperationPickerDependencies {
  readonly requireFreshExactSessionPanelHydration: (
    testing: TestApi,
    sessionId: string,
    expectation: string
  ) => Promise<void>;
  readonly waitForOpenWranglerGridTarget: (
    workbench: Page,
    testing: TestApi,
    expectedSessionId: string,
    expectedRendererSynchronizationReceipt?: RendererSynchronizationReceipt
  ) => Promise<OpenWranglerGridTarget>;
}

export function createReleasedROperationPicker(dependencies: ReleasedROperationPickerDependencies) {
  const { requireFreshExactSessionPanelHydration, waitForOpenWranglerGridTarget } = dependencies;

  async function openReleasedROperationPicker(
    testing: TestApi,
    workbench: Page,
    sessionId: string
  ): Promise<Readonly<{ app: Locator; dialog: Locator }>> {
    type RendererReceipt = NonNullable<ReturnType<TestApi["panelSynchronizationReceipt"]>>;
    const acquire = async (expected?: RendererReceipt) => {
      const app =
        expected === undefined
          ? await synchronizedSessionApp(
              workbench,
              testing,
              sessionId,
              "The native R operation picker requires the acknowledged renderer."
            )
          : await reacquireAcknowledgedSessionApp(
              workbench,
              testing,
              sessionId,
              "The replacement R operation picker requires its exact acknowledged renderer."
            );
      const receipt = testing.panelSynchronizationReceipt(sessionId);
      assert.ok(receipt, "The native R operation picker requires one renderer receipt.");
      assert.equal(
        expected === undefined || sameRendererSynchronizationReceipt(expected, receipt),
        true,
        "The replacement R operation picker must bind the requested renderer receipt."
      );
      return {
        app,
        button: app.getByRole("button", { name: "Add step", exact: true }),
        dialog: app.getByRole("dialog", { name: "Add cleaning step" }),
        receipt
      };
    };
    type PickerTarget = Awaited<ReturnType<typeof acquire>>;
    const click = async (expected?: RendererReceipt): Promise<PickerTarget> => {
      const deadline = Date.now() + 10_000;
      let wanted = expected;
      let lastError: unknown;
      do {
        let target: PickerTarget;
        let element: Awaited<ReturnType<PickerTarget["button"]["elementHandle"]>>;
        try {
          target = await withAcceptanceOperationDeadline(
            acquire(wanted),
            Math.max(1, deadline - Date.now()),
            "the native R Add step renderer acquisition"
          );
          wanted = target.receipt;
          const remainingMs = Math.max(1, deadline - Date.now());
          await target.button.click({ trial: true, timeout: remainingMs });
          if (!sameRendererSynchronizationReceipt(target.receipt, testing.panelSynchronizationReceipt(sessionId))) {
            wanted = testing.panelSynchronizationReceipt(sessionId);
            continue;
          }
          element = await target.button.elementHandle({ timeout: Math.max(1, deadline - Date.now()) });
          assert.ok(element, "The native R renderer must expose one exact Add step action.");
        } catch (error) {
          lastError = error;
          const current = testing.panelSynchronizationReceipt(sessionId);
          if (current) wanted = current;
          if (Date.now() < deadline) await workbench.waitForTimeout(50);
          continue;
        }
        try {
          await activateExactAcceptanceElementOnce(element, Math.max(1, deadline - Date.now()), () => {
            if (!sameRendererSynchronizationReceipt(target.receipt, testing.panelSynchronizationReceipt(sessionId))) {
              throw new AcceptanceActionNotDispatchedError(
                "The native R Add step renderer changed immediately before its click",
                new Error("The acknowledged renderer receipt changed.")
              );
            }
          });
          return target;
        } catch (error) {
          if (!(error instanceof AcceptanceActionNotDispatchedError)) throw error;
          lastError = error;
        } finally {
          await element.dispose();
        }
        const current = testing.panelSynchronizationReceipt(sessionId);
        if (current) wanted = current;
        if (Date.now() < deadline) await workbench.waitForTimeout(50);
      } while (Date.now() < deadline);
      const detail = lastError instanceof Error ? `${lastError.name}: ${lastError.message}` : String(lastError);
      throw new AcceptanceActionNotDispatchedError(
        `The native R Add step action did not become actionable (${detail.slice(0, 512)})`,
        lastError
      );
    };
    const observe = async (
      target: PickerTarget
    ): Promise<Readonly<{ app: Locator; dialog: Locator }> | RendererReceipt> => {
      const deadline = Date.now() + 10_000;
      do {
        const current = testing.panelSynchronizationReceipt(sessionId);
        if (current && !sameRendererSynchronizationReceipt(target.receipt, current)) return current;
        if (
          sameRendererSynchronizationReceipt(target.receipt, current) &&
          (await target.dialog.isVisible().catch(() => false))
        ) {
          const confirmed = testing.panelSynchronizationReceipt(sessionId);
          if (sameRendererSynchronizationReceipt(target.receipt, confirmed)) {
            return { app: target.app, dialog: target.dialog };
          }
          if (confirmed) return confirmed;
        }
        await workbench.waitForTimeout(50);
      } while (Date.now() < deadline);
      const active = testing.activeSession();
      throw new Error(
        `The native R operation picker did not appear. ${JSON.stringify({
          receipt: testing.panelSynchronizationReceipt(sessionId),
          hydrated: testing.panelHydrated(sessionId),
          scheduler: testing.sessionSchedulerState(sessionId),
          revision: active?.metadata.revision,
          draft: active?.metadata.draftStep?.kind
        })}`
      );
    };

    let outcome = await observe(await click());
    if ("app" in outcome) return outcome;
    outcome = await observe(await click(outcome));
    if ("app" in outcome) return outcome;
    throw new Error("The native R operation picker was retired after one safe retry.");
  }

  async function releasedRSessionApp(
    workbench: Page,
    testing: TestApi,
    sessionId: string,
    description: string
  ): Promise<Locator> {
    // Applied-step inspection is deliberately cleared when a renderer is
    // regenerated. Confirmed and draft states can be forced to a fresh
    // generation; an active inspection must render on the existing one.
    if (testing.activeSession()?.stepInspection === undefined) {
      return synchronizedSessionApp(
        workbench,
        testing,
        sessionId,
        `${description} must render the current confirmed session state.`
      );
    }
    const target = await waitForOpenWranglerGridTarget(workbench, testing, sessionId);
    const app = await exactSessionApp(target.frame, sessionId);
    assert.ok(app, `${description} requires its exact Open Wrangler renderer.`);
    return app;
  }

  async function synchronizedSessionApp(
    workbench: Page,
    testing: TestApi,
    sessionId: string,
    expectation: string
  ): Promise<Locator> {
    await requireFreshExactSessionPanelHydration(testing, sessionId, expectation);
    const receipt = testing.panelSynchronizationReceipt(sessionId);
    assert.ok(receipt, `${expectation} The host must retain its acknowledged renderer receipt.`);
    const target = await waitForOpenWranglerGridTarget(workbench, testing, sessionId, receipt);
    const app = await exactSessionApp(target.frame, sessionId, receipt.syncId);
    assert.ok(app, `${expectation} The acknowledged renderer must expose the exact Open Wrangler session.`);
    assert.equal(
      sameRendererSynchronizationReceipt(receipt, testing.panelSynchronizationReceipt(sessionId)),
      true,
      `${expectation} The renderer receipt must remain unchanged through acquisition.`
    );
    return app;
  }

  async function reacquireAcknowledgedSessionApp(
    workbench: Page,
    testing: TestApi,
    sessionId: string,
    expectation: string
  ): Promise<Locator> {
    return reacquireAcknowledgedSessionAppOwner(
      testing,
      sessionId,
      expectation,
      (receipt) => waitForOpenWranglerGridTarget(workbench, testing, sessionId, receipt),
      (target, synchronizationId) => exactSessionApp(target.frame, sessionId, synchronizationId)
    );
  }

  return Object.freeze({
    openReleasedROperationPicker,
    reacquireAcknowledgedSessionApp,
    releasedRSessionApp,
    synchronizedSessionApp
  });
}
