import { describe, expect, it, vi } from "vitest";
import {
  acquirePreparedAcceptanceAction,
  activateAcceptancePointerTargetAtCurrentCenter,
  activateReplaceableAcceptanceLocator,
  IndeterminateAcceptanceActionError,
  ignoreRetiredRendererProbeFailure,
  invokeAcceptanceActionOnce,
  invokeAcceptanceActionOnceWithAuthoritativeReceipt,
  isRetiredRendererTarget,
  pollAcceptanceCondition,
  pressKeyboardKeyPairWithoutTransitionGap,
  probeRendererButtonReadiness,
  withAcceptanceOperationDeadline
} from "./extensionHost/playwrightLifecycle";

interface FakeFrame {
  isDetached(): boolean;
}

interface FakePage {
  isClosed(): boolean;
  mainFrame(): FakeFrame;
}

function frame(detached = false): FakeFrame {
  return { isDetached: () => detached };
}

function page(mainFrame: FakeFrame, closed = false): FakePage {
  return {
    isClosed: () => closed,
    mainFrame: () => mainFrame
  };
}

const connectedBrowser = { isConnected: () => true };

describe("extension-host Playwright lifecycle", () => {
  it("invokes an acceptance action once and treats its receipt as completion", async () => {
    const events: string[] = [];
    const result = await invokeAcceptanceActionOnce({
      description: "the notebook action",
      activate: vi.fn(async () => {
        events.push("activate");
      }),
      receipt: vi.fn(async () => {
        events.push("receipt");
        return "input";
      })
    });

    expect(result).toBe("input");
    expect(events).toEqual(["activate", "receipt"]);
  });

  it("observes natural launch-surface dismissal without issuing cleanup input", async () => {
    const events: string[] = [];
    let resolveReceipt!: (value: string) => void;
    let resolveDismissal!: () => void;
    const receipt = new Promise<string>((resolve) => {
      resolveReceipt = resolve;
    });
    const dismissal = new Promise<void>((resolve) => {
      resolveDismissal = resolve;
    });
    const outcome = invokeAcceptanceActionOnce({
      description: "the notebook overflow action",
      activate: vi.fn(async () => {
        events.push("activate");
      }),
      receipt: vi.fn(() => {
        events.push("receipt-started");
        return receipt;
      }),
      naturalDismissal: vi.fn(() => {
        events.push("dismissal-observed");
        return dismissal;
      })
    });

    await vi.waitFor(() => expect(events).toEqual(["activate", "receipt-started", "dismissal-observed"]));
    resolveDismissal();
    resolveReceipt("input");
    await expect(outcome).resolves.toBe("input");
  });

  it("classifies a one-shot user-activation failure as indeterminate without requesting a receipt", async () => {
    const failure = new Error("CDP response was lost");
    const activate = vi.fn().mockRejectedValue(failure);
    const receipt = vi.fn().mockResolvedValue("input");
    const naturalDismissal = vi.fn().mockResolvedValue(undefined);

    await expect(
      invokeAcceptanceActionOnce({
        description: "the notebook overflow action",
        activate,
        receipt,
        naturalDismissal
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<IndeterminateAcceptanceActionError>>({
        name: "IndeterminateAcceptanceActionError",
        cause: failure
      })
    );
    expect(activate).toHaveBeenCalledOnce();
    expect(receipt).not.toHaveBeenCalled();
    expect(naturalDismissal).not.toHaveBeenCalled();
  });

  it("accepts an authoritative receipt after an indeterminate activation without retrying the action", async () => {
    const events: string[] = [];
    const activationFailure = new Error("CDP response was lost");
    const activate = vi.fn(async () => {
      events.push("activate");
      throw activationFailure;
    });
    const receipt = vi.fn(async () => {
      events.push("ordinary receipt");
      return "ordinary receipt";
    });
    const authoritativeReceiptAfterActivationFailure = vi.fn(async () => {
      events.push("authoritative receipt");
      return "opened session";
    });
    const naturalDismissal = vi.fn(async () => {
      events.push("natural dismissal");
    });

    await expect(
      invokeAcceptanceActionOnceWithAuthoritativeReceipt({
        description: "the notebook variable action",
        activate,
        receipt,
        authoritativeReceiptAfterActivationFailure,
        naturalDismissal
      })
    ).resolves.toBe("opened session");
    expect(events).toEqual(["activate", "authoritative receipt"]);
    expect(activate).toHaveBeenCalledOnce();
    expect(receipt).not.toHaveBeenCalled();
    expect(authoritativeReceiptAfterActivationFailure).toHaveBeenCalledOnce();
    expect(naturalDismissal).not.toHaveBeenCalled();
  });

  it("retains an indeterminate activation and a missing authoritative receipt without retrying the action", async () => {
    const activationFailure = new Error("CDP response was lost");
    const receiptFailure = new Error("the session did not open");
    const activate = vi.fn().mockRejectedValue(activationFailure);
    const receipt = vi.fn().mockResolvedValue("ordinary receipt");
    const authoritativeReceiptAfterActivationFailure = vi.fn().mockRejectedValue(receiptFailure);

    await expect(
      invokeAcceptanceActionOnceWithAuthoritativeReceipt({
        description: "the notebook variable action",
        activate,
        receipt,
        authoritativeReceiptAfterActivationFailure
      })
    ).rejects.toMatchObject({
      message: "the notebook variable action did not settle and its authoritative receipt could not prove dispatch.",
      errors: [
        expect.objectContaining({
          name: "IndeterminateAcceptanceActionError",
          cause: activationFailure
        }),
        receiptFailure
      ]
    });
    expect(activate).toHaveBeenCalledOnce();
    expect(receipt).not.toHaveBeenCalled();
    expect(authoritativeReceiptAfterActivationFailure).toHaveBeenCalledOnce();
  });

  it("uses the ordinary receipt after a settled activation and does not request authoritative recovery", async () => {
    const activate = vi.fn().mockResolvedValue(undefined);
    const receipt = vi.fn().mockResolvedValue("ordinary receipt");
    const authoritativeReceiptAfterActivationFailure = vi.fn().mockResolvedValue("opened session");

    await expect(
      invokeAcceptanceActionOnceWithAuthoritativeReceipt({
        description: "the notebook variable action",
        activate,
        receipt,
        authoritativeReceiptAfterActivationFailure
      })
    ).resolves.toBe("ordinary receipt");
    expect(activate).toHaveBeenCalledOnce();
    expect(receipt).toHaveBeenCalledOnce();
    expect(authoritativeReceiptAfterActivationFailure).not.toHaveBeenCalled();
  });

  it("does not treat an ordinary receipt failure as an indeterminate activation", async () => {
    const receiptFailure = new Error("the ordinary receipt is missing");
    const activate = vi.fn().mockResolvedValue(undefined);
    const receipt = vi.fn().mockRejectedValue(receiptFailure);
    const authoritativeReceiptAfterActivationFailure = vi.fn().mockResolvedValue("opened session");

    await expect(
      invokeAcceptanceActionOnceWithAuthoritativeReceipt({
        description: "the notebook variable action",
        activate,
        receipt,
        authoritativeReceiptAfterActivationFailure
      })
    ).rejects.toBe(receiptFailure);
    expect(activate).toHaveBeenCalledOnce();
    expect(receipt).toHaveBeenCalledOnce();
    expect(authoritativeReceiptAfterActivationFailure).not.toHaveBeenCalled();
  });

  it("reacquires an acceptance action replaced during discovery or pre-click preparation", async () => {
    const replaced = new Error("element was detached");
    const staleAction = { id: "stale" };
    const readyAction = { id: "ready" };
    const acquire = vi
      .fn()
      .mockRejectedValueOnce(replaced)
      .mockResolvedValueOnce(staleAction)
      .mockResolvedValueOnce(readyAction);
    const prepare = vi.fn(async (action: { id: string }) => {
      if (action === staleAction) throw replaced;
    });
    const dispose = vi.fn().mockResolvedValue(undefined);
    let currentTime = 0;
    const wait = vi.fn(async (durationMs: number) => {
      currentTime += durationMs;
    });

    await expect(
      acquirePreparedAcceptanceAction({
        acquire,
        prepare,
        dispose,
        isRetryablePreparationError: (error) => error === replaced,
        timeoutMs: 100,
        intervalMs: 10,
        now: () => currentTime,
        wait
      })
    ).resolves.toBe(readyAction);
    expect(acquire).toHaveBeenCalledTimes(3);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(dispose).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledWith(staleAction);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it("never reacquires after a prepared acceptance action enters its one-shot activation", async () => {
    const action = { id: "ready" };
    const acquire = vi.fn().mockResolvedValue(action);
    const prepared = await acquirePreparedAcceptanceAction({
      acquire,
      prepare: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
      isRetryablePreparationError: () => true,
      timeoutMs: 100,
      intervalMs: 10
    });
    expect(prepared).toBe(action);

    const activationFailure = new Error("the user activation did not settle");
    const activate = vi.fn().mockRejectedValue(activationFailure);
    await expect(
      invokeAcceptanceActionOnce({
        description: "the prepared variable action",
        activate,
        receipt: vi.fn().mockResolvedValue("opened")
      })
    ).rejects.toMatchObject({
      name: "IndeterminateAcceptanceActionError",
      cause: activationFailure
    });
    expect(acquire).toHaveBeenCalledOnce();
    expect(activate).toHaveBeenCalledOnce();
  });

  it("clicks the locator's replacement target exactly once when the prepared DOM node is retired", async () => {
    const originalClick = vi.fn();
    const replacementClick = vi.fn();
    let currentTarget = { click: originalClick };
    let continueResolution!: () => void;
    const resolutionGate = new Promise<void>((resolve) => {
      continueResolution = resolve;
    });
    const locator = {
      click: vi.fn(async () => {
        await resolutionGate;
        currentTarget.click();
      })
    };

    const activation = activateReplaceableAcceptanceLocator(locator, 10_000);
    currentTarget = { click: replacementClick };
    continueResolution();
    await activation;

    expect(locator.click).toHaveBeenCalledOnce();
    expect(locator.click).toHaveBeenCalledWith({ timeout: 10_000 });
    expect(originalClick).not.toHaveBeenCalled();
    expect(replacementClick).toHaveBeenCalledOnce();
  });

  it("sends one physical click to the exact target's verified current center", async () => {
    const ownerPointer = { click: vi.fn().mockResolvedValue(undefined) };
    const nonOwnerPointer = { click: vi.fn().mockResolvedValue(undefined) };
    const target = {
      pointer: ownerPointer,
      boundingBox: vi.fn().mockResolvedValue({ x: 10, y: 20, width: 80, height: 30 }),
      evaluate: vi.fn().mockResolvedValue(true)
    };

    await activateAcceptancePointerTargetAtCurrentCenter(target, 10_000);

    expect(target.boundingBox).toHaveBeenCalledOnce();
    expect(target.evaluate).toHaveBeenCalledOnce();
    expect(ownerPointer.click).toHaveBeenCalledOnce();
    expect(ownerPointer.click).toHaveBeenCalledWith(50, 35);
    expect(nonOwnerPointer.click).not.toHaveBeenCalled();
  });

  it("does not dispatch a pointer click when the exact target no longer owns its center", async () => {
    const pointer = { click: vi.fn().mockResolvedValue(undefined) };
    const target = {
      pointer,
      boundingBox: vi.fn().mockResolvedValue({ x: 10, y: 20, width: 80, height: 30 }),
      evaluate: vi.fn().mockResolvedValue(false)
    };

    await expect(activateAcceptancePointerTargetAtCurrentCenter(target, 10_000)).rejects.toThrow(
      "The exact acceptance pointer target does not own its current center point."
    );
    expect(pointer.click).not.toHaveBeenCalled();
  });

  it("retains both a missing receipt and failed natural dismissal", async () => {
    const receiptFailure = new Error("input missing");
    const dismissalFailure = new Error("menu remained open");

    await expect(
      invokeAcceptanceActionOnce({
        description: "the notebook overflow action",
        activate: vi.fn().mockResolvedValue(undefined),
        receipt: vi.fn().mockRejectedValue(receiptFailure),
        naturalDismissal: vi.fn().mockRejectedValue(dismissalFailure)
      })
    ).rejects.toMatchObject({
      message: "the notebook overflow action did not publish its receipt or dismiss its launch surface naturally.",
      errors: [receiptFailure, dismissalFailure]
    });
  });

  it("clears its deadline after an operation settles", async () => {
    vi.useFakeTimers();
    try {
      await expect(withAcceptanceOperationDeadline(Promise.resolve("ready"), 10_000, "the workbench")).resolves.toBe(
        "ready"
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a stalled operation at its local deadline", async () => {
    vi.useFakeTimers();
    try {
      const outcome = withAcceptanceOperationDeadline(new Promise<never>(() => undefined), 10_000, "the prompt");
      const assertion = expect(outcome).rejects.toThrow("Timed out waiting for the prompt after 10000 ms.");
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves an operation's own failure", async () => {
    const error = new Error("locator failed");
    await expect(withAcceptanceOperationDeadline(Promise.reject(error), 10_000, "the prompt")).rejects.toBe(error);
  });

  it("polls a naturally transferred focus state without assigning focus", async () => {
    const probe = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const wait = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    await expect(pollAcceptanceCondition(probe, { timeoutMs: 500, intervalMs: 50, wait })).resolves.toBe(true);
    expect(probe).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenNthCalledWith(1, 50);
    expect(wait).toHaveBeenNthCalledWith(2, 50);
  });

  it("stops natural-focus polling at its exact deadline", async () => {
    const probe = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);
    let currentTime = 0;
    const wait = vi.fn<(durationMs: number) => Promise<void>>(async (durationMs) => {
      currentTime += durationMs;
    });

    await expect(
      pollAcceptanceCondition(probe, {
        timeoutMs: 100,
        intervalMs: 25,
        now: () => currentTime,
        wait
      })
    ).resolves.toBe(false);
    expect(probe).toHaveBeenCalledTimes(5);
    expect(wait).toHaveBeenCalledTimes(4);
  });

  it("queues key-up before a transitioning-QuickInput key-down acknowledgement and awaits key-down", async () => {
    let resolveKeyDown!: () => void;
    const keyDown = new Promise<void>((resolve) => {
      resolveKeyDown = resolve;
    });
    const keyboard = {
      down: vi.fn().mockReturnValue(keyDown),
      up: vi.fn().mockResolvedValue(undefined)
    };

    const outcome = pressKeyboardKeyPairWithoutTransitionGap(keyboard, "Enter");
    let settled = false;
    void outcome.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await Promise.resolve();

    expect(keyboard.down).toHaveBeenCalledWith("Enter");
    expect(keyboard.up).toHaveBeenCalledWith("Enter");
    expect(settled).toBe(false);

    resolveKeyDown();
    await expect(outcome).resolves.toBeUndefined();
  });

  it("awaits transitioning-QuickInput key-up completion after key-down settles", async () => {
    let resolveKeyUp!: () => void;
    const keyUp = new Promise<void>((resolve) => {
      resolveKeyUp = resolve;
    });
    const keyboard = {
      down: vi.fn().mockResolvedValue(undefined),
      up: vi.fn().mockReturnValue(keyUp)
    };

    const outcome = pressKeyboardKeyPairWithoutTransitionGap(keyboard, "Enter");
    let settled = false;
    void outcome.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await Promise.resolve();

    expect(settled).toBe(false);

    resolveKeyUp();
    await expect(outcome).resolves.toBeUndefined();
  });

  it.each(["down", "up"] as const)("propagates a transitioning-QuickInput key-%s failure", async (failedEvent) => {
    const error = new Error(`${failedEvent} failed`);
    const keyboard = {
      down: vi.fn().mockImplementation(async () => {
        if (failedEvent === "down") throw error;
      }),
      up: vi.fn().mockImplementation(async () => {
        if (failedEvent === "up") throw error;
      })
    };

    await expect(pressKeyboardKeyPairWithoutTransitionGap(keyboard, "Enter")).rejects.toBe(error);
    expect(keyboard.down).toHaveBeenCalledWith("Enter");
    expect(keyboard.up).toHaveBeenCalledWith("Enter");
  });

  it("awaits the peer keyboard event before propagating an early transitioning-QuickInput failure", async () => {
    const error = new Error("key-down failed");
    let resolveKeyUp!: () => void;
    const keyUp = new Promise<void>((resolve) => {
      resolveKeyUp = resolve;
    });
    const keyboard = {
      down: vi.fn().mockRejectedValue(error),
      up: vi.fn().mockReturnValue(keyUp)
    };

    const outcome = pressKeyboardKeyPairWithoutTransitionGap(keyboard, "Enter");
    let settled = false;
    void outcome.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveKeyUp();
    await expect(outcome).rejects.toBe(error);
  });

  it("retains both failures when both transitioning-QuickInput keyboard events reject", async () => {
    const keyDownError = new Error("key-down failed");
    const keyUpError = new Error("key-up failed");
    const keyboard = {
      down: vi.fn().mockRejectedValue(keyDownError),
      up: vi.fn().mockRejectedValue(keyUpError)
    };

    const outcome = pressKeyboardKeyPairWithoutTransitionGap(keyboard, "Enter");
    await expect(outcome).rejects.toMatchObject({
      message: "Both transitioning-QuickInput keyboard events failed.",
      errors: [keyDownError, keyUpError]
    });
  });

  it("reports an absent renderer button without probing presentation or enabled state", async () => {
    const button = {
      count: vi.fn().mockResolvedValue(0),
      isVisible: vi.fn().mockResolvedValue(true),
      isEnabled: vi.fn().mockResolvedValue(true)
    };

    await expect(probeRendererButtonReadiness(button, 1_000)).resolves.toBe(false);
    expect(button.count).toHaveBeenCalledOnce();
    expect(button.isVisible).not.toHaveBeenCalled();
    expect(button.isEnabled).not.toHaveBeenCalled();
  });

  it("reports a hidden renderer button without probing enabled state", async () => {
    const button = {
      count: vi.fn().mockResolvedValue(1),
      isVisible: vi.fn().mockResolvedValue(false),
      isEnabled: vi.fn().mockResolvedValue(true)
    };

    await expect(probeRendererButtonReadiness(button, 1_000)).resolves.toBe(false);
    expect(button.count).toHaveBeenCalledOnce();
    expect(button.isVisible).toHaveBeenCalledOnce();
    expect(button.isEnabled).not.toHaveBeenCalled();
  });

  it("reports a visible disabled renderer button as unavailable", async () => {
    const button = {
      count: vi.fn().mockResolvedValue(1),
      isVisible: vi.fn().mockResolvedValue(true),
      isEnabled: vi.fn().mockResolvedValue(false)
    };

    await expect(probeRendererButtonReadiness(button, 1_000)).resolves.toBe(false);
    expect(button.count).toHaveBeenCalledOnce();
    expect(button.isVisible).toHaveBeenCalledOnce();
    expect(button.isEnabled).toHaveBeenCalledWith({ timeout: 1_000 });
  });

  it("reports a visible enabled renderer button without scrolling, focusing, or clicking", async () => {
    const button = {
      count: vi.fn().mockResolvedValue(1),
      isVisible: vi.fn().mockResolvedValue(true),
      isEnabled: vi.fn().mockResolvedValue(true),
      scrollIntoViewIfNeeded: vi.fn(),
      focus: vi.fn(),
      click: vi.fn()
    };

    await expect(probeRendererButtonReadiness(button, 1_000)).resolves.toBe(true);
    expect(button.count).toHaveBeenCalledOnce();
    expect(button.isVisible).toHaveBeenCalledOnce();
    expect(button.isEnabled).toHaveBeenCalledWith({ timeout: 1_000 });
    expect(button.scrollIntoViewIfNeeded).not.toHaveBeenCalled();
    expect(button.focus).not.toHaveBeenCalled();
    expect(button.click).not.toHaveBeenCalled();
  });

  it("keeps a stalled renderer readiness probe inside its explicit operation deadline", async () => {
    vi.useFakeTimers();
    try {
      const button = {
        count: vi.fn(() => new Promise<number>(() => undefined)),
        isVisible: vi.fn().mockResolvedValue(true),
        isEnabled: vi.fn().mockResolvedValue(true)
      };
      const outcome = withAcceptanceOperationDeadline(
        probeRendererButtonReadiness(button, 1_000),
        1_000,
        "the renderer readiness probe"
      );
      const assertion = expect(outcome).rejects.toThrow(
        "Timed out waiting for the renderer readiness probe after 1000 ms."
      );

      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
      expect(button.count).toHaveBeenCalledOnce();
      expect(button.isVisible).not.toHaveBeenCalled();
      expect(button.isEnabled).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retires a closed auxiliary page without treating the workbench as closed", () => {
    const workbench = page(frame());
    const auxiliary = page(frame(true), true);

    expect(isRetiredRendererTarget(workbench, auxiliary, auxiliary.mainFrame())).toBe(true);
    expect(() =>
      ignoreRetiredRendererProbeFailure(
        workbench,
        connectedBrowser,
        auxiliary,
        auxiliary.mainFrame(),
        new Error("target closed")
      )
    ).not.toThrow();
  });

  it("retires detached renderer frames, including workbench child frames", () => {
    const workbenchMain = frame();
    const workbench = page(workbenchMain);
    const rendererFrame = frame(true);

    expect(isRetiredRendererTarget(workbench, workbench, rendererFrame)).toBe(true);
    expect(() =>
      ignoreRetiredRendererProbeFailure(
        workbench,
        connectedBrowser,
        workbench,
        rendererFrame,
        new Error("locator.count: Frame was detached")
      )
    ).not.toThrow();
  });

  it("fails closed when the workbench closes", () => {
    const workbenchMain = frame(true);
    const workbench = page(workbenchMain, true);
    const auxiliary = page(frame(true), true);
    const error = new Error("workbench closed");

    expect(() =>
      ignoreRetiredRendererProbeFailure(workbench, connectedBrowser, auxiliary, auxiliary.mainFrame(), error)
    ).toThrow(error);
  });

  it("fails closed when the CDP browser disconnects", () => {
    const workbench = page(frame());
    const auxiliary = page(frame(true), true);
    const error = new Error("browser disconnected");

    expect(() =>
      ignoreRetiredRendererProbeFailure(
        workbench,
        { isConnected: () => false },
        auxiliary,
        auxiliary.mainFrame(),
        error
      )
    ).toThrow(error);
  });

  it("does not retire the detached workbench main frame", () => {
    const workbenchMain = frame(true);
    const workbench = page(workbenchMain);
    const error = new Error("locator.count: Frame was detached");

    expect(isRetiredRendererTarget(workbench, workbench, workbenchMain)).toBe(false);
    expect(() =>
      ignoreRetiredRendererProbeFailure(workbench, connectedBrowser, workbench, workbenchMain, error)
    ).toThrow(error);
  });

  it("rethrows an unrelated locator failure from a live target", () => {
    const workbench = page(frame());
    const auxiliaryMain = frame();
    const auxiliary = page(auxiliaryMain);
    const error = new Error("locator failed");

    expect(isRetiredRendererTarget(workbench, auxiliary, auxiliaryMain)).toBe(false);
    expect(() =>
      ignoreRetiredRendererProbeFailure(workbench, connectedBrowser, auxiliary, auxiliaryMain, error)
    ).toThrow(error);
  });
});
