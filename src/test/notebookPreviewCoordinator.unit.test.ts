import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NotebookDocument } from "vscode";

type Listener<T> = (value: T) => void;

const mocks = vi.hoisted(() => {
  const channels = {
    open: new Set<Listener<NotebookDocument>>(),
    close: new Set<Listener<NotebookDocument>>(),
    active: new Set<Listener<{ notebook: NotebookDocument } | undefined>>(),
    visible: new Set<Listener<readonly { notebook: NotebookDocument }[]>>(),
    change: new Set<Listener<{ notebook: NotebookDocument }>>(),
    configuration: new Set<Listener<{ affectsConfiguration(section: string): boolean }>>()
  };
  return {
    channels,
    registrationAttempt: 0,
    failRegistrationAttempt: undefined as number | undefined,
    commands: new Map<string, (...args: unknown[]) => unknown>(),
    documents: [] as NotebookDocument[],
    visibleEditors: [] as Array<{ notebook: NotebookDocument }>,
    extensions: new Set(["ms-toolsai.jupyter"]),
    statusBarProviders: [] as Array<{
      notebookType: string;
      provider: { provideCellStatusBarItems(cell: { notebook: NotebookDocument }): unknown };
    }>,
    preference: "ask",
    prepare: vi.fn<() => Promise<void>>(async () => undefined),
    disposeBridge: vi.fn(),
    failInvalidationRegistration: false,
    invalidationListeners: new Set<() => void>(),
    information: vi.fn(async () => undefined as string | undefined),
    quickPick: vi.fn(async () => undefined as { value: string } | undefined),
    updateSetting: vi.fn(async (_key: string, value: string) => {
      mocks.preference = value;
      for (const listener of mocks.channels.configuration) {
        listener({ affectsConfiguration: (section) => section === "openWrangler.notebookPreviewProvider" });
      }
    })
  };
});

function event<T>(listeners: Set<Listener<T>>) {
  return (listener: Listener<T>) => {
    mocks.registrationAttempt += 1;
    if (mocks.registrationAttempt === mocks.failRegistrationAttempt) {
      throw new Error("notebook preview listener registration failed");
    }
    listeners.add(listener);
    return { dispose: () => listeners.delete(listener) };
  };
}

vi.mock("vscode", () => ({
  ConfigurationTarget: { Global: 1 },
  workspace: {
    isTrusted: true,
    get notebookDocuments() {
      return mocks.documents;
    },
    getConfiguration: () => ({ get: (_key: string, fallback: string) => mocks.preference || fallback }),
    onDidOpenNotebookDocument: event(mocks.channels.open),
    onDidCloseNotebookDocument: event(mocks.channels.close),
    onDidChangeNotebookDocument: event(mocks.channels.change),
    onDidChangeConfiguration: event(mocks.channels.configuration)
  },
  window: {
    get visibleNotebookEditors() {
      return mocks.visibleEditors;
    },
    onDidChangeActiveNotebookEditor: event(mocks.channels.active),
    onDidChangeVisibleNotebookEditors: event(mocks.channels.visible),
    showInformationMessage: mocks.information,
    showQuickPick: mocks.quickPick
  },
  extensions: {
    getExtension: (id: string) => (mocks.extensions.has(id) ? { id } : undefined)
  },
  notebooks: {
    registerNotebookCellStatusBarItemProvider: (
      notebookType: string,
      provider: { provideCellStatusBarItems(cell: { notebook: NotebookDocument }): unknown }
    ) => {
      mocks.registrationAttempt += 1;
      if (mocks.registrationAttempt === mocks.failRegistrationAttempt) {
        throw new Error("notebook preview provider registration failed");
      }
      const registration = { notebookType, provider };
      mocks.statusBarProviders.push(registration);
      return {
        dispose: () => {
          const index = mocks.statusBarProviders.indexOf(registration);
          if (index >= 0) mocks.statusBarProviders.splice(index, 1);
        }
      };
    }
  },
  commands: {
    registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
      mocks.registrationAttempt += 1;
      if (mocks.registrationAttempt === mocks.failRegistrationAttempt) {
        throw new Error("notebook preview command registration failed");
      }
      mocks.commands.set(id, handler);
      return { dispose: () => mocks.commands.delete(id) };
    }
  }
}));

vi.mock("../extension/configuration", () => ({
  updateSetting: mocks.updateSetting
}));

vi.mock("../extension/notebooks/notebookProvenance", () => ({
  isSoleOpenNotebookDocument: () => true
}));

vi.mock("../extension/notebooks/kernelBridge", () => ({
  NotebookFormatterPreparationPendingError: class extends Error {
    constructor(readonly settlement: Promise<{ readonly kind: string }>) {
      super("Formatter preparation is still settling.");
      this.name = "NotebookFormatterPreparationPendingError";
    }
  },
  KernelBridge: class {
    readonly onDidInvalidateKernel = (listener: () => void) => {
      if (mocks.failInvalidationRegistration) throw new Error("kernel invalidation registration failed");
      mocks.invalidationListeners.add(listener);
      return { dispose: () => mocks.invalidationListeners.delete(listener) };
    };
    prepareNotebookFormatter = mocks.prepare;
    dispose = mocks.disposeBridge;
  },
  shouldRegisterNotebookFormatters: () =>
    mocks.preference === "openWrangler" ||
    (mocks.preference === "ask" && !mocks.extensions.has("ms-toolsai.datawrangler"))
}));

import { NotebookFormatterPreparationPendingError } from "../extension/notebooks/kernelBridge";
import {
  isNotebookPreviewProviderPromptTerminated,
  NotebookPreviewCoordinator,
  onDidTerminateNotebookPreviewProviderPrompt,
  requestNotebookPreviewProviderPrompt
} from "../extension/notebooks/notebookPreviewCoordinator";

describe("NotebookPreviewCoordinator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.commands.clear();
    mocks.registrationAttempt = 0;
    mocks.failRegistrationAttempt = undefined;
    mocks.documents.splice(0);
    mocks.visibleEditors.splice(0);
    mocks.statusBarProviders.splice(0);
    mocks.extensions.clear();
    mocks.extensions.add("ms-toolsai.jupyter");
    mocks.preference = "ask";
    mocks.prepare.mockReset().mockResolvedValue(undefined);
    mocks.disposeBridge.mockReset();
    mocks.failInvalidationRegistration = false;
    mocks.invalidationListeners.clear();
    mocks.information.mockReset().mockResolvedValue(undefined);
    mocks.quickPick.mockReset().mockResolvedValue(undefined);
    mocks.updateSetting.mockClear();
    for (const channel of Object.values(mocks.channels)) channel.clear();
  });

  it("disposes every real provider and listener retained before a mid-constructor failure", () => {
    mocks.failRegistrationAttempt = 6;

    expect(() => new NotebookPreviewCoordinator({} as never)).toThrow("notebook preview listener registration failed");

    expect(mocks.statusBarProviders).toEqual([]);
    expect(mocks.commands.size).toBe(0);
    for (const listeners of Object.values(mocks.channels)) expect(listeners.size).toBe(0);
  });

  it("disposes a bridge and all outer registrations when invalidation registration throws", () => {
    const notebook = fakeNotebook();
    mocks.documents.push(notebook);
    mocks.visibleEditors.push({ notebook });
    mocks.failInvalidationRegistration = true;

    expect(() => new NotebookPreviewCoordinator({} as never)).toThrow("kernel invalidation registration failed");

    expect(mocks.disposeBridge).toHaveBeenCalledOnce();
    expect(mocks.statusBarProviders).toEqual([]);
    expect(mocks.commands.size).toBe(0);
    for (const listeners of Object.values(mocks.channels)) expect(listeners.size).toBe(0);
  });

  it.each(["jupyter-notebook", "interactive"])(
    "prepares the first visible %s document without a prompt when there is no competing provider",
    async (notebookType) => {
      const notebook = fakeNotebook(notebookType);
      mocks.documents.push(notebook);
      mocks.visibleEditors.push({ notebook });
      const coordinator = new NotebookPreviewCoordinator({} as never);

      await vi.runOnlyPendingTimersAsync();

      expect(mocks.prepare).toHaveBeenCalledOnce();
      expect(mocks.information).not.toHaveBeenCalled();
      coordinator.dispose();
    }
  );

  it("starts first-result formatter preparation before yielding to a timer turn", async () => {
    const notebook = fakeNotebook();
    mocks.documents.push(notebook);
    mocks.visibleEditors.push({ notebook });
    const coordinator = new NotebookPreviewCoordinator({} as never);

    expect(vi.getTimerCount()).toBe(0);
    await vi.runAllTicks();

    expect(mocks.prepare).toHaveBeenCalledOnce();
    coordinator.dispose();
  });

  it("keeps Interactive Window formatter preparation single-flight across overlapping notebook events", async () => {
    const notebook = fakeNotebook("interactive");
    const preparation = deferred<void>();
    mocks.documents.push(notebook);
    mocks.visibleEditors.push({ notebook });
    mocks.prepare.mockImplementationOnce(() => preparation.promise);
    const coordinator = new NotebookPreviewCoordinator({} as never);

    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.prepare).toHaveBeenCalledOnce();

    for (const listener of mocks.channels.active) listener({ notebook });
    for (const listener of mocks.channels.visible) listener(mocks.visibleEditors);
    for (const listener of mocks.channels.change) listener({ notebook });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.prepare).toHaveBeenCalledOnce();

    preparation.resolve(undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.prepare).toHaveBeenCalledOnce();
    coordinator.dispose();
  });

  it("keeps idle and kernel-selection-era status queries prompt-free", async () => {
    const notebook = fakeNotebook();
    mocks.documents.push(notebook);
    mocks.visibleEditors.push({ notebook });
    mocks.extensions.add("ms-toolsai.datawrangler");
    const coordinator = new NotebookPreviewCoordinator({} as never);

    for (const { provider } of mocks.statusBarProviders) {
      expect(provider.provideCellStatusBarItems({ notebook })).toBeUndefined();
    }
    for (const listener of mocks.channels.active) listener({ notebook });
    await vi.runOnlyPendingTimersAsync();

    expect(mocks.information).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
    coordinator.dispose();
  });

  it("prompts once from concurrent exact candidates and leaves the kernel untouched for Data Wrangler", async () => {
    const notebook = fakeNotebook();
    mocks.documents.push(notebook);
    mocks.visibleEditors.push({ notebook });
    mocks.extensions.add("ms-toolsai.datawrangler");
    mocks.information.mockResolvedValue("Keep Data Wrangler");
    const coordinator = new NotebookPreviewCoordinator({} as never);

    const first = requestNotebookPreviewProviderPrompt(notebook);
    const concurrent = requestNotebookPreviewProviderPrompt(notebook);
    await Promise.all([first, concurrent]);

    expect(mocks.information).toHaveBeenCalledOnce();
    expect(mocks.updateSetting).toHaveBeenCalledWith("notebookPreviewProvider", "dataWrangler", 1);
    expect(mocks.prepare).not.toHaveBeenCalled();
    coordinator.dispose();
  });

  it("prepares Open Wrangler immediately when it wins the one-time renderer conflict", async () => {
    const notebook = fakeNotebook();
    mocks.documents.push(notebook);
    mocks.visibleEditors.push({ notebook });
    mocks.extensions.add("ms-toolsai.datawrangler");
    mocks.information.mockResolvedValue("Use Open Wrangler");
    const coordinator = new NotebookPreviewCoordinator({} as never);

    await vi.runOnlyPendingTimersAsync();
    expect(mocks.information).not.toHaveBeenCalled();
    await requestNotebookPreviewProviderPrompt(notebook);
    await vi.runOnlyPendingTimersAsync();

    expect(mocks.information).toHaveBeenCalledOnce();
    expect(mocks.updateSetting).toHaveBeenCalledWith("notebookPreviewProvider", "openWrangler", 1);
    expect(mocks.prepare).toHaveBeenCalledOnce();
    coordinator.dispose();
  });

  it("publishes one terminal signal when the unresolved provider prompt is dismissed", async () => {
    const notebook = fakeNotebook();
    mocks.documents.push(notebook);
    mocks.visibleEditors.push({ notebook });
    mocks.extensions.add("ms-toolsai.datawrangler");
    const coordinator = new NotebookPreviewCoordinator({} as never);
    const termination = vi.fn();
    const subscription = onDidTerminateNotebookPreviewProviderPrompt(termination);

    await requestNotebookPreviewProviderPrompt(notebook);

    expect(termination).toHaveBeenCalledOnce();
    expect(isNotebookPreviewProviderPromptTerminated()).toBe(true);
    expect(mocks.updateSetting).not.toHaveBeenCalled();
    const lateTermination = vi.fn();
    const lateSubscription = onDidTerminateNotebookPreviewProviderPrompt(lateTermination);
    expect(lateTermination).toHaveBeenCalledOnce();
    lateSubscription.dispose();
    subscription.dispose();
    coordinator.dispose();
  });

  it("terminates a retained provider request on disposal without replaying a late selection", async () => {
    const notebook = fakeNotebook();
    const selection = deferred<string | undefined>();
    mocks.documents.push(notebook);
    mocks.visibleEditors.push({ notebook });
    mocks.extensions.add("ms-toolsai.datawrangler");
    mocks.information.mockImplementationOnce(() => selection.promise);
    const coordinator = new NotebookPreviewCoordinator({} as never);
    const termination = vi.fn();
    const subscription = onDidTerminateNotebookPreviewProviderPrompt(termination);

    const request = requestNotebookPreviewProviderPrompt(notebook);
    await vi.runAllTicks();
    coordinator.dispose();

    expect(termination).toHaveBeenCalledOnce();
    selection.resolve("Use Open Wrangler");
    await expect(request).resolves.toBe(false);
    expect(mocks.updateSetting).not.toHaveBeenCalled();
    subscription.dispose();
  });

  it.each(["Use Open Wrangler", "Keep Data Wrangler"])(
    "publishes terminal prompt state and preserves a rejected %s preference write",
    async (selection) => {
      const notebook = fakeNotebook();
      mocks.documents.push(notebook);
      mocks.visibleEditors.push({ notebook });
      mocks.extensions.add("ms-toolsai.datawrangler");
      mocks.information.mockResolvedValue(selection);
      mocks.updateSetting.mockRejectedValueOnce(new Error("configuration write rejected"));
      const coordinator = new NotebookPreviewCoordinator({} as never);
      const termination = vi.fn();
      const subscription = onDidTerminateNotebookPreviewProviderPrompt(termination);

      await expect(
        (
          coordinator as unknown as {
            promptForConflictProvider(): Promise<boolean>;
          }
        ).promptForConflictProvider()
      ).rejects.toThrow("configuration write rejected");

      expect(termination).toHaveBeenCalledOnce();
      expect(isNotebookPreviewProviderPromptTerminated()).toBe(true);
      expect(mocks.preference).toBe("ask");
      subscription.dispose();
      coordinator.dispose();
    }
  );

  it("reinstalls the Open Wrangler formatter after a kernel invalidation", async () => {
    const notebook = fakeNotebook();
    mocks.documents.push(notebook);
    mocks.visibleEditors.push({ notebook });
    const coordinator = new NotebookPreviewCoordinator({} as never);
    await vi.runOnlyPendingTimersAsync();
    expect(mocks.prepare).toHaveBeenCalledOnce();

    for (const listener of mocks.invalidationListeners) listener();
    await vi.runOnlyPendingTimersAsync();

    expect(mocks.prepare).toHaveBeenCalledTimes(2);
    coordinator.dispose();
  });

  it("retries a formatter that is not ready yet without requiring another notebook event", async () => {
    const notebook = fakeNotebook();
    mocks.documents.push(notebook);
    mocks.visibleEditors.push({ notebook });
    mocks.prepare.mockRejectedValueOnce(new Error("Kernel is still starting")).mockResolvedValueOnce(undefined);
    const coordinator = new NotebookPreviewCoordinator({} as never);

    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.prepare).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(499);
    expect(mocks.prepare).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.prepare).toHaveBeenCalledTimes(2);
    coordinator.dispose();
  });

  it("parks one timed-out formatter attempt until its underlying kernel execution actually settles", async () => {
    const notebook = fakeNotebook();
    const settlement = deferred<{ readonly kind: "prepared" }>();
    mocks.documents.push(notebook);
    mocks.visibleEditors.push({ notebook });
    mocks.prepare.mockRejectedValueOnce(new NotebookFormatterPreparationPendingError(settlement.promise));
    const coordinator = new NotebookPreviewCoordinator({} as never);

    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.prepare).toHaveBeenCalledOnce();
    expect(mocks.invalidationListeners.size).toBe(1);

    for (let index = 0; index < 20; index += 1) {
      for (const listener of mocks.channels.change) listener({ notebook });
      await vi.advanceTimersByTimeAsync(15_000);
    }

    expect(mocks.prepare).toHaveBeenCalledOnce();
    expect(mocks.invalidationListeners.size).toBe(1);
    expect(vi.getTimerCount()).toBe(0);

    settlement.resolve({ kind: "prepared" });
    await vi.advanceTimersByTimeAsync(0);
    for (const listener of mocks.channels.change) listener({ notebook });
    await vi.advanceTimersByTimeAsync(15_000);

    expect(mocks.prepare).toHaveBeenCalledOnce();
    expect(mocks.invalidationListeners.size).toBe(1);
    coordinator.dispose();
  });

  it("lets a visible notebook change bypass a pending kernel-not-ready backoff", async () => {
    const notebook = fakeNotebook();
    mocks.documents.push(notebook);
    mocks.visibleEditors.push({ notebook });
    mocks.prepare.mockRejectedValueOnce(new Error("Kernel is not started")).mockResolvedValueOnce(undefined);
    const coordinator = new NotebookPreviewCoordinator({} as never);

    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.prepare).toHaveBeenCalledOnce();

    for (const listener of mocks.channels.change) listener({ notebook });
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.prepare).toHaveBeenCalledTimes(2);
    coordinator.dispose();
  });

  it("uses the pending-cell status callback to overtake a cold kernel backoff", async () => {
    const notebook = fakeNotebook();
    mocks.documents.push(notebook);
    mocks.visibleEditors.push({ notebook });
    mocks.extensions.add("ms-toolsai.datawrangler");
    mocks.preference = "openWrangler";
    mocks.prepare.mockRejectedValueOnce(new Error("Kernel is not started")).mockResolvedValueOnce(undefined);
    const coordinator = new NotebookPreviewCoordinator({} as never);

    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.prepare).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);

    const provider = mocks.statusBarProviders.find(({ notebookType }) => notebookType === "jupyter-notebook");
    expect(provider?.provider.provideCellStatusBarItems({ notebook })).toBeUndefined();
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.prepare).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    coordinator.dispose();
  });

  it("leaves an API-opened background notebook untouched until it becomes visible", async () => {
    const notebook = fakeNotebook();
    mocks.documents.push(notebook);
    const coordinator = new NotebookPreviewCoordinator({} as never);

    for (const listener of mocks.channels.open) listener(notebook);
    await vi.runOnlyPendingTimersAsync();
    expect(mocks.prepare).not.toHaveBeenCalled();

    mocks.visibleEditors.push({ notebook });
    for (const listener of mocks.channels.visible) listener(mocks.visibleEditors);
    await vi.runOnlyPendingTimersAsync();

    expect(mocks.prepare).toHaveBeenCalledOnce();
    coordinator.dispose();
  });

  it("exposes a branded command for changing the provider", async () => {
    const coordinator = new NotebookPreviewCoordinator({} as never);
    mocks.quickPick.mockResolvedValue({ value: "openWrangler" });

    await mocks.commands.get("openWrangler.chooseNotebookPreviewProvider")?.();

    expect(mocks.quickPick).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ label: "Open Wrangler", value: "openWrangler" })]),
      expect.objectContaining({ title: "Open Wrangler: Choose Notebook Preview Provider" })
    );
    expect(mocks.updateSetting).toHaveBeenCalledWith("notebookPreviewProvider", "openWrangler", 1);
    coordinator.dispose();
  });
});

function fakeNotebook(notebookType = "jupyter-notebook"): NotebookDocument {
  return {
    notebookType,
    isClosed: false,
    uri: {
      toString: () =>
        notebookType === "interactive" ? "untitled:/Interactive-1.interactive" : "file:///workspace/notebook.ipynb"
    }
  } as unknown as NotebookDocument;
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
