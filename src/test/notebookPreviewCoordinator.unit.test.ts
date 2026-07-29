import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NotebookDocument } from "vscode";

type Listener<T> = (value: T) => void;

const mocks = vi.hoisted(() => {
  const channels = {
    open: new Set<Listener<NotebookDocument>>(),
    close: new Set<Listener<NotebookDocument>>(),
    active: new Set<Listener<{ notebook: NotebookDocument } | undefined>>(),
    change: new Set<Listener<{ notebook: NotebookDocument }>>(),
    configuration: new Set<Listener<{ affectsConfiguration(section: string): boolean }>>()
  };
  return {
    channels,
    commands: new Map<string, (...args: unknown[]) => unknown>(),
    documents: [] as NotebookDocument[],
    extensions: new Set(["ms-toolsai.jupyter"]),
    preference: "ask",
    prepare: vi.fn(async () => undefined),
    disposeBridge: vi.fn(),
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
    onDidChangeActiveNotebookEditor: event(mocks.channels.active),
    showInformationMessage: mocks.information,
    showQuickPick: mocks.quickPick
  },
  extensions: {
    getExtension: (id: string) => (mocks.extensions.has(id) ? { id } : undefined)
  },
  commands: {
    registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
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
  KernelBridge: class {
    readonly onDidInvalidateKernel = (listener: () => void) => {
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

import { NotebookPreviewCoordinator } from "../extension/notebooks/notebookPreviewCoordinator";

describe("NotebookPreviewCoordinator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.commands.clear();
    mocks.documents.splice(0);
    mocks.extensions.clear();
    mocks.extensions.add("ms-toolsai.jupyter");
    mocks.preference = "ask";
    mocks.prepare.mockReset().mockResolvedValue(undefined);
    mocks.disposeBridge.mockReset();
    mocks.invalidationListeners.clear();
    mocks.information.mockReset().mockResolvedValue(undefined);
    mocks.quickPick.mockReset().mockResolvedValue(undefined);
    mocks.updateSetting.mockClear();
    for (const channel of Object.values(mocks.channels)) channel.clear();
  });

  it("prepares the first supported notebook without a prompt when there is no competing provider", async () => {
    const notebook = fakeNotebook();
    mocks.documents.push(notebook);
    const coordinator = new NotebookPreviewCoordinator({} as never);

    await vi.runOnlyPendingTimersAsync();

    expect(mocks.prepare).toHaveBeenCalledOnce();
    expect(mocks.information).not.toHaveBeenCalled();
    coordinator.dispose();
  });

  it("prompts once and leaves the kernel untouched when the user keeps Data Wrangler", async () => {
    const notebook = fakeNotebook();
    mocks.documents.push(notebook);
    mocks.extensions.add("ms-toolsai.datawrangler");
    mocks.information.mockResolvedValue("Keep Data Wrangler");
    const coordinator = new NotebookPreviewCoordinator({} as never);

    await vi.runOnlyPendingTimersAsync();

    expect(mocks.information).toHaveBeenCalledOnce();
    expect(mocks.updateSetting).toHaveBeenCalledWith("notebookPreviewProvider", "dataWrangler", 1);
    expect(mocks.prepare).not.toHaveBeenCalled();
    coordinator.dispose();
  });

  it("prepares Open Wrangler immediately when it wins the one-time renderer conflict", async () => {
    const notebook = fakeNotebook();
    mocks.documents.push(notebook);
    mocks.extensions.add("ms-toolsai.datawrangler");
    mocks.information.mockResolvedValue("Use Open Wrangler");
    const coordinator = new NotebookPreviewCoordinator({} as never);

    await vi.runOnlyPendingTimersAsync();

    expect(mocks.information).toHaveBeenCalledOnce();
    expect(mocks.updateSetting).toHaveBeenCalledWith("notebookPreviewProvider", "openWrangler", 1);
    expect(mocks.prepare).toHaveBeenCalledOnce();
    coordinator.dispose();
  });

  it("reinstalls the Open Wrangler formatter after a kernel invalidation", async () => {
    const notebook = fakeNotebook();
    mocks.documents.push(notebook);
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

function fakeNotebook(): NotebookDocument {
  return {
    notebookType: "jupyter-notebook",
    isClosed: false,
    uri: { toString: () => "file:///workspace/notebook.ipynb" }
  } as unknown as NotebookDocument;
}
