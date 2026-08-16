import { describe, expect, it, vi } from "vitest";
import { findCurrentWebviewAction, waitForReplaceableWebviewAction } from "./extensionHost/webviewActionDiscovery";

interface Target {
  readonly id: string;
}

describe("current webview action discovery", () => {
  it("skips a retired renderer before probing and returns one current ready action", async () => {
    const retired = { id: "retired" };
    const current = { id: "current" };
    const probe = vi.fn(async () => true);

    await expect(
      findCurrentWebviewAction({
        name: "Apply",
        requireEnabled: true,
        deadline: 100,
        targets: () => [retired, current],
        isRetired: (target) => target === retired,
        actionForTarget: (target) => `${target.id}-action`,
        probe,
        withinDeadline: async (pending) => pending,
        assertLifecycle: vi.fn(),
        ignoreProbeFailure: vi.fn(),
        now: () => 0
      })
    ).resolves.toEqual({ target: current, action: "current-action" });
    expect(probe).toHaveBeenCalledOnce();
    expect(probe).toHaveBeenCalledWith("current-action", 100, true);
  });

  it("rejects a renderer retired during readiness and accepts its replacement", async () => {
    const first = { id: "first" };
    const replacement = { id: "replacement" };
    let firstRetired = false;
    const probe = vi.fn(async (action: string) => {
      if (action === "first-action") firstRetired = true;
      return true;
    });

    await expect(
      findCurrentWebviewAction({
        name: "Apply",
        requireEnabled: false,
        deadline: 100,
        targets: () => [first, replacement],
        isRetired: (target) => target === first && firstRetired,
        actionForTarget: (target) => `${target.id}-action`,
        probe,
        withinDeadline: async (pending) => pending,
        assertLifecycle: vi.fn(),
        ignoreProbeFailure: vi.fn(),
        now: () => 0
      })
    ).resolves.toEqual({ target: replacement, action: "replacement-action" });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("stops at the absolute deadline and classifies only pre-deadline probe failures", async () => {
    let now = 100;
    const ignoreProbeFailure = vi.fn();
    const options = {
      name: "Apply",
      requireEnabled: false,
      deadline: 100,
      targets: () => [{ id: "target" } satisfies Target],
      isRetired: () => false,
      actionForTarget: () => "action",
      probe: vi.fn(async () => true),
      withinDeadline: async (pending: Promise<boolean>) => pending,
      assertLifecycle: vi.fn(),
      ignoreProbeFailure,
      now: () => now
    };
    await expect(findCurrentWebviewAction(options)).resolves.toBeUndefined();
    expect(options.probe).not.toHaveBeenCalled();

    now = 0;
    options.probe.mockRejectedValueOnce(new Error("detached"));
    await expect(findCurrentWebviewAction(options)).resolves.toBeUndefined();
    expect(ignoreProbeFailure).toHaveBeenCalledWith({ id: "target" }, expect.objectContaining({ message: "detached" }));
  });
});

describe("replaceable webview action wait", () => {
  it("returns an action discovered during ordinary polling", async () => {
    let now = 0;
    const findCurrent = vi.fn(async () => (now === 0 ? undefined : "current"));
    await expect(
      waitForReplaceableWebviewAction({
        name: "Apply",
        requireEnabled: true,
        discoveryTimeoutMs: 100,
        diagnosticTimeoutMs: 50,
        findCurrent,
        diagnose: vi.fn(async () => ({ targets: 0 })),
        assertLifecycle: vi.fn(),
        now: () => now,
        wait: async (durationMs) => {
          now += durationMs;
        }
      })
    ).resolves.toBe("current");
    expect(findCurrent).toHaveBeenCalledTimes(2);
  });

  it("accepts one replacement acquired after bounded failure diagnostics", async () => {
    let now = 0;
    const findCurrent = vi.fn(async () => (now > 100 ? "replacement" : undefined));
    const diagnose = vi.fn(async () => {
      now = 125;
      return { targets: 2 };
    });

    await expect(
      waitForReplaceableWebviewAction({
        name: "Apply",
        requireEnabled: false,
        discoveryTimeoutMs: 100,
        diagnosticTimeoutMs: 50,
        findCurrent,
        diagnose,
        assertLifecycle: vi.fn(),
        now: () => now,
        wait: async (durationMs) => {
          now += durationMs;
        }
      })
    ).resolves.toBe("replacement");
    expect(diagnose).toHaveBeenCalledOnce();
    expect(findCurrent).toHaveBeenLastCalledWith(150);
  });

  it("fails after diagnostics and one final reacquisition share the failure budget", async () => {
    let now = 0;
    const assertLifecycle = vi.fn();
    const findCurrent = vi.fn(async () => undefined);

    await expect(
      waitForReplaceableWebviewAction({
        name: "Apply",
        requireEnabled: true,
        discoveryTimeoutMs: 100,
        diagnosticTimeoutMs: 50,
        findCurrent,
        diagnose: vi.fn(async () => ({ targets: 0 })),
        assertLifecycle,
        now: () => now,
        wait: async (durationMs) => {
          now += durationMs;
        }
      })
    ).rejects.toThrow(/visible enabled "Apply" button/u);
    expect(findCurrent).toHaveBeenCalledTimes(3);
    expect(assertLifecycle).toHaveBeenCalledOnce();
  });
});
