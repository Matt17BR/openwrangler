import { access, chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PythonEnvironmentSelectionChangeEvent } from "../extension/pythonEnvironment";

import {
  decodePythonEnvironmentProbeOutput,
  discoverWindowsSystemPythonExecutables,
  parseWindowsPythonLauncherOutput,
  probeDependencies,
  PythonEnvironmentApiBroker,
  PythonEnvironmentApiBrokerDisposedError,
  resolvePythonEnvironment,
  type PythonEnvironmentResource
} from "../extension/pythonEnvironment";
import { buildPythonProcessEnvironment } from "../extension/pythonProcessEnvironment";

const execFileAsync = promisify(execFile);

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

    expect(environment.source).toBe("configuration");
    expect(path.isAbsolute(environment.executable)).toBe(true);
    expect(environment.executableIdentity).toEqual({
      device: expect.stringMatching(/^(?:0|[1-9]\d*)$/),
      inode: expect.stringMatching(/^(?:0|[1-9]\d*)$/),
      size: expect.stringMatching(/^[1-9]\d*$/),
      mtimeNs: expect.stringMatching(/^(?:0|-?[1-9]\d*)$/),
      ctimeNs: expect.stringMatching(/^(?:0|-?[1-9]\d*)$/)
    });
    expect(environment.packageRoot.trim()).not.toBe("");
    expect(environment.packageRootIdentity).toEqual({
      device: expect.stringMatching(/^(?:0|[1-9]\d*)$/),
      inode: expect.stringMatching(/^(?:0|[1-9]\d*)$/)
    });

    expect(getExtension).not.toHaveBeenCalled();
    broker.dispose();
  });

  it("builds a controlled Python process environment case-insensitively", () => {
    const environment = buildPythonProcessEnvironment({
      Path: "/system/bin",
      OPEN_WRANGLER_SENTINEL: "preserved",
      pythonpath: "/hostile/modules",
      PythonHome: "/hostile/home",
      PythonHashSeed: "random",
      __pyvenv_launcher__: "/hostile/launcher",
      Virtual_Env: "/hostile/venv",
      conda_prefix_2: "/hostile/conda",
      PyEnv_Version: "hostile"
    });

    expect(environment).toEqual({
      Path: "/system/bin",
      OPEN_WRANGLER_SENTINEL: "preserved",
      PYTHON_MANAGER_AUTOMATIC_INSTALL: "0",
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONIOENCODING: "utf-8",
      PYTHONNOUSERSITE: "1",
      PYTHONSAFEPATH: "1",
      PYTHONUNBUFFERED: "1",
      PYTHONUTF8: "1"
    });
  });

  it("strictly extracts supported direct interpreters from legacy Windows launcher listings", () => {
    expect(
      parseWindowsPythonLauncherOutput(
        [
          "Installed Pythons found by py Launcher for Windows",
          ' -3.14-64        "C:\\Program Files\\Python314\\python.exe" *',
          " -V:PythonCore/3.12-arm64 C:\\Users\\user\\Python312\\python.exe",
          " -3.15-64        C:\\Python315\\python.exe",
          " -3.11-64        relative\\python.exe",
          " -3.10-64        C:\\Python310\\python.cmd",
          " -V:3.13t        C:\\Python313t\\python.exe",
          " -3.12-64        C:\\USERS\\USER\\Python312\\PYTHON.EXE"
        ].join("\r\n")
      )
    ).toEqual([
      "C:\\Program Files\\Python314\\python.exe",
      "C:\\Python313t\\python.exe",
      "C:\\Users\\user\\Python312\\python.exe"
    ]);
  });

  it("uses the Windows launcher only to list installed runtimes with automatic installs disabled", async () => {
    const executeLauncher = vi.fn(
      async (
        _executable: string,
        _arguments_: readonly string[],
        _options: {
          env: NodeJS.ProcessEnv;
          maxBuffer: number;
          shell: false;
          timeout: number;
          windowsHide: true;
        }
      ) => ({
        stdout: [
          "Installed Pythons found by py Launcher for Windows",
          " -3.14-64        C:\\Python314\\python.exe *"
        ].join("\r\n"),
        stderr: ""
      })
    );
    const isExecutable = vi.fn(
      (candidate: string) =>
        candidate.toLocaleLowerCase("en-US") === "c:\\tools\\py.exe" ||
        candidate.toLocaleLowerCase("en-US") === "c:\\python314\\python.exe"
    );

    await expect(
      discoverWindowsSystemPythonExecutables({
        environment: {
          Path: "C:\\Tools",
          PYLAUNCHER_ALLOW_INSTALL: "1",
          PYTHON_MANAGER_AUTOMATIC_INSTALL: "1"
        },
        isExecutable,
        executeLauncher
      })
    ).resolves.toEqual(["C:\\Python314\\python.exe"]);
    expect(executeLauncher).toHaveBeenCalledOnce();
    expect(executeLauncher).toHaveBeenCalledWith(
      "C:\\Tools\\py.exe",
      ["-0p"],
      expect.objectContaining({
        env: expect.objectContaining({
          PYLAUNCHER_NO_SEARCH_PATH: "1",
          PYTHON_MANAGER_AUTOMATIC_INSTALL: "0"
        }),
        shell: false,
        windowsHide: true
      })
    );
    const launcherEnvironment = executeLauncher.mock.calls[0]?.[2]?.env;
    expect(launcherEnvironment).not.toHaveProperty("PYLAUNCHER_ALLOW_INSTALL");
  });

  it("returns no Windows interpreter candidates for an empty or malformed launcher listing", async () => {
    const executeLauncher = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "No installed runtimes.", stderr: "" })
      .mockResolvedValueOnce({ stdout: " -3.14-64 relative\\python.exe", stderr: "" });
    const options = {
      environment: { Path: "C:\\Tools" },
      isExecutable: (candidate: string) => candidate.toLocaleLowerCase("en-US") === "c:\\tools\\py.exe",
      executeLauncher
    };

    await expect(discoverWindowsSystemPythonExecutables(options)).resolves.toEqual([]);
    await expect(discoverWindowsSystemPythonExecutables(options)).resolves.toEqual([]);
    expect(executeLauncher).toHaveBeenCalledTimes(2);
  });

  it("isolates environment and dependency probes from hostile inherited Python settings", async () => {
    const executable = testPythonExecutable();
    const directory = await mkdtemp(path.join(tmpdir(), "openwrangler-hostile-python-env-"));
    const moduleName = "openwrangler_hostile_probe_module";
    const previousPythonHome = process.env.PYTHONHOME;
    const previousPythonPath = process.env.PYTHONPATH;
    try {
      await writeFile(path.join(directory, `${moduleName}.py`), "HOSTILE = True\n", "utf8");
      process.env.PYTHONHOME = path.join(directory, "missing-python-home");
      process.env.PYTHONPATH = directory;

      const environment = await resolveConfiguredEnvironment(executable);
      const dependencies = await probeDependencies(environment.executable, [
        {
          importModule: moduleName,
          distribution: moduleName,
          installSpec: moduleName
        }
      ]);

      expect(path.isAbsolute(environment.executable)).toBe(true);
      expect(environment.version).toMatch(/^3\.(?:10|11|12|13|14)\.\d+$/);
      expect(dependencies).toEqual({
        available: [],
        missing: [moduleName]
      });
    } finally {
      restoreProcessEnvironment("PYTHONHOME", previousPythonHome);
      restoreProcessEnvironment("PYTHONPATH", previousPythonPath);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects an unpinned dependency-probe executable before process creation", async () => {
    const executable = process.platform === "win32" ? "\\root-relative\\python.exe" : "python3";
    await expect(
      probeDependencies(executable, [
        {
          importModule: "pandas",
          distribution: "pandas",
          installSpec: "pandas"
        }
      ])
    ).rejects.toThrow("requires an absolute executable path");
  });

  it("pins a wrapper to its reported interpreter without realpathing away a virtual environment", async () => {
    if (process.platform === "win32") return;
    const directEnvironment = await resolveConfiguredEnvironment(testPythonExecutable());
    const directExecutable = directEnvironment.executable;
    const directory = await mkdtemp(path.join(tmpdir(), "openwrangler-python-wrapper-"));
    const wrapper = path.join(directory, "python-wrapper");
    const counter = path.join(directory, "wrapper-count");
    try {
      await writeFile(
        wrapper,
        ["#!/bin/sh", `printf x >> ${shellQuote(counter)}`, `exec ${shellQuote(directExecutable)} "$@"`].join("\n"),
        "utf8"
      );
      await chmod(wrapper, 0o700);

      const wrappedEnvironment = await resolveConfiguredEnvironment(wrapper);

      expect(wrappedEnvironment.executable).toBe(directEnvironment.executable);
      expect(wrappedEnvironment.packageRoot).toBe(directEnvironment.packageRoot);
      expect(wrappedEnvironment.packageRootIdentity).toEqual(directEnvironment.packageRootIdentity);
      expect(wrappedEnvironment.executable).not.toBe(wrapper);
      expect(await readFile(counter, "utf8")).toBe("x");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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

  it("rejects an activated API that cannot report selection changes", async () => {
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
    const broker = new PythonEnvironmentApiBroker();

    await expect(broker.resolveSelectedExecutable()).resolves.toBeUndefined();
    expect(activate).toHaveBeenCalledOnce();
    expect(getActiveEnvironmentPath).not.toHaveBeenCalled();
    expect(resolveEnvironment).not.toHaveBeenCalled();
    broker.dispose();
  });

  it("canonicalizes a real package-root symlink or junction and preserves its filesystem identity", async () => {
    const executable = testPythonExecutable();
    const directEnvironment = await resolveConfiguredEnvironment(executable);
    const canonicalExecutable = await reportedPythonExecutable(executable);
    const executableWithinRoot = path.relative(directEnvironment.packageRoot, canonicalExecutable);
    if (
      executableWithinRoot.length === 0 ||
      executableWithinRoot === ".." ||
      executableWithinRoot.startsWith(`..${path.sep}`) ||
      path.isAbsolute(executableWithinRoot)
    ) {
      return;
    }

    const directory = await mkdtemp(path.join(tmpdir(), "openwrangler-python-root-alias-"));
    const aliasRoot = path.join(directory, "alias");
    try {
      await symlink(directEnvironment.packageRoot, aliasRoot, process.platform === "win32" ? "junction" : "dir");
      const aliasEnvironment = await resolveConfiguredEnvironment(path.join(aliasRoot, executableWithinRoot));

      expect(aliasEnvironment.packageRoot).toBe(directEnvironment.packageRoot);
      expect(aliasEnvironment.packageRootIdentity).toEqual(directEnvironment.packageRootIdentity);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("canonicalizes a real Linux proc-root alias when procfs is available", async () => {
    if (process.platform !== "linux") return;
    try {
      await access("/proc/self/root");
    } catch {
      return;
    }

    const executable = testPythonExecutable();
    const directEnvironment = await resolveConfiguredEnvironment(executable);
    const canonicalExecutable = await reportedPythonExecutable(executable);
    if (!path.isAbsolute(canonicalExecutable)) return;

    const procAliasEnvironment = await resolveConfiguredEnvironment(
      path.join("/proc/self/root", canonicalExecutable.slice(path.parse(canonicalExecutable).root.length))
    );

    expect(procAliasEnvironment.packageRoot).toBe(directEnvironment.packageRoot);
    expect(procAliasEnvironment.packageRootIdentity).toEqual(directEnvironment.packageRootIdentity);
  });

  it("strictly decodes the interpreter version and package root", () => {
    const executable = testAbsolutePath(
      "workspace",
      ".venv",
      "bin",
      process.platform === "win32" ? "python.exe" : "python"
    );
    const packageRoot = testAbsolutePath("workspace", ".venv");
    expect(
      decodePythonEnvironmentProbeOutput(
        JSON.stringify({
          executable,
          executableIdentity: {
            device: "64513",
            inode: "25334068",
            size: "18200",
            mtimeNs: "1717171717123456789",
            ctimeNs: "1717171717987654321"
          },
          version: [3, 12, 4],
          packageRoot,
          packageRootIdentity: {
            device: "64513",
            inode: "25334067"
          }
        })
      )
    ).toEqual({
      executable: path.normalize(executable),
      executableIdentity: {
        device: "64513",
        inode: "25334068",
        size: "18200",
        mtimeNs: "1717171717123456789",
        ctimeNs: "1717171717987654321"
      },
      version: [3, 12, 4],
      packageRoot,
      packageRootIdentity: {
        device: "64513",
        inode: "25334067"
      }
    });
  });

  it("accepts the full Windows 128-bit inode range", () => {
    expect(
      decodePythonEnvironmentProbeOutput(
        probePayload({
          packageRootIdentity: {
            device: "18446744073709551615",
            inode: "340282366920938463463374607431768211455"
          }
        })
      ).packageRootIdentity
    ).toEqual({
      device: "18446744073709551615",
      inode: "340282366920938463463374607431768211455"
    });
  });

  it("distinguishes a same-path executable replacement from stable package-root scope", () => {
    const original = decodePythonEnvironmentProbeOutput(probePayload());
    const replacement = decodePythonEnvironmentProbeOutput(
      probePayload({
        executableIdentity: {
          ...original.executableIdentity,
          inode: "3",
          size: "16384",
          mtimeNs: "1717171718000000000",
          ctimeNs: "1717171718000000001"
        }
      })
    );

    expect(replacement.executable).toBe(original.executable);
    expect(replacement.packageRootIdentity).toEqual(original.packageRootIdentity);
    expect(replacement.executableIdentity).not.toEqual(original.executableIdentity);
  });

  it("accepts canonical signed timestamp and unsigned executable-identity bounds", () => {
    expect(
      decodePythonEnvironmentProbeOutput(
        probePayload({
          executableIdentity: {
            device: "18446744073709551615",
            inode: "340282366920938463463374607431768211455",
            size: "340282366920938463463374607431768211455",
            mtimeNs: "-170141183460469231731687303715884105728",
            ctimeNs: "170141183460469231731687303715884105727"
          }
        })
      ).executableIdentity
    ).toEqual({
      device: "18446744073709551615",
      inode: "340282366920938463463374607431768211455",
      size: "340282366920938463463374607431768211455",
      mtimeNs: "-170141183460469231731687303715884105728",
      ctimeNs: "170141183460469231731687303715884105727"
    });
  });

  it.each([
    { payload: "not-json", message: "did not return valid JSON" },
    { payload: "null", message: "invalid payload" },
    { payload: "[]", message: "invalid payload" },
    {
      payload: probePayload({ extra: true }),
      message: "invalid payload"
    },
    {
      payload: JSON.stringify({
        executable: testAbsolutePath("env", "bin", process.platform === "win32" ? "python.exe" : "python"),
        version: [3, 12, 4],
        packageRoot: testAbsolutePath("env")
      }),
      message: "invalid payload"
    },
    { payload: probePayload({ version: [3, 12] }), message: "invalid version" },
    { payload: probePayload({ version: [3, 12, 4.5] }), message: "invalid version" },
    { payload: probePayload({ executable: "python3" }), message: "invalid executable" },
    { payload: probePayload({ executable: "/env/bin/python\0alias" }), message: "invalid executable" },
    { payload: probePayload({ executableIdentity: null }), message: "invalid executable identity" },
    { payload: probePayload({ executableIdentity: [] }), message: "invalid executable identity" },
    {
      payload: probePayload({
        executableIdentity: {
          device: "1",
          inode: "2",
          size: "3",
          mtimeNs: "4",
          ctimeNs: "5",
          extra: true
        }
      }),
      message: "invalid executable identity"
    },
    {
      payload: probePayload({
        executableIdentity: { device: 1, inode: "2", size: "3", mtimeNs: "4", ctimeNs: "5" }
      }),
      message: "invalid executable identity"
    },
    {
      payload: probePayload({
        executableIdentity: { device: "01", inode: "2", size: "3", mtimeNs: "4", ctimeNs: "5" }
      }),
      message: "invalid executable identity"
    },
    {
      payload: probePayload({
        executableIdentity: { device: "1", inode: "-2", size: "3", mtimeNs: "4", ctimeNs: "5" }
      }),
      message: "invalid executable identity"
    },
    {
      payload: probePayload({
        executableIdentity: { device: "1", inode: "2", size: "-3", mtimeNs: "4", ctimeNs: "5" }
      }),
      message: "invalid executable identity"
    },
    {
      payload: probePayload({
        executableIdentity: { device: "1", inode: "2", size: "0", mtimeNs: "4", ctimeNs: "5" }
      }),
      message: "invalid executable identity"
    },
    {
      payload: probePayload({
        executableIdentity: { device: "1", inode: "2", size: "3", mtimeNs: "+4", ctimeNs: "5" }
      }),
      message: "invalid executable identity"
    },
    {
      payload: probePayload({
        executableIdentity: { device: "1", inode: "2", size: "3", mtimeNs: "-0", ctimeNs: "5" }
      }),
      message: "invalid executable identity"
    },
    {
      payload: probePayload({
        executableIdentity: {
          device: "18446744073709551616",
          inode: "2",
          size: "3",
          mtimeNs: "4",
          ctimeNs: "5"
        }
      }),
      message: "invalid executable identity"
    },
    {
      payload: probePayload({
        executableIdentity: {
          device: "1",
          inode: "340282366920938463463374607431768211456",
          size: "3",
          mtimeNs: "4",
          ctimeNs: "5"
        }
      }),
      message: "invalid executable identity"
    },
    {
      payload: probePayload({
        executableIdentity: {
          device: "1",
          inode: "2",
          size: "340282366920938463463374607431768211456",
          mtimeNs: "4",
          ctimeNs: "5"
        }
      }),
      message: "invalid executable identity"
    },
    {
      payload: probePayload({
        executableIdentity: {
          device: "1",
          inode: "2",
          size: "3",
          mtimeNs: "-170141183460469231731687303715884105729",
          ctimeNs: "5"
        }
      }),
      message: "invalid executable identity"
    },
    {
      payload: probePayload({
        executableIdentity: {
          device: "1",
          inode: "2",
          size: "3",
          mtimeNs: "4",
          ctimeNs: "170141183460469231731687303715884105728"
        }
      }),
      message: "invalid executable identity"
    },
    {
      payload: probePayload({
        executableIdentity: { device: "0", inode: "0", size: "3", mtimeNs: "4", ctimeNs: "5" }
      }),
      message: "invalid executable identity"
    },
    {
      payload: probePayload({
        executableIdentity: { device: "1", inode: "2", size: "3", mtimeNs: "0", ctimeNs: "0" }
      }),
      message: "invalid executable identity"
    },
    { payload: probePayload({ packageRoot: "   " }), message: "invalid package root" },
    { payload: probePayload({ packageRoot: "relative-env" }), message: "invalid package root" },
    { payload: probePayload({ packageRoot: "/env\0alias" }), message: "invalid package root" },
    { payload: probePayload({ packageRootIdentity: null }), message: "invalid package root identity" },
    { payload: probePayload({ packageRootIdentity: [] }), message: "invalid package root identity" },
    {
      payload: probePayload({ packageRootIdentity: { device: "1", inode: "2", extra: true } }),
      message: "invalid package root identity"
    },
    {
      payload: probePayload({ packageRootIdentity: { device: 1, inode: "2" } }),
      message: "invalid package root identity"
    },
    {
      payload: probePayload({ packageRootIdentity: { device: "01", inode: "2" } }),
      message: "invalid package root identity"
    },
    {
      payload: probePayload({ packageRootIdentity: { device: "1", inode: "-2" } }),
      message: "invalid package root identity"
    },
    {
      payload: probePayload({ packageRootIdentity: { device: "18446744073709551616", inode: "1" } }),
      message: "invalid package root identity"
    },
    {
      payload: probePayload({
        packageRootIdentity: { device: "1", inode: "340282366920938463463374607431768211456" }
      }),
      message: "invalid package root identity"
    },
    {
      payload: probePayload({ packageRootIdentity: { device: "0", inode: "0" } }),
      message: "invalid package root identity"
    }
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

async function resolveConfiguredEnvironment(executable: string) {
  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
    get: <T>(key: string, fallback: T): T => (key === "pythonPath" ? (executable as T) : fallback)
  } as vscode.WorkspaceConfiguration);
  return resolvePythonEnvironment({ extensionPath: "/extension" } as vscode.ExtensionContext);
}

async function reportedPythonExecutable(executable: string): Promise<string> {
  const { stdout } = await execFileAsync(executable, ["-c", "import sys; print(sys.executable)"], {
    timeout: 10_000
  });
  return stdout.trim();
}

function probePayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    executable: testAbsolutePath("env", "bin", process.platform === "win32" ? "python.exe" : "python"),
    executableIdentity: {
      device: "1",
      inode: "2",
      size: "16384",
      mtimeNs: "1717171717123456789",
      ctimeNs: "1717171717987654321"
    },
    version: [3, 12, 4],
    packageRoot: testAbsolutePath("env"),
    packageRootIdentity: {
      device: "1",
      inode: "2"
    },
    ...overrides
  });
}

function testAbsolutePath(...segments: string[]): string {
  return process.platform === "win32" ? path.win32.join("C:\\", ...segments) : path.posix.join("/", ...segments);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function restoreProcessEnvironment(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
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
