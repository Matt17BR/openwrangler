import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import type { ExtensionContext } from "vscode";
import type { PythonBridge, TrustedPicklePythonPreflight } from "../extension/pythonBridge";
import type { AtomicFileTransaction } from "../extension/files/safeFileExport";
import { TrustedPickleProcessTreeUnconfirmedError } from "../extension/files/trustedPickleWorker";

type CommandHandler = (...arguments_: unknown[]) => unknown;

const conversionMocks = vi.hoisted(() => ({
  commands: new Map<string, CommandHandler>(),
  executeCommand: vi.fn(async () => undefined),
  lstat: vi.fn(),
  realpath: vi.fn(),
  showOpenDialog: vi.fn(async () => undefined as unknown),
  showSaveDialog: vi.fn(async () => undefined as unknown),
  showWarningMessage: vi.fn(async () => undefined as string | undefined),
  showInformationMessage: vi.fn(async () => undefined as string | undefined),
  showErrorMessage: vi.fn(async () => undefined),
  activeTabInput: undefined as unknown,
  activeTextUri: undefined as unknown,
  trusted: true
}));

vi.mock("node:fs/promises", () => {
  const module = {
    lstat: conversionMocks.lstat,
    realpath: conversionMocks.realpath,
    open: vi.fn(),
    rename: vi.fn(),
    stat: vi.fn(),
    unlink: vi.fn()
  };
  return { ...module, default: module };
});

vi.mock("vscode", () => {
  class Uri {
    readonly authority = "";
    readonly path: string;

    private constructor(
      readonly scheme: string,
      readonly fsPath: string
    ) {
      this.path = fsPath;
    }

    static file(path: string): Uri {
      return new Uri("file", path);
    }

    toString(): string {
      return `file://${this.fsPath}`;
    }
  }
  class TabInputText {
    constructor(readonly uri: Uri) {}
  }
  class TabInputTextDiff {
    constructor(
      readonly original: Uri,
      readonly modified: Uri
    ) {}
  }
  class TabInputCustom {
    constructor(
      readonly uri: Uri,
      readonly viewType: string
    ) {}
  }
  return {
    Uri,
    TabInputText,
    TabInputTextDiff,
    TabInputCustom,
    ProgressLocation: { Notification: 15 },
    commands: {
      registerCommand: (id: string, handler: CommandHandler) => {
        conversionMocks.commands.set(id, handler);
        return { dispose: () => undefined };
      },
      executeCommand: conversionMocks.executeCommand
    },
    window: {
      tabGroups: {
        activeTabGroup: {
          get activeTab() {
            return conversionMocks.activeTabInput === undefined ? undefined : { input: conversionMocks.activeTabInput };
          }
        }
      },
      get activeTextEditor() {
        return conversionMocks.activeTextUri === undefined
          ? undefined
          : { document: { uri: conversionMocks.activeTextUri } };
      },
      showOpenDialog: conversionMocks.showOpenDialog,
      showSaveDialog: conversionMocks.showSaveDialog,
      showWarningMessage: conversionMocks.showWarningMessage,
      showInformationMessage: conversionMocks.showInformationMessage,
      showErrorMessage: conversionMocks.showErrorMessage,
      withProgress: async <T>(
        _options: unknown,
        task: (
          progress: { report(): void },
          token: {
            isCancellationRequested: boolean;
            onCancellationRequested(listener: () => void): { dispose(): void };
          }
        ) => Promise<T>
      ): Promise<T> =>
        task(
          { report: () => undefined },
          { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) }
        )
    },
    workspace: {
      get isTrusted() {
        return conversionMocks.trusted;
      }
    }
  };
});

import {
  CONVERT_TRUSTED_PICKLE_COMMAND,
  convertTrustedPickle,
  registerTrustedPickleConversion
} from "../extension/files/trustedPickleConversion";

const readyPreflight = (): TrustedPicklePythonPreflight => ({
  executable: "/venv/bin/python",
  version: "3.12.8",
  source: "configuration",
  missing: []
});

describe("trusted pickle conversion command", () => {
  beforeEach(() => {
    conversionMocks.commands.clear();
    conversionMocks.executeCommand.mockClear();
    conversionMocks.showOpenDialog.mockReset().mockResolvedValue(undefined);
    conversionMocks.showSaveDialog.mockReset().mockResolvedValue(undefined);
    conversionMocks.showWarningMessage.mockReset().mockResolvedValue("Convert");
    conversionMocks.showInformationMessage.mockReset().mockResolvedValue(undefined);
    conversionMocks.showErrorMessage.mockClear();
    conversionMocks.activeTabInput = undefined;
    conversionMocks.activeTextUri = undefined;
    conversionMocks.trusted = true;
    conversionMocks.realpath.mockReset().mockImplementation(async (value: string) => value);
    conversionMocks.lstat.mockReset().mockResolvedValue(sourceStat());
  });

  it("registers one separate command", () => {
    const subscriptions: Array<{ dispose(): unknown }> = [];
    registerTrustedPickleConversion({ subscriptions } as unknown as ExtensionContext, bridge(readyPreflight()).value);

    expect(conversionMocks.commands.has(CONVERT_TRUSTED_PICKLE_COMMAND)).toBe(true);
    expect(subscriptions).toHaveLength(1);
  });

  it("does not install dependencies when the Save dialog is cancelled", async () => {
    const missing: TrustedPicklePythonPreflight = { ...readyPreflight(), missing: ["pyarrow"] };
    const currentBridge = bridge(missing);
    const worker = vi.fn(async () => undefined);

    await expect(
      convertTrustedPickle(context(), currentBridge.value, vscode.Uri.file("/workspace/orders.pkl"), {
        runWorker: worker
      })
    ).resolves.toBe(false);

    expect(currentBridge.install).not.toHaveBeenCalled();
    expect(currentBridge.preflight).not.toHaveBeenCalled();
    expect(conversionMocks.showSaveDialog).toHaveBeenCalledWith(expect.objectContaining({ saveLabel: "Save Parquet" }));
    expect(worker).not.toHaveBeenCalled();
  });

  it("does not run a worker when dependency installation is declined", async () => {
    const missing: TrustedPicklePythonPreflight = { ...readyPreflight(), missing: ["pyarrow"] };
    const currentBridge = bridge(missing, { installResult: false });
    conversionMocks.showSaveDialog.mockResolvedValue(vscode.Uri.file("/workspace/orders.parquet"));
    const worker = vi.fn(async () => undefined);

    await expect(
      convertTrustedPickle(context(), currentBridge.value, vscode.Uri.file("/workspace/orders.pkl"), {
        runWorker: worker
      })
    ).resolves.toBe(false);

    expect(currentBridge.install).toHaveBeenCalledOnce();
    expect(currentBridge.install).toHaveBeenCalledWith(missing);
    expect(worker).not.toHaveBeenCalled();
    expect(conversionMocks.showWarningMessage).toHaveBeenCalledOnce();
  });

  it("rejects a non-Parquet destination before starting Python", async () => {
    const currentBridge = bridge(readyPreflight());
    conversionMocks.showSaveDialog.mockResolvedValue(vscode.Uri.file("/workspace/orders.csv"));

    await expect(
      convertTrustedPickle(context(), currentBridge.value, vscode.Uri.file("/workspace/orders.pkl"))
    ).resolves.toBe(false);

    expect(currentBridge.preflight).not.toHaveBeenCalled();
    expect(conversionMocks.showErrorMessage).toHaveBeenCalledWith("Save the converted dataframe as a .parquet file.");
  });

  it("rejects a destination without .parquet instead of guessing an overwrite target", async () => {
    const currentBridge = bridge(readyPreflight());
    conversionMocks.showSaveDialog.mockResolvedValue(vscode.Uri.file("/workspace/orders-clean"));
    const transaction = atomicTransaction();
    const beginTransaction = vi.fn(async () => transaction.value);

    await expect(
      convertTrustedPickle(context(), currentBridge.value, vscode.Uri.file("/workspace/orders.pkl"), {
        beginTransaction,
        runWorker: async () => undefined
      })
    ).resolves.toBe(false);

    expect(beginTransaction).not.toHaveBeenCalled();
    expect(conversionMocks.showErrorMessage).toHaveBeenCalledWith("Save the converted dataframe as a .parquet file.");
  });

  it("stops after the risk warning when the selected interpreter changes", async () => {
    const currentBridge = bridge(readyPreflight(), { current: [false] });
    conversionMocks.showSaveDialog.mockResolvedValue(vscode.Uri.file("/workspace/orders.parquet"));
    const worker = vi.fn(async () => undefined);

    await expect(
      convertTrustedPickle(context(), currentBridge.value, vscode.Uri.file("/workspace/orders.pkl"), {
        runWorker: worker
      })
    ).resolves.toBe(false);

    expect(conversionMocks.showWarningMessage).toHaveBeenCalledOnce();
    expect(worker).not.toHaveBeenCalled();
  });

  it("does not reserve the destination when the interpreter changes after the final warning", async () => {
    const currentBridge = bridge(readyPreflight(), { current: [false] });
    conversionMocks.showSaveDialog.mockResolvedValue(vscode.Uri.file("/workspace/orders.parquet"));
    const transaction = atomicTransaction();
    const beginTransaction = vi.fn(async () => transaction.value);
    const worker = vi.fn(async () => undefined);

    await expect(
      convertTrustedPickle(context(), currentBridge.value, vscode.Uri.file("/workspace/orders.pkl"), {
        beginTransaction,
        runWorker: worker
      })
    ).resolves.toBe(false);

    expect(conversionMocks.showWarningMessage).toHaveBeenCalledWith(
      "Convert orders.pkl with /venv/bin/python?",
      expect.objectContaining({
        modal: true,
        detail: expect.stringMatching(
          /Loading a pickle can run Python code with your user permissions.*Open Wrangler does not overwrite the pickle/u
        )
      }),
      "Convert"
    );
    expect(beginTransaction).not.toHaveBeenCalled();
    expect(transaction.rollback).not.toHaveBeenCalled();
    expect(worker).not.toHaveBeenCalled();
  });

  it("does not reserve the destination when the danger warning is declined", async () => {
    const currentBridge = bridge(readyPreflight());
    conversionMocks.showSaveDialog.mockResolvedValue(vscode.Uri.file("/workspace/orders.parquet"));
    conversionMocks.showWarningMessage.mockResolvedValue(undefined);
    const transaction = atomicTransaction();
    const beginTransaction = vi.fn(async () => transaction.value);
    const worker = vi.fn(async () => undefined);

    await expect(
      convertTrustedPickle(context(), currentBridge.value, vscode.Uri.file("/workspace/orders.pkl"), {
        beginTransaction,
        runWorker: worker
      })
    ).resolves.toBe(false);

    expect(beginTransaction).not.toHaveBeenCalled();
    expect(worker).not.toHaveBeenCalled();
  });

  it("rolls back a reserved destination when the interpreter changes after reservation", async () => {
    const currentBridge = bridge(readyPreflight(), { current: [true, false] });
    conversionMocks.showSaveDialog.mockResolvedValue(vscode.Uri.file("/workspace/orders.parquet"));
    const transaction = atomicTransaction();
    const worker = vi.fn(async () => undefined);

    await expect(
      convertTrustedPickle(context(), currentBridge.value, vscode.Uri.file("/workspace/orders.pkl"), {
        beginTransaction: async () => transaction.value,
        runWorker: worker
      })
    ).resolves.toBe(false);

    expect(transaction.rollback).toHaveBeenCalledOnce();
    expect(transaction.commit).not.toHaveBeenCalled();
    expect(worker).not.toHaveBeenCalled();
  });

  it("re-resolves the selected interpreter once immediately before running the worker", async () => {
    const currentBridge = bridge(readyPreflight(), { revalidate: [false] });
    conversionMocks.showSaveDialog.mockResolvedValue(vscode.Uri.file("/workspace/orders.parquet"));
    const transaction = atomicTransaction();
    const worker = vi.fn(async () => undefined);

    await expect(
      convertTrustedPickle(context(), currentBridge.value, vscode.Uri.file("/workspace/orders.pkl"), {
        beginTransaction: async () => transaction.value,
        runWorker: worker
      })
    ).resolves.toBe(false);

    expect(currentBridge.revalidate).toHaveBeenCalledOnce();
    expect(worker).not.toHaveBeenCalled();
    expect(transaction.rollback).toHaveBeenCalledOnce();
  });

  it("does not invalidate completed work with another interpreter check", async () => {
    const currentBridge = bridge(readyPreflight(), { current: [true, true, true, false] });
    conversionMocks.showSaveDialog.mockResolvedValue(vscode.Uri.file("/workspace/orders.parquet"));
    const transaction = atomicTransaction();
    const worker = vi.fn(async () => undefined);

    await expect(
      convertTrustedPickle(context(), currentBridge.value, vscode.Uri.file("/workspace/orders.pkl"), {
        beginTransaction: async () => transaction.value,
        runWorker: worker
      })
    ).resolves.toBe(true);

    expect(worker).toHaveBeenCalledOnce();
    expect(currentBridge.current).toHaveBeenCalledTimes(3);
    expect(transaction.rollback).not.toHaveBeenCalled();
    expect(transaction.commit).toHaveBeenCalledOnce();
  });

  it("rolls back when the pickle changes while the worker is running", async () => {
    const currentBridge = bridge(readyPreflight());
    conversionMocks.showSaveDialog.mockResolvedValue(vscode.Uri.file("/workspace/orders.parquet"));
    conversionMocks.lstat.mockReset();
    for (let call = 0; call < 4; call += 1) conversionMocks.lstat.mockResolvedValueOnce(sourceStat());
    conversionMocks.lstat.mockResolvedValueOnce(sourceStat({ mtimeNs: 99n }));
    const transaction = atomicTransaction();
    const worker = vi.fn(async () => undefined);

    await expect(
      convertTrustedPickle(context(), currentBridge.value, vscode.Uri.file("/workspace/orders.pkl"), {
        beginTransaction: async () => transaction.value,
        runWorker: worker
      })
    ).resolves.toBe(false);

    expect(worker).toHaveBeenCalledOnce();
    expect(transaction.rollback).toHaveBeenCalledOnce();
    expect(transaction.commit).not.toHaveBeenCalled();
  });

  it("does not remove the unpublished output when worker-tree shutdown is uncertain", async () => {
    const currentBridge = bridge(readyPreflight());
    conversionMocks.showSaveDialog.mockResolvedValue(vscode.Uri.file("/workspace/orders.parquet"));
    const transaction = atomicTransaction();
    const worker = vi.fn(async () => {
      throw new TrustedPickleProcessTreeUnconfirmedError(
        new Error("conversion cancelled"),
        new Error("tree still running")
      );
    });

    await expect(
      convertTrustedPickle(context(), currentBridge.value, vscode.Uri.file("/workspace/orders.pkl"), {
        beginTransaction: async () => transaction.value,
        runWorker: worker
      })
    ).resolves.toBe(false);

    expect(worker).toHaveBeenCalledOnce();
    expect(transaction.rollback).not.toHaveBeenCalled();
    expect(transaction.abandon).toHaveBeenCalledOnce();
    expect(transaction.commit).not.toHaveBeenCalled();
    expect(conversionMocks.showErrorMessage).toHaveBeenCalledWith(
      expect.stringMatching(/could not confirm.*stopped.*left in place/u)
    );
  });

  it("commits the converted Parquet and optionally opens it", async () => {
    const currentBridge = bridge(readyPreflight());
    const destination = vscode.Uri.file("/workspace/orders.parquet");
    conversionMocks.showSaveDialog.mockResolvedValue(destination);
    conversionMocks.showInformationMessage.mockResolvedValue("Open in Open Wrangler");
    const transaction = atomicTransaction();
    const worker = vi.fn(async () => undefined);

    await expect(
      convertTrustedPickle(context(), currentBridge.value, vscode.Uri.file("/workspace/orders.pkl"), {
        beginTransaction: async () => transaction.value,
        runWorker: worker
      })
    ).resolves.toBe(true);

    expect(worker).toHaveBeenCalledWith(
      expect.objectContaining({
        executable: "/venv/bin/python",
        sourcePath: "/workspace/orders.pkl",
        destinationPath: "/workspace/.openwrangler-temp.parquet",
        destinationIdentity: { dev: 5n, ino: 6n },
        sourceFingerprint: { dev: 1n, ino: 2n, size: 100n, mtimeNs: 3n, ctimeNs: 4n }
      })
    );
    expect(transaction.prepareExternalWriter).toHaveBeenCalledOnce();
    expect(transaction.commit).toHaveBeenCalledOnce();
    expect(transaction.rollback).not.toHaveBeenCalled();
    expect(conversionMocks.executeCommand).toHaveBeenCalledWith("openWrangler.openFile", destination);
    expect(currentBridge.revalidate).toHaveBeenCalledOnce();
    expect(currentBridge.current).toHaveBeenCalledTimes(3);
  });

  it("rechecks dependencies after installation without reusing the missing result", async () => {
    const missing: TrustedPicklePythonPreflight = { ...readyPreflight(), missing: ["pyarrow"] };
    const currentBridge = bridge(missing, { preflights: [missing, readyPreflight()] });
    conversionMocks.showSaveDialog.mockResolvedValue(vscode.Uri.file("/workspace/orders.parquet"));
    const transaction = atomicTransaction();
    const worker = vi.fn(async () => undefined);

    await expect(
      convertTrustedPickle(context(), currentBridge.value, vscode.Uri.file("/workspace/orders.pkl"), {
        beginTransaction: async () => transaction.value,
        runWorker: worker
      })
    ).resolves.toBe(true);

    expect(currentBridge.install).toHaveBeenCalledOnce();
    expect(currentBridge.preflight).toHaveBeenCalledTimes(2);
    expect(currentBridge.preflight).toHaveBeenNthCalledWith(1, vscode.Uri.file("/workspace/orders.pkl"));
    expect(currentBridge.preflight).toHaveBeenNthCalledWith(2, vscode.Uri.file("/workspace/orders.pkl"), missing);
    expect(currentBridge.revalidate).toHaveBeenCalledOnce();
    expect(worker).toHaveBeenCalledOnce();
  });

  it("stops after installation when the exact selected interpreter is no longer current", async () => {
    const missing: TrustedPicklePythonPreflight = { ...readyPreflight(), missing: ["pyarrow"] };
    const currentBridge = bridge(missing, {
      current: [true, false],
      preflights: [missing, readyPreflight()]
    });
    conversionMocks.showSaveDialog.mockResolvedValue(vscode.Uri.file("/workspace/orders.parquet"));
    const transaction = atomicTransaction();
    const beginTransaction = vi.fn(async () => transaction.value);
    const worker = vi.fn(async () => undefined);

    await expect(
      convertTrustedPickle(context(), currentBridge.value, vscode.Uri.file("/workspace/orders.pkl"), {
        beginTransaction,
        runWorker: worker
      })
    ).resolves.toBe(false);

    expect(currentBridge.install).toHaveBeenCalledOnce();
    expect(currentBridge.preflight).toHaveBeenCalledTimes(2);
    expect(conversionMocks.showWarningMessage).toHaveBeenCalledOnce();
    expect(beginTransaction).not.toHaveBeenCalled();
    expect(worker).not.toHaveBeenCalled();
  });

  it("does not install missing packages when the user declines the risk warning", async () => {
    const missing: TrustedPicklePythonPreflight = { ...readyPreflight(), missing: ["pyarrow"] };
    const currentBridge = bridge(missing);
    conversionMocks.showSaveDialog.mockResolvedValue(vscode.Uri.file("/workspace/orders.parquet"));
    conversionMocks.showWarningMessage.mockResolvedValue(undefined);

    await expect(
      convertTrustedPickle(context(), currentBridge.value, vscode.Uri.file("/workspace/orders.pkl"))
    ).resolves.toBe(false);

    expect(currentBridge.install).not.toHaveBeenCalled();
  });

  it("opens the pickle picker when the active editor is not a local pickle", async () => {
    const subscriptions: Array<{ dispose(): unknown }> = [];
    const currentBridge = bridge(readyPreflight());
    registerTrustedPickleConversion({ subscriptions } as unknown as ExtensionContext, currentBridge.value);
    conversionMocks.activeTabInput = new vscode.TabInputText(vscode.Uri.file("/workspace/orders.csv"));
    conversionMocks.activeTextUri = vscode.Uri.file("/workspace/orders.csv");
    conversionMocks.showOpenDialog.mockResolvedValue([vscode.Uri.file("/workspace/orders.pkl")]);

    await expect(conversionMocks.commands.get(CONVERT_TRUSTED_PICKLE_COMMAND)?.()).resolves.toBe(false);

    expect(conversionMocks.showOpenDialog).toHaveBeenCalledOnce();
    expect(conversionMocks.showSaveDialog).toHaveBeenCalledOnce();
    expect(currentBridge.preflight).not.toHaveBeenCalled();
  });
});

function bridge(
  initial: TrustedPicklePythonPreflight,
  options: {
    current?: boolean[];
    installResult?: boolean;
    preflights?: TrustedPicklePythonPreflight[];
    revalidate?: boolean[];
  } = {}
): {
  value: PythonBridge;
  current: ReturnType<typeof vi.fn>;
  install: ReturnType<typeof vi.fn>;
  preflight: ReturnType<typeof vi.fn>;
  revalidate: ReturnType<typeof vi.fn>;
  lease: ReturnType<typeof vi.fn>;
} {
  const install = vi.fn(async () => options.installResult ?? true);
  const current = [...(options.current ?? [])];
  const currentCheck = vi.fn(() => current.shift() ?? true);
  const preflights = [...(options.preflights ?? [initial])];
  let lastPreflight = initial;
  const preflight = vi.fn(async (_resource?: vscode.Uri, _expected?: TrustedPicklePythonPreflight) => {
    lastPreflight = preflights.shift() ?? lastPreflight;
    return lastPreflight;
  });
  const revalidations = [...(options.revalidate ?? [])];
  const revalidate = vi.fn(async () => revalidations.shift() ?? true);
  const lease = vi.fn(async (_preflight: TrustedPicklePythonPreflight, run: () => Promise<unknown>) => run());
  return {
    current: currentCheck,
    install,
    preflight,
    revalidate,
    lease,
    value: {
      preflightTrustedPickleConversion: preflight,
      installTrustedPickleDependencies: install,
      isTrustedPicklePreflightCurrent: currentCheck,
      revalidateTrustedPicklePreflight: revalidate,
      withTrustedPicklePreflightLease: lease
    } as unknown as PythonBridge
  };
}

function atomicTransaction(): {
  value: AtomicFileTransaction;
  commit: ReturnType<typeof vi.fn>;
  prepareExternalWriter: ReturnType<typeof vi.fn>;
  rollback: ReturnType<typeof vi.fn>;
  abandon: ReturnType<typeof vi.fn>;
} {
  const commit = vi.fn(async () => undefined);
  const prepareExternalWriter = vi.fn(async () => ({
    path: "/workspace/.openwrangler-temp.parquet",
    identity: { dev: 5n, ino: 6n }
  }));
  const rollback = vi.fn(async () => undefined);
  const abandon = vi.fn(async () => undefined);
  return {
    value: {
      temporaryPath: "/workspace/.openwrangler-temp.parquet",
      prepareExternalWriter,
      commit,
      rollback,
      abandon
    },
    commit,
    prepareExternalWriter,
    rollback,
    abandon
  };
}

function context(): ExtensionContext {
  return {
    asAbsolutePath: (value: string) => `/extension/${value}`
  } as unknown as ExtensionContext;
}

function sourceStat(
  overrides: Partial<{
    dev: bigint;
    ino: bigint;
    size: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
  }> = {}
): {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  isFile(): boolean;
  isSymbolicLink(): boolean;
} {
  return {
    dev: overrides.dev ?? 1n,
    ino: overrides.ino ?? 2n,
    size: overrides.size ?? 100n,
    mtimeNs: overrides.mtimeNs ?? 3n,
    ctimeNs: overrides.ctimeNs ?? 4n,
    isFile: () => true,
    isSymbolicLink: () => false
  };
}
