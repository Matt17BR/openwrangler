export type ReleasedJupyterKernelRestartBoundary =
  "dispatch:start" | "dispatch:complete" | "idle:start" | "idle:complete";

interface ReleasedJupyterKernel {
  readonly status: string;
  onDidChangeStatus(listener: (status: string) => void): Readonly<{ dispose(): void }>;
}

export interface ReleasedJupyterKernelRestartOptions<Api, Notebook, Kernel extends ReleasedJupyterKernel> {
  readonly notebook: Notebook;
  readonly activateJupyter: () => PromiseLike<Api>;
  readonly getKernel: (api: Api, notebook: Notebook) => PromiseLike<Kernel | undefined>;
  readonly dispatchRestart: (notebook: Notebook) => PromiseLike<unknown>;
  readonly assertExactNotebook: (notebook: Notebook, description: string) => void;
  readonly checkpoint?: (boundary: ReleasedJupyterKernelRestartBoundary) => void;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  readonly wait?: (durationMs: number) => Promise<void>;
}

export async function restartReleasedJupyterKernelAndWait<Api, Notebook, Kernel extends ReleasedJupyterKernel>({
  notebook,
  activateJupyter,
  getKernel,
  dispatchRestart,
  assertExactNotebook,
  checkpoint,
  timeoutMs = 90_000,
  pollIntervalMs = 100,
  now = Date.now,
  wait = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs))
}: ReleasedJupyterKernelRestartOptions<Api, Notebook, Kernel>): Promise<void> {
  assertExactNotebook(notebook, "before acquiring its released Jupyter kernel for restart");
  const api = await activateJupyter();
  assertExactNotebook(notebook, "after activating released Jupyter for restart observation");
  const originalKernel = await getKernel(api, notebook);
  assertExactNotebook(notebook, "after acquiring its released Jupyter kernel for restart");
  if (!originalKernel) throw new Error("The released Jupyter kernel must remain available before restart.");

  let restartDispatched = false;
  let observedRestart = false;
  let restartCommandState: "pending" | "fulfilled" | "rejected" = "pending";
  let restartCommandError: unknown;
  const statuses = new Set<string>();
  const recordStatus = (status: string): void => {
    statuses.add(status);
    if (restartDispatched && status !== "idle") observedRestart = true;
  };
  const throwIfRestartCommandRejected = (): void => {
    if (restartCommandState === "rejected") {
      throw new Error("The released Jupyter kernel restart command was rejected.", {
        cause: restartCommandError
      });
    }
  };
  recordStatus(originalKernel.status);
  const statusListener = originalKernel.onDidChangeStatus(recordStatus);
  try {
    const deadline = now() + timeoutMs;
    checkpoint?.("dispatch:start");
    restartDispatched = true;
    const restartCommand = dispatchRestart(notebook);
    void Promise.resolve(restartCommand).then(
      () => {
        restartCommandState = "fulfilled";
      },
      (error: unknown) => {
        restartCommandState = "rejected";
        restartCommandError = error;
      }
    );
    assertExactNotebook(notebook, "after dispatching the released Jupyter kernel restart");
    checkpoint?.("dispatch:complete");
    checkpoint?.("idle:start");

    do {
      throwIfRestartCommandRejected();
      assertExactNotebook(notebook, "while waiting for its released Jupyter kernel restart");
      const currentKernel = await getKernel(api, notebook);
      assertExactNotebook(notebook, "after polling its released Jupyter kernel restart");
      if (!currentKernel) {
        observedRestart = true;
      } else {
        recordStatus(currentKernel.status);
        if (currentKernel !== originalKernel) observedRestart = true;
        throwIfRestartCommandRejected();
        if (observedRestart && currentKernel.status === "idle") {
          checkpoint?.("idle:complete");
          return;
        }
      }
      assertExactNotebook(notebook, "before delaying its released Jupyter kernel restart poll");
      await wait(pollIntervalMs);
      assertExactNotebook(notebook, "after delaying its released Jupyter kernel restart poll");
    } while (now() < deadline);
    throw new Error(
      `Timed out waiting for the released Jupyter kernel to restart and return idle. ` +
        `Command state: ${restartCommandState}. Observed statuses: ${JSON.stringify([...statuses])}`
    );
  } finally {
    statusListener.dispose();
  }
}
