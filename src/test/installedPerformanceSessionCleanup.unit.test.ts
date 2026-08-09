import { afterEach, describe, expect, it, vi } from "vitest";
import { closeRestoredEditorsBeforeInstalledPerformance } from "./extensionHost/installedPerformance";

afterEach(() => {
  vi.useRealTimers();
});

describe("installed performance session cleanup", () => {
  it("waits for delayed restored-session disposal before a reused source URI opens", async () => {
    vi.useFakeTimers();
    const state = { sessionCount: 1, runtimeRunning: true };
    const closeAllEditors = vi.fn(async () => undefined);
    const openReusedSource = vi.fn();
    const journey = (async () => {
      await closeRestoredEditorsBeforeInstalledPerformance(closeAllEditors, {
        diagnostics: () => ({ sessionCount: state.sessionCount }),
        runtimeRunning: () => state.runtimeRunning
      });
      openReusedSource("file:///workspace/warmup.csv");
    })();

    await Promise.resolve();
    expect(closeAllEditors).toHaveBeenCalledOnce();
    expect(openReusedSource).not.toHaveBeenCalled();

    state.sessionCount = 0;
    await vi.advanceTimersByTimeAsync(20);
    expect(openReusedSource).not.toHaveBeenCalled();

    state.runtimeRunning = false;
    await vi.advanceTimersByTimeAsync(20);
    await journey;

    expect(openReusedSource).toHaveBeenCalledOnce();
    expect(openReusedSource).toHaveBeenCalledWith("file:///workspace/warmup.csv");
  });
});
