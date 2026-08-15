import { link, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener<T> = (value: T) => unknown;

const mocks = vi.hoisted(() => ({
  terminals: [] as unknown[],
  extension: undefined as
    | Readonly<{ extensionPath: string; isActive: boolean; packageJSON: Record<string, unknown>; exports: unknown }>
    | undefined,
  extensionModuleExports: undefined as unknown
}));

vi.mock("node:module", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:module")>();
  const createRequire = (filename: string) => {
    const root = filename.slice(0, filename.lastIndexOf("/"));
    const resolved = `${root}/dist/extension.js`;
    const loader = (() => {
      throw new Error("The test adapter must not load vscode-R.");
    }) as unknown as { resolve: () => string; cache: Record<string, { exports: unknown }> };
    loader.resolve = () => resolved;
    loader.cache = { [resolved]: { exports: mocks.extensionModuleExports } };
    return loader;
  };
  return {
    ...actual,
    default: { ...((actual as unknown as { default?: object }).default ?? {}), createRequire },
    createRequire
  };
});

vi.mock("vscode", () => {
  class EventEmitter<T> {
    private readonly listeners = new Set<Listener<T>>();
    readonly event = (listener: Listener<T>) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
    fire(value: T): void {
      for (const listener of this.listeners) listener(value);
    }
    dispose(): void {
      this.listeners.clear();
    }
  }
  return {
    EventEmitter,
    extensions: { getExtension: vi.fn(() => mocks.extension) },
    window: {
      get terminals() {
        return mocks.terminals;
      }
    }
  };
});

import { createRVscodeWorkspaceWatcher } from "../extension/r/rVscodeWorkspaceWatcher";

interface Fixture {
  readonly root: string;
  readonly extensionPath: string;
  readonly watcherRoot: string;
  readonly tempdir: string;
  readonly sessionRoot: string;
  readonly workspacePath: string;
  readonly lockPath: string;
  readonly requestPath: string;
}

describe("vscode-R workspace metadata adapter", () => {
  const roots: string[] = [];

  beforeEach(() => {
    mocks.terminals = [];
    mocks.extension = undefined;
    mocks.extensionModuleExports = undefined;
  });

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("rejects a shell merely renamed R without sending terminal text", async () => {
    const fixture = await createFixture(801);
    roots.push(fixture.root);
    const terminal = terminalFixture(801, { name: "R" });
    mocks.terminals = [terminal];

    const watcher = createRVscodeWorkspaceWatcher(terminal as never, { extensionPath: fixture.extensionPath });

    expect(watcher).toBeUndefined();
    expect(terminal.sendText).not.toHaveBeenCalled();
  });

  it("reads only dataframe metadata from the exact vscode-R terminal", async () => {
    const fixture = await createFixture(802);
    roots.push(fixture.root);
    await publishWorkspace(fixture, 1, {
      base_orders: { class: ["data.frame"], type: "list", length: 2, dim: [3, 2] },
      tidy_orders: { class: ["tbl_df", "tbl", "data.frame"], type: "list", length: 2, dim: [3, 2] },
      table_orders: { class: ["data.table", "data.frame"], type: "list", length: 2, dim: [3, 2] },
      ".Last.value": { class: ["tbl_df", "tbl", "data.frame"], type: "list", length: 2, dim: [3, 2] },
      scalar: { class: ["numeric"], type: "double", length: 1 }
    });
    const terminal = officialTerminal(fixture, 802);
    mocks.terminals = [terminal];
    const watcher = createRVscodeWorkspaceWatcher(terminal as never, {
      extensionPath: fixture.extensionPath,
      debounceMs: 5,
      retryMs: 5
    });
    expect(watcher).toBeDefined();

    await expect(watcher!.readInitial()).resolves.toEqual({
      variables: [
        { name: "base_orders", backend: "r", dataframeFlavor: "r.data.frame" },
        { name: "tidy_orders", backend: "r", dataframeFlavor: "r.tibble" },
        { name: "table_orders", backend: "r", dataframeFlavor: "r.data.table" },
        { name: ".Last.value", backend: "r", dataframeFlavor: "r.tibble" }
      ],
      truncated: false
    });
    expect(terminal.sendText).not.toHaveBeenCalled();
    watcher!.dispose();
  });

  it("uses vscode-R's current exported workspace after its attach record has been overwritten", async () => {
    const fixture = await createFixture(819);
    roots.push(fixture.root);
    await writeFile(fixture.requestPath, JSON.stringify({ command: "dataview", pid: 819 }));
    const terminal = officialTerminal(fixture, 819);
    mocks.terminals = [terminal];
    const listeners = new Set<() => unknown>();
    const workspace = {
      data: {
        search: ["package:base"],
        loaded_namespaces: ["base"],
        globalenv: {
          current_orders: { class: ["tbl_df", "tbl", "data.frame"], type: "list", dim: [8, 2] }
        }
      } as unknown,
      onDidChangeTreeData: (listener: () => unknown) => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      }
    };
    mocks.extension = {
      extensionPath: fixture.extensionPath,
      isActive: true,
      packageJSON: { main: "./dist/extension" },
      exports: { helpPanel: undefined }
    };
    mocks.extensionModuleExports = {
      rWorkspace: workspace,
      sessionStatusBarItem: { tooltip: "R version 4.5.2\nProcess ID: 819\nCommand: R" }
    };
    const watcher = createRVscodeWorkspaceWatcher(terminal as never, {
      extensionPath: fixture.extensionPath,
      debounceMs: 5,
      retryMs: 5
    })!;

    await expect(watcher.readInitial()).resolves.toEqual({
      variables: [{ name: "current_orders", backend: "r", dataframeFlavor: "r.tibble" }],
      truncated: false
    });

    const updates: unknown[] = [];
    watcher.onDidChangeVariables((value) => updates.push(value));
    workspace.data = {
      search: ["package:base"],
      loaded_namespaces: ["base"],
      globalenv: {
        latest_orders: { class: ["data.table", "data.frame"], type: "list", dim: [10, 3] }
      }
    };
    for (const listener of listeners) listener();
    await vi.waitFor(() =>
      expect(updates.at(-1)).toEqual({
        variables: [{ name: "latest_orders", backend: "r", dataframeFlavor: "r.data.table" }],
        truncated: false
      })
    );
    expect(terminal.sendText).not.toHaveBeenCalled();
    watcher.dispose();
  });

  it("uses authenticated workspace files while vscode-R's exported workspace is not ready", async () => {
    const fixture = await createFixture(821);
    roots.push(fixture.root);
    await publishWorkspace(fixture, 2, {
      file_orders: { class: ["data.frame"], type: "list", dim: [4, 2] }
    });
    const terminal = officialTerminal(fixture, 821);
    mocks.terminals = [terminal];
    mocks.extension = {
      extensionPath: fixture.extensionPath,
      isActive: true,
      packageJSON: { main: "./dist/extension" },
      exports: { helpPanel: undefined }
    };
    mocks.extensionModuleExports = {
      rWorkspace: {
        data: undefined,
        onDidChangeTreeData: () => ({ dispose: () => undefined })
      },
      sessionStatusBarItem: { tooltip: "R version 4.5.2\nProcess ID: 821\nCommand: R" }
    };
    const watcher = createRVscodeWorkspaceWatcher(terminal as never, {
      extensionPath: fixture.extensionPath,
      retryMs: 5,
      attachTimeoutMs: 10_000
    })!;

    const outcome = await Promise.race([
      watcher.readInitial(),
      new Promise<"timed out">((resolve) => setTimeout(() => resolve("timed out"), 250))
    ]);

    expect(outcome).toEqual({
      variables: [{ name: "file_orders", backend: "r", dataframeFlavor: "r.data.frame" }],
      truncated: false
    });
    expect(terminal.sendText).not.toHaveBeenCalled();
    watcher.dispose();
  });

  it("reconsiders vscode-R's exported workspace while attach metadata is pending", async () => {
    const fixture = await createFixture(822);
    roots.push(fixture.root);
    await writeFile(fixture.requestPath, JSON.stringify({ command: "help", pid: 822 }));
    const terminal = officialTerminal(fixture, 822);
    mocks.terminals = [terminal];
    const workspace = {
      data: undefined as unknown,
      onDidChangeTreeData: () => ({ dispose: () => undefined })
    };
    const extension = {
      extensionPath: fixture.extensionPath,
      isActive: false,
      packageJSON: { main: "./dist/extension" },
      exports: { helpPanel: undefined }
    };
    mocks.extension = extension;
    mocks.extensionModuleExports = {
      rWorkspace: workspace,
      sessionStatusBarItem: { tooltip: "R version 4.5.2\nProcess ID: 822\nCommand: R" }
    };
    const watcher = createRVscodeWorkspaceWatcher(terminal as never, {
      extensionPath: fixture.extensionPath,
      retryMs: 5,
      attachTimeoutMs: 1_000
    })!;

    const initial = watcher.readInitial();
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    extension.isActive = true;
    workspace.data = {
      globalenv: {
        api_orders: { class: ["tbl_df", "tbl", "data.frame"], type: "list", dim: [7, 3] }
      }
    };

    await expect(initial).resolves.toEqual({
      variables: [{ name: "api_orders", backend: "r", dataframeFlavor: "r.tibble" }],
      truncated: false
    });
    expect(terminal.sendText).not.toHaveBeenCalled();
    watcher.dispose();
  });

  it("falls back promptly when vscode-R has overwritten the current session's attach record", async () => {
    const fixture = await createFixture(820);
    roots.push(fixture.root);
    await writeFile(fixture.requestPath, JSON.stringify({ command: "help", pid: 820 }));
    const terminal = officialTerminal(fixture, 820);
    mocks.terminals = [terminal];
    mocks.extension = {
      extensionPath: fixture.extensionPath,
      isActive: true,
      packageJSON: { main: "./dist/extension" },
      exports: { helpPanel: undefined }
    };
    mocks.extensionModuleExports = {
      rWorkspace: {
        data: {
          globalenv: {
            foreign_orders: { class: ["data.frame"], type: "list", dim: [1, 1] }
          }
        },
        onDidChangeTreeData: () => ({ dispose: () => undefined })
      },
      sessionStatusBarItem: { tooltip: "R version 4.5.2\nProcess ID: 999\nCommand: R" }
    };
    const watcher = createRVscodeWorkspaceWatcher(terminal as never, {
      extensionPath: fixture.extensionPath,
      retryMs: 5,
      attachTimeoutMs: 10_000
    })!;

    const outcome = await Promise.race([
      watcher.readInitial().then(
        () => "resolved",
        (error: unknown) => (error instanceof Error ? error.message : "rejected")
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("timed out"), 1_000))
    ]);

    expect(outcome).toBe("vscode-R no longer exposes the attach record for this active session.");
    expect(terminal.sendText).not.toHaveBeenCalled();
    watcher.dispose();
  });

  it("rejects foreign attach state and mismatched vscode-R profile provenance", async () => {
    const fixture = await createFixture(803);
    roots.push(fixture.root);
    const wrongPid = officialTerminal(fixture, 804);
    mocks.terminals = [wrongPid];
    const watcher = createRVscodeWorkspaceWatcher(wrongPid as never, {
      extensionPath: fixture.extensionPath,
      retryMs: 5,
      attachTimeoutMs: 10_000
    });
    const outcome = await Promise.race([
      watcher!.readInitial().then(
        () => "resolved",
        (error: unknown) => (error instanceof Error ? error.message : "rejected")
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("timed out"), 1_000))
    ]);
    expect(outcome).toBe("The selected terminal does not match the current vscode-R session record.");
    expect(wrongPid.sendText).not.toHaveBeenCalled();

    const wrongProfile = officialTerminal(fixture, 803, {
      R_PROFILE_USER: path.join(fixture.root, "foreign", "profile.R")
    });
    expect(
      createRVscodeWorkspaceWatcher(wrongProfile as never, { extensionPath: fixture.extensionPath })
    ).toBeUndefined();
    expect(wrongProfile.sendText).not.toHaveBeenCalled();
  });

  it("invalidates when the exact terminal process changes", async () => {
    const fixture = await createFixture(805);
    roots.push(fixture.root);
    const terminal = officialTerminal(fixture, 805);
    mocks.terminals = [terminal];
    const watcher = createRVscodeWorkspaceWatcher(terminal as never, {
      extensionPath: fixture.extensionPath,
      debounceMs: 5,
      retryMs: 5
    })!;
    await watcher.readInitial();
    const invalidated = vi.fn();
    watcher.onDidInvalidate(invalidated);

    terminal.setProcessId(806);
    await publishWorkspace(fixture, 2, {
      orders: { class: ["data.frame"], type: "list", length: 1, dim: [1, 1] }
    });

    await vi.waitFor(() => expect(invalidated).toHaveBeenCalledOnce());
    expect(terminal.sendText).not.toHaveBeenCalled();
    watcher.dispose();
  });

  it("rejects a replaced session path before explicit bootstrap", async () => {
    const fixture = await createFixture(807);
    roots.push(fixture.root);
    const terminal = officialTerminal(fixture, 807);
    mocks.terminals = [terminal];
    const watcher = createRVscodeWorkspaceWatcher(terminal as never, {
      extensionPath: fixture.extensionPath,
      retryMs: 5
    })!;
    await watcher.readInitial();
    await rename(fixture.sessionRoot, `${fixture.sessionRoot}-old`);
    await mkdir(fixture.sessionRoot);
    await publishWorkspace(fixture, 2, {});

    await expect(watcher.verifyCurrent()).rejects.toThrow("vscode-R session directory changed");
    expect(terminal.sendText).not.toHaveBeenCalled();
    watcher.dispose();
  });

  it("rejects symlinked and hard-linked watcher artifacts", async () => {
    const symlinkFixture = await createFixture(808);
    roots.push(symlinkFixture.root);
    const realWorkspace = `${symlinkFixture.workspacePath}.real`;
    await rename(symlinkFixture.workspacePath, realWorkspace);
    await symlink(realWorkspace, symlinkFixture.workspacePath);
    const symlinkTerminal = officialTerminal(symlinkFixture, 808);
    mocks.terminals = [symlinkTerminal];
    const symlinkWatcher = createRVscodeWorkspaceWatcher(symlinkTerminal as never, {
      extensionPath: symlinkFixture.extensionPath,
      retryMs: 5
    })!;
    await expect(symlinkWatcher.readInitial()).rejects.toThrow();
    expect(symlinkTerminal.sendText).not.toHaveBeenCalled();

    const hardlinkFixture = await createFixture(809);
    roots.push(hardlinkFixture.root);
    await link(hardlinkFixture.workspacePath, `${hardlinkFixture.workspacePath}.link`);
    const hardlinkTerminal = officialTerminal(hardlinkFixture, 809);
    mocks.terminals = [hardlinkTerminal];
    const hardlinkWatcher = createRVscodeWorkspaceWatcher(hardlinkTerminal as never, {
      extensionPath: hardlinkFixture.extensionPath,
      retryMs: 5
    })!;
    await expect(hardlinkWatcher.readInitial()).rejects.toThrow("watcher file is invalid");
    expect(hardlinkTerminal.sendText).not.toHaveBeenCalled();
  });

  it("rejects malformed workspace metadata without sending terminal text", async () => {
    const fixture = await createFixture(812);
    roots.push(fixture.root);
    await writeFile(fixture.workspacePath, "{not-json");
    const terminal = officialTerminal(fixture, 812);
    mocks.terminals = [terminal];
    const watcher = createRVscodeWorkspaceWatcher(terminal as never, {
      extensionPath: fixture.extensionPath,
      retryMs: 5
    })!;

    await expect(watcher.readInitial()).rejects.toThrow("workspace metadata is malformed");
    expect(terminal.sendText).not.toHaveBeenCalled();
  });

  it("treats disabled vscode-R workspace watching as unavailable metadata", async () => {
    const fixture = await createFixture(814);
    roots.push(fixture.root);
    await writeFile(
      fixture.workspacePath,
      JSON.stringify({ search: ["package:base"], loaded_namespaces: ["base"], globalenv: null })
    );
    const terminal = officialTerminal(fixture, 814);
    mocks.terminals = [terminal];
    const watcher = createRVscodeWorkspaceWatcher(terminal as never, {
      extensionPath: fixture.extensionPath,
      retryMs: 5
    })!;

    await expect(watcher.readInitial()).rejects.toThrow("workspace watching is unavailable");
    expect(terminal.sendText).not.toHaveBeenCalled();
  });

  it("coalesces rapid workspace updates and publishes the newest complete metadata", async () => {
    const fixture = await createFixture(810);
    roots.push(fixture.root);
    const terminal = officialTerminal(fixture, 810);
    mocks.terminals = [terminal];
    const listeners = new Set<() => unknown>();
    const workspace = {
      data: {
        globalenv: {}
      } as unknown,
      onDidChangeTreeData: (listener: () => unknown) => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      }
    };
    mocks.extension = {
      extensionPath: fixture.extensionPath,
      isActive: true,
      packageJSON: { main: "./dist/extension" },
      exports: { helpPanel: undefined }
    };
    mocks.extensionModuleExports = {
      rWorkspace: workspace,
      sessionStatusBarItem: { tooltip: "R version 4.5.2\nProcess ID: 810\nCommand: R" }
    };
    const watcher = createRVscodeWorkspaceWatcher(terminal as never, {
      extensionPath: fixture.extensionPath,
      debounceMs: 15,
      retryMs: 5
    })!;
    await watcher.readInitial();
    const updates: unknown[] = [];
    watcher.onDidChangeVariables((value) => updates.push(value));

    workspace.data = {
      globalenv: {
        first: { class: ["data.frame"], type: "list", length: 1, dim: [1, 1] }
      }
    };
    for (const listener of listeners) listener();
    workspace.data = {
      globalenv: {
        latest: { class: ["tbl_df", "tbl", "data.frame"], type: "list", length: 1, dim: [4, 1] }
      }
    };
    for (const listener of listeners) listener();

    await vi.waitFor(() =>
      expect(updates.at(-1)).toEqual({
        variables: [{ name: "latest", backend: "r", dataframeFlavor: "r.tibble" }],
        truncated: false
      })
    );
    expect(updates).toHaveLength(1);
    expect(terminal.sendText).not.toHaveBeenCalled();
    watcher.dispose();
  });

  it("retries a transiently missing workspace file without invalidating the session", async () => {
    const fixture = await createFixture(811);
    roots.push(fixture.root);
    const terminal = officialTerminal(fixture, 811);
    mocks.terminals = [terminal];
    const watcher = createRVscodeWorkspaceWatcher(terminal as never, {
      extensionPath: fixture.extensionPath,
      debounceMs: 2,
      retryMs: 20
    })!;
    await watcher.readInitial();
    const updates: unknown[] = [];
    const invalidated = vi.fn();
    watcher.onDidChangeVariables((value) => updates.push(value));
    watcher.onDidInvalidate(invalidated);

    await rename(fixture.workspacePath, `${fixture.workspacePath}.replaced`);
    await writeFile(fixture.lockPath, "2.000001");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    await writeFile(
      fixture.workspacePath,
      JSON.stringify({
        search: ["package:base"],
        loaded_namespaces: ["base"],
        globalenv: {
          recovered: { class: ["data.frame"], type: "list", length: 1, dim: [2, 1] }
        }
      })
    );

    await vi.waitFor(() =>
      expect(updates.at(-1)).toEqual({
        variables: [{ name: "recovered", backend: "r", dataframeFlavor: "r.data.frame" }],
        truncated: false
      })
    );
    expect(invalidated).not.toHaveBeenCalled();
    expect(terminal.sendText).not.toHaveBeenCalled();
    watcher.dispose();
  });

  it("waits without sending text when vscode-R publishes its session metadata after terminal startup", async () => {
    const fixture = await createFixture(813);
    roots.push(fixture.root);
    await rm(fixture.requestPath);
    await rm(fixture.sessionRoot, { recursive: true });
    const terminal = officialTerminal(fixture, 813);
    mocks.terminals = [terminal];
    const watcher = createRVscodeWorkspaceWatcher(terminal as never, {
      extensionPath: fixture.extensionPath,
      retryMs: 5,
      attachTimeoutMs: 1_000
    })!;

    const initial = watcher.readInitial();
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    expect(terminal.sendText).not.toHaveBeenCalled();

    await mkdir(fixture.sessionRoot, { recursive: true });
    await publishAttach(fixture, 813);
    await publishWorkspace(fixture, 2, {
      late_orders: { class: ["data.frame"], type: "list", length: 1, dim: [3, 1] }
    });

    await expect(initial).resolves.toEqual({
      variables: [{ name: "late_orders", backend: "r", dataframeFlavor: "r.data.frame" }],
      truncated: false
    });
    expect(terminal.sendText).not.toHaveBeenCalled();
    watcher.dispose();
  });

  it("cancels a pending late-attach wait when the watcher is disposed", async () => {
    const fixture = await createFixture(815);
    roots.push(fixture.root);
    await rm(fixture.requestPath);
    await rm(fixture.sessionRoot, { recursive: true });
    const terminal = officialTerminal(fixture, 815);
    mocks.terminals = [terminal];
    const watcher = createRVscodeWorkspaceWatcher(terminal as never, {
      extensionPath: fixture.extensionPath,
      attachTimeoutMs: 10_000
    })!;

    const initial = watcher.readInitial();
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    watcher.dispose();

    const outcome = await Promise.race([
      initial.then(
        () => "resolved",
        (error: unknown) => (error instanceof Error ? error.message : "rejected")
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("timed out"), 250))
    ]);
    expect(outcome).toBe("The vscode-R workspace watcher is no longer current.");
    expect(terminal.sendText).not.toHaveBeenCalled();
  });

  it("shares one cancellable readiness wait across concurrent initial reads", async () => {
    const fixture = await createFixture(818);
    roots.push(fixture.root);
    await rm(fixture.requestPath);
    await rm(fixture.sessionRoot, { recursive: true });
    const terminal = officialTerminal(fixture, 818);
    mocks.terminals = [terminal];
    const watcher = createRVscodeWorkspaceWatcher(terminal as never, {
      extensionPath: fixture.extensionPath,
      attachTimeoutMs: 10_000
    })!;

    const first = watcher.readInitial();
    const second = watcher.readInitial();
    expect(second).toBe(first);

    watcher.dispose();
    await expect(first).rejects.toThrow("workspace watcher is no longer current");
    await expect(second).rejects.toThrow("workspace watcher is no longer current");
    expect(terminal.sendText).not.toHaveBeenCalled();
  });

  it("stops late-attach polling when the exact terminal process changes", async () => {
    const fixture = await createFixture(816);
    roots.push(fixture.root);
    await rm(fixture.requestPath);
    await rm(fixture.sessionRoot, { recursive: true });
    const terminal = officialTerminal(fixture, 816);
    mocks.terminals = [terminal];
    const watcher = createRVscodeWorkspaceWatcher(terminal as never, {
      extensionPath: fixture.extensionPath,
      attachTimeoutMs: 10_000
    })!;

    const initial = watcher.readInitial();
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    terminal.setProcessId(817);

    await expect(initial).rejects.toThrow("terminal process changed");
    expect(terminal.sendText).not.toHaveBeenCalled();
    watcher.dispose();
  });
});

async function createFixture(pid: number): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "ow-vscode-r-watcher-"));
  const extensionPath = path.join(root, "extension");
  const watcherRoot = path.join(root, "watcher");
  const tempdir = path.join(root, "Rtmp-session");
  const sessionRoot = path.join(tempdir, "vscode-R");
  await mkdir(path.join(extensionPath, "R", "session"), { recursive: true });
  await mkdir(watcherRoot);
  await mkdir(sessionRoot, { recursive: true });
  const fixture = {
    root,
    extensionPath,
    watcherRoot,
    tempdir,
    sessionRoot,
    workspacePath: path.join(sessionRoot, "workspace.json"),
    lockPath: path.join(sessionRoot, "workspace.lock"),
    requestPath: path.join(watcherRoot, "request.log")
  };
  await publishAttach(fixture, pid);
  await publishWorkspace(fixture, 1, {});
  return fixture;
}

async function publishAttach(fixture: Fixture, pid: number): Promise<void> {
  await writeFile(
    fixture.requestPath,
    JSON.stringify({
      time: "2026-08-11 00:00:00",
      pid,
      wd: fixture.root,
      command: "attach",
      version: "4.5.2",
      tempdir: fixture.tempdir,
      info: { command: "R", version: "R version 4.5.2", start_time: "2026-08-11 00:00:00" },
      plot_url: null,
      server: null
    })
  );
}

async function publishWorkspace(fixture: Fixture, version: number, globalenv: Record<string, unknown>): Promise<void> {
  await writeFile(
    fixture.workspacePath,
    JSON.stringify({ search: ["package:base"], loaded_namespaces: ["base"], globalenv })
  );
  await writeFile(fixture.lockPath, `${version}.000001`);
}

function officialTerminal(fixture: Fixture, pid: number, envOverride: Record<string, string> = {}) {
  return terminalFixture(pid, {
    name: "R Interactive",
    creationOptions: {
      name: "R Interactive",
      shellPath: "/usr/bin/R",
      env: {
        R_PROFILE_USER: path.join(fixture.extensionPath, "R", "session", "profile.R"),
        VSCODE_INIT_R: path.join(fixture.extensionPath, "R", "session", "init.R"),
        VSCODE_WATCHER_DIR: fixture.watcherRoot,
        ...envOverride
      }
    }
  });
}

function terminalFixture(
  initialProcessId: number,
  options: Readonly<{ name: string; creationOptions?: Record<string, unknown> }>
) {
  let processId = initialProcessId;
  return {
    name: options.name,
    creationOptions: options.creationOptions ?? { name: options.name, shellPath: "/bin/bash" },
    get processId() {
      return Promise.resolve(processId);
    },
    setProcessId(next: number) {
      processId = next;
    },
    sendText: vi.fn()
  };
}
