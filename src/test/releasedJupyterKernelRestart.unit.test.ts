import { describe, expect, it, vi } from "vitest";
import { restartReleasedJupyterKernelAndWait } from "./extensionHost/releasedJupyterKernelRestart";

class FakeKernel {
  private readonly listeners = new Set<(status: string) => void>();
  readonly dispose = vi.fn();

  constructor(public status: string) {}

  onDidChangeStatus(listener: (status: string) => void): Readonly<{ dispose(): void }> {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
        this.dispose();
      }
    };
  }

  emit(status: string): void {
    this.status = status;
    for (const listener of this.listeners) listener(status);
  }
}

function exactNotebookAssertions(): Readonly<{
  assertExactNotebook: (_notebook: string, description: string) => void;
  descriptions: string[];
}> {
  const descriptions: string[] = [];
  return {
    descriptions,
    assertExactNotebook: (notebook, description) => {
      expect(notebook).toBe("notebook");
      descriptions.push(description);
    }
  };
}

describe("released Jupyter kernel restart", () => {
  it("records dispatch then idle boundaries around one observed same-kernel restart", async () => {
    const kernel = new FakeKernel("idle");
    const checkpoints: string[] = [];
    const exact = exactNotebookAssertions();
    const getKernel = vi.fn(async () => kernel);

    await restartReleasedJupyterKernelAndWait({
      notebook: "notebook",
      activateJupyter: async () => "api",
      getKernel,
      dispatchRestart: async () => {
        kernel.emit("restarting");
        kernel.status = "idle";
      },
      assertExactNotebook: exact.assertExactNotebook,
      checkpoint: (boundary) => checkpoints.push(boundary)
    });

    expect(checkpoints).toEqual(["dispatch:start", "dispatch:complete", "idle:start", "idle:complete"]);
    expect(getKernel).toHaveBeenCalledTimes(2);
    expect(kernel.dispose).toHaveBeenCalledOnce();
    expect(exact.descriptions).toEqual([
      "before acquiring its released Jupyter kernel for restart",
      "after activating released Jupyter for restart observation",
      "after acquiring its released Jupyter kernel for restart",
      "after dispatching the released Jupyter kernel restart",
      "while waiting for its released Jupyter kernel restart",
      "after polling its released Jupyter kernel restart"
    ]);
  });

  it("accepts an exact replacement kernel returning idle", async () => {
    const original = new FakeKernel("idle");
    const replacement = new FakeKernel("idle");
    const getKernel = vi.fn().mockResolvedValueOnce(original).mockResolvedValueOnce(replacement);

    await expect(
      restartReleasedJupyterKernelAndWait({
        notebook: "notebook",
        activateJupyter: async () => "api",
        getKernel,
        dispatchRestart: async () => {},
        assertExactNotebook: () => {}
      })
    ).resolves.toBeUndefined();
    expect(original.dispose).toHaveBeenCalledOnce();
    expect(replacement.dispose).not.toHaveBeenCalled();
  });

  it("treats temporary kernel absence as restart evidence before requiring idle", async () => {
    const original = new FakeKernel("idle");
    const getKernel = vi
      .fn()
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue(original);
    const wait = vi.fn().mockResolvedValue(undefined);

    await restartReleasedJupyterKernelAndWait({
      notebook: "notebook",
      activateJupyter: async () => "api",
      getKernel,
      dispatchRestart: async () => {},
      assertExactNotebook: () => {},
      wait
    });

    expect(wait).toHaveBeenCalledWith(100);
    expect(getKernel).toHaveBeenCalledTimes(3);
    expect(original.dispose).toHaveBeenCalledOnce();
  });

  it("surfaces a rejected restart command with its exact cause and releases the listener", async () => {
    const original = new FakeKernel("idle");
    const failure = new Error("restart rejected");

    await expect(
      restartReleasedJupyterKernelAndWait({
        notebook: "notebook",
        activateJupyter: async () => "api",
        getKernel: async () => original,
        dispatchRestart: () => Promise.reject(failure),
        assertExactNotebook: () => {}
      })
    ).rejects.toMatchObject({
      message: "The released Jupyter kernel restart command was rejected.",
      cause: failure
    });
    expect(original.dispose).toHaveBeenCalledOnce();
  });

  it("times out with command state and bounded observed statuses", async () => {
    const original = new FakeKernel("idle");
    let now = 0;

    await expect(
      restartReleasedJupyterKernelAndWait({
        notebook: "notebook",
        activateJupyter: async () => "api",
        getKernel: async () => original,
        dispatchRestart: async () => {},
        assertExactNotebook: () => {},
        timeoutMs: 20,
        pollIntervalMs: 10,
        now: () => now,
        wait: async (durationMs) => {
          now += durationMs;
        }
      })
    ).rejects.toThrow(
      'Timed out waiting for the released Jupyter kernel to restart and return idle. Command state: fulfilled. Observed statuses: ["idle"]'
    );
    expect(original.dispose).toHaveBeenCalledOnce();
  });

  it("fails before dispatch when the exact notebook has no kernel", async () => {
    const dispatchRestart = vi.fn();
    await expect(
      restartReleasedJupyterKernelAndWait({
        notebook: "notebook",
        activateJupyter: async () => "api",
        getKernel: async () => undefined,
        dispatchRestart,
        assertExactNotebook: () => {}
      })
    ).rejects.toThrow("The released Jupyter kernel must remain available before restart.");
    expect(dispatchRestart).not.toHaveBeenCalled();
  });
});
