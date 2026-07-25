import * as vscode from "vscode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PythonEnvironmentSelectionChangeEvent } from "../extension/pythonEnvironment";

import {
  decodePythonEnvironmentProbeOutput,
  PythonEnvironmentApiBroker,
  PythonEnvironmentApiBrokerDisposedError,
  resolvePythonEnvironment,
  type PythonEnvironmentResource
} from "../extension/pythonEnvironment";

type ExtensionLookup = (id: string) => vscode.Extension<unknown> | undefined;

describe("Python environment API broker", () => {
  beforeEach(() => {
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
      get: <T>(_key: string, fallback: T): T => fallback
    } as vscode.WorkspaceConfiguration);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("bypasses Python extension activation when an explicit interpreter is configured", async () => {
    const executable = testPythonExecutable();
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: <T>(key: string, fallback: T): T => (key === "pythonPath" ? (executable as T) : fallback)
    } as vscode.WorkspaceConfiguration);
    const getExtension = mockExtensionLookup();
    const broker = new PythonEnvironmentApiBroker();

    const environment = await resolvePythonEnvironment(
      { extensionPath: "/extension" } as vscode.ExtensionContext,
      vscode.Uri.file("/data.csv"),
      broker
    );

    expect(environment).toMatchObject({
      executable,
      source: "configuration"
    });
    expect(environment.packageRoot.trim()).not.toBe("");

    expect(getExtension).not.toHaveBeenCalled();
    broker.dispose();
  });

  it("single-flights activation, subscribes before selection, and forwards exact resource objects", async () => {
    const activation = deferred<unknown>();
    const order: string[] = [];
    const disposeSelection = vi.fn();
    const onDidChangeSelection = vi.fn();
    let selectionListener: ((event: PythonEnvironmentSelectionChangeEvent) => unknown) | undefined;
    const onDidChangeActiveEnvironmentPath = vi.fn(
      (listener: (event: PythonEnvironmentSelectionChangeEvent) => unknown) => {
        order.push("subscribe");
        selectionListener = listener;
        return { dispose: disposeSelection };
      }
    );
    const getActiveEnvironmentPath = vi.fn((resource?: PythonEnvironmentResource) => {
      order.push("select");
      return {
        id: resource ? "resource-env" : "default-env",
        path: "/selected/python"
      };
    });
    const resolveEnvironment = vi.fn(async () => ({
      executable: { uri: vscode.Uri.file("/resolved/python") }
    }));
    const activate = vi.fn(() => activation.promise);
    mockExtensionLookup(extension(activate));
    const broker = new PythonEnvironmentApiBroker(onDidChangeSelection);
    const uri = vscode.Uri.file("/workspace/one.csv");
    const folder = {
      uri: vscode.Uri.file("/workspace/two"),
      name: "two",
      index: 1
    } as vscode.WorkspaceFolder;

    expect(activate).not.toHaveBeenCalled();
    const uriResolution = broker.resolveSelectedExecutable(uri);
    const folderResolution = broker.resolveSelectedExecutable(folder);
    expect(activate).toHaveBeenCalledOnce();

    activation.resolve({
      environments: {
        getActiveEnvironmentPath,
        resolveEnvironment,
        onDidChangeActiveEnvironmentPath
      }
    });

    await expect(Promise.all([uriResolution, folderResolution])).resolves.toEqual([
      "/resolved/python",
      "/resolved/python"
    ]);
    expect(onDidChangeActiveEnvironmentPath).toHaveBeenCalledOnce();
    expect(order).toEqual(["subscribe", "select", "select"]);
    expect(getActiveEnvironmentPath.mock.calls[0]?.[0]).toBe(uri);
    expect(getActiveEnvironmentPath.mock.calls[1]?.[0]).toBe(folder);

    const event = { id: "changed", path: "/changed/python", resource: folder } as PythonEnvironmentSelectionChangeEvent;
    selectionListener?.(event);
    expect(onDidChangeSelection).toHaveBeenCalledOnce();
    expect(onDidChangeSelection).toHaveBeenCalledWith(event);

    broker.dispose();
    broker.dispose();
    selectionListener?.(event);
    expect(disposeSelection).toHaveBeenCalledOnce();
    expect(onDidChangeSelection).toHaveBeenCalledOnce();
  });

  it("does not attach a listener when disposed during activation", async () => {
    const activation = deferred<unknown>();
    const onDidChangeActiveEnvironmentPath = vi.fn(() => ({ dispose: vi.fn() }));
    const activate = vi.fn(() => activation.promise);
    mockExtensionLookup(extension(activate));
    const broker = new PythonEnvironmentApiBroker();

    const resolution = resolvePythonEnvironment(
      { extensionPath: "/extension" } as vscode.ExtensionContext,
      vscode.Uri.file("/workspace/data.csv"),
      broker
    );
    expect(activate).toHaveBeenCalledOnce();
    broker.dispose();
    broker.dispose();
    activation.resolve({
      environments: {
        getActiveEnvironmentPath: vi.fn(() => ({ id: "env", path: "/late/python" })),
        resolveEnvironment: vi.fn(),
        onDidChangeActiveEnvironmentPath
      }
    });

    await expect(resolution).rejects.toBeInstanceOf(PythonEnvironmentApiBrokerDisposedError);
    expect(onDidChangeActiveEnvironmentPath).not.toHaveBeenCalled();
  });

  it("rejects resolution after disposal instead of falling through to a system interpreter", async () => {
    const getExtension = mockExtensionLookup();
    const broker = new PythonEnvironmentApiBroker();
    broker.dispose();

    await expect(
      resolvePythonEnvironment(
        { extensionPath: "/extension" } as vscode.ExtensionContext,
        vscode.Uri.file("/workspace/data.csv"),
        broker
      )
    ).rejects.toMatchObject({
      name: "PythonEnvironmentApiBrokerDisposedError",
      code: "python_environment_api_broker_disposed"
    });
    expect(getExtension).not.toHaveBeenCalled();
  });

  it("rejects when disposed while the selected environment is resolving", async () => {
    const environmentResolution = deferred<{
      executable: { uri: vscode.Uri };
    }>();
    const resolutionStarted = deferred<void>();
    const disposeSelection = vi.fn();
    const resolveEnvironment = vi.fn(() => {
      resolutionStarted.resolve();
      return environmentResolution.promise;
    });
    mockExtensionLookup(
      extension(async () => ({
        environments: {
          getActiveEnvironmentPath: vi.fn(() => ({ id: "env", path: "/selected/python" })),
          resolveEnvironment,
          onDidChangeActiveEnvironmentPath: vi.fn(() => ({ dispose: disposeSelection }))
        }
      }))
    );
    const broker = new PythonEnvironmentApiBroker();

    const resolution = broker.resolveSelectedExecutable(vscode.Uri.file("/workspace/data.csv"));
    await resolutionStarted.promise;
    broker.dispose();
    environmentResolution.resolve({
      executable: { uri: vscode.Uri.file("/resolved/python") }
    });

    await expect(resolution).rejects.toBeInstanceOf(PythonEnvironmentApiBrokerDisposedError);
    expect(resolveEnvironment).toHaveBeenCalledOnce();
    expect(disposeSelection).toHaveBeenCalledOnce();
  });

  it("retries after absent, failed, and malformed extension activation", async () => {
    const failedActivation = vi.fn(async () => {
      throw new Error("activation failed");
    });
    const malformedActivation = vi.fn(async () => ({ environments: {} }));
    const successfulActivation = vi.fn(async () => ({
      environments: {
        getActiveEnvironmentPath: vi.fn(() => ({ id: "env", path: "/selected/python" })),
        resolveEnvironment: vi.fn(async () => undefined),
        onDidChangeActiveEnvironmentPath: vi.fn(() => ({ dispose: vi.fn() }))
      }
    }));
    const getExtension = mockExtensionLookup();
    getExtension
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(extension(failedActivation))
      .mockReturnValueOnce(extension(malformedActivation))
      .mockReturnValueOnce(extension(successfulActivation));
    const broker = new PythonEnvironmentApiBroker();

    await expect(broker.resolveSelectedExecutable()).resolves.toBeUndefined();
    await expect(broker.resolveSelectedExecutable()).resolves.toBeUndefined();
    await expect(broker.resolveSelectedExecutable()).resolves.toBeUndefined();
    await expect(broker.resolveSelectedExecutable()).resolves.toBe("/selected/python");

    expect(getExtension).toHaveBeenCalledTimes(4);
    expect(failedActivation).toHaveBeenCalledOnce();
    expect(malformedActivation).toHaveBeenCalledOnce();
    expect(successfulActivation).toHaveBeenCalledOnce();
    broker.dispose();
  });

  it("rejects an already-active API that cannot report selection changes", async () => {
    const activate = vi.fn();
    const uri = vscode.Uri.file("/workspace/data.csv");
    const getActiveEnvironmentPath = vi.fn(() => ({ id: "active-env", path: "/active/python" }));
    const resolveEnvironment = vi.fn(async () => ({
      executable: { uri: vscode.Uri.file("/active/python") }
    }));
    mockExtensionLookup({
      isActive: true,
      exports: {
        environments: {
          getActiveEnvironmentPath,
          resolveEnvironment
        }
      },
      activate
    } as unknown as vscode.Extension<unknown>);
    const broker = new PythonEnvironmentApiBroker();

    await expect(broker.resolveSelectedExecutable(uri)).resolves.toBeUndefined();
    expect(activate).not.toHaveBeenCalled();
    expect(getActiveEnvironmentPath).not.toHaveBeenCalled();
    expect(resolveEnvironment).not.toHaveBeenCalled();
    broker.dispose();
  });

  it("falls back to a system interpreter when the activated API has no stable selection event", async () => {
    const getActiveEnvironmentPath = vi.fn(() => ({ id: "env", path: "/selected/python" }));
    const resolveEnvironment = vi.fn(async () => ({
      executable: { uri: vscode.Uri.file("/selected/python") }
    }));
    const activate = vi.fn(async () => ({
      environments: {
        getActiveEnvironmentPath,
        resolveEnvironment
      }
    }));
    mockExtensionLookup(extension(activate));

    const environment = await resolvePythonEnvironment({ extensionPath: "/extension" } as vscode.ExtensionContext);
    expect(environment.source).toBe("system");
    expect(environment.executable).toBeTruthy();
    expect(environment.version).toMatch(/^3\.(?:10|11|12|13|14)\.\d+$/);
    expect(environment.packageRoot.trim()).not.toBe("");
    expect(activate).toHaveBeenCalledOnce();
    expect(getActiveEnvironmentPath).not.toHaveBeenCalled();
    expect(resolveEnvironment).not.toHaveBeenCalled();
  });

  it("strictly decodes the interpreter version and package root", () => {
    expect(
      decodePythonEnvironmentProbeOutput(
        JSON.stringify({
          version: [3, 12, 4],
          packageRoot: "/workspace/.venv"
        })
      )
    ).toEqual({
      version: [3, 12, 4],
      packageRoot: "/workspace/.venv"
    });
  });

  it.each([
    { payload: "not-json", message: "did not return valid JSON" },
    { payload: "null", message: "invalid payload" },
    { payload: "[]", message: "invalid payload" },
    {
      payload: JSON.stringify({ version: [3, 12, 4], packageRoot: "/env", extra: true }),
      message: "invalid payload"
    },
    { payload: JSON.stringify({ version: [3, 12], packageRoot: "/env" }), message: "invalid version" },
    { payload: JSON.stringify({ version: [3, 12, 4.5], packageRoot: "/env" }), message: "invalid version" },
    { payload: JSON.stringify({ version: [3, 12, 4], packageRoot: "   " }), message: "invalid package root" }
  ])("rejects malformed interpreter probe payload: $payload", ({ payload, message }) => {
    expect(() => decodePythonEnvironmentProbeOutput(payload)).toThrow(message);
  });
});

function mockExtensionLookup(extensionValue?: vscode.Extension<unknown>): ReturnType<typeof vi.fn<ExtensionLookup>> {
  return vi
    .spyOn(vscode.extensions, "getExtension")
    .mockImplementation(
      ((_id: string) => extensionValue) as typeof vscode.extensions.getExtension
    ) as unknown as ReturnType<typeof vi.fn<ExtensionLookup>>;
}

function extension(activate: () => Promise<unknown>): vscode.Extension<unknown> {
  return { activate } as unknown as vscode.Extension<unknown>;
}

function testPythonExecutable(): string {
  return (
    process.env.OPEN_WRANGLER_TEST_PYTHON ??
    process.env.OPEN_WRANGLER_PYTHON ??
    (process.platform === "win32" ? "python" : "python3")
  );
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
