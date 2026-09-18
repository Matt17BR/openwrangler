import { access, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import * as vscode from "vscode";
import { repairRFileDependencies, type RFileDependencyTarget } from "../extension/r/rFileDependencies";
import type { RDependencyProcessOptions } from "../extension/r/rDependencyProcess";
import type { RDependencyRequirement } from "../extension/r/rDependencyRequirements";

const mocks = vi.hoisted(() => ({ run: vi.fn(), readOnly: new Set<string>() }));
vi.mock("../extension/r/rDependencyProcess", () => ({ startRDependencyProcess: mocks.run }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    access: async (...args: Parameters<typeof actual.access>) => {
      if (mocks.readOnly.has(String(args[0]))) throw Object.assign(new Error("read only"), { code: "EACCES" });
      return actual.access(...args);
    }
  };
});

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

const missing: readonly RDependencyRequirement[] = [
  { packageName: "arrow", minimumVersion: "23.0.1.1", namespaceAvailable: false }
];
const normalized = (value: string) => value.replaceAll(sep, "/");
interface Probe {
  rHome: string;
  rVersion: string;
  libraryPaths: string[];
  userLibrary: string;
  requirements: readonly RDependencyRequirement[];
}
interface Step {
  mode: "probe" | "install";
  probe?: Partial<Probe>;
  failure?: Error;
  report?: unknown;
  completion?: ReturnType<typeof deferred>;
  settlement?: ReturnType<typeof deferred>;
}

let fixture: string;
let target: RFileDependencyTarget;
let baseline: Probe;
let steps: Step[];
let privateRoots: Set<string>;
let holds: ReturnType<typeof deferred>[];
let choices: MockInstance<typeof vscode.window.showWarningMessage>;

function schedule(...next: Step[]) {
  steps.push(...next);
}
function processes(mode: Step["mode"]) {
  return mocks.run.mock.calls
    .map(([options]) => options as RDependencyProcessOptions)
    .filter((options) => options.mode === mode);
}

beforeEach(async () => {
  mocks.run.mockReset();
  mocks.readOnly.clear();
  fixture = await mkdtemp(join(tmpdir(), "ow-r-repair-workflow-"));
  const executable = join(fixture, "Rscript");
  const library = join(fixture, "library");
  await writeFile(executable, "captured executable");
  await mkdir(library);
  target = {
    runtimeRoot: join(fixture, "runtime"),
    rscriptPath: executable,
    cwd: vscode.Uri.file(fixture),
    environment: Object.freeze({
      PATH: "/captured/bin",
      R_LIBS: library,
      R_LIBS_USER: join(fixture, "personal"),
      LITERAL: "$(keep literal)"
    }),
    format: "parquet"
  };
  baseline = {
    rHome: normalized(fixture),
    rVersion: "4.5.2",
    libraryPaths: [normalized(library)],
    userLibrary: normalized(join(fixture, "personal")),
    requirements: missing
  };
  steps = [];
  holds = [];
  privateRoots = new Set();
  choices = vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Install" as never);
  mocks.run.mockImplementation((options: RDependencyProcessOptions) => {
    privateRoots.add(dirname(options.scriptPath));
    const step = steps.shift();
    if (!step || step.mode !== options.mode) throw new Error(`Unexpected ${options.mode} process`);
    if (step.completion) holds.push(step.completion);
    if (step.settlement) holds.push(step.settlement);
    const completion = (async () => {
      if (options.mode === "probe") {
        await writeFile(
          join(dirname(options.scriptPath), `${basename(options.scriptPath, ".R")}.json`),
          JSON.stringify({ ...baseline, ...step.probe })
        );
      } else if (step.report !== undefined) {
        await writeFile(join(dirname(options.scriptPath), "install-result.json"), JSON.stringify(step.report));
      }
      if (step.completion) await step.completion.promise;
      if (step.failure) throw step.failure;
    })();
    return {
      completion,
      settlement:
        step.settlement?.promise ??
        completion.then(
          () => undefined,
          () => undefined
        )
    };
  });
});

afterEach(async () => {
  holds.forEach((hold) => hold.resolve());
  Object.assign(vscode.workspace, { isTrusted: true });
  await vi.waitFor(
    async () => {
      for (const root of privateRoots) await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
    },
    { timeout: 1000, interval: 10 }
  );
  await rm(fixture, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("captured native R file dependency repair", () => {
  it("releases repair ownership after setup fails before a process starts", async () => {
    await expect(
      repairRFileDependencies({ ...target, rscriptPath: join(fixture, "missing-Rscript") }, missing, "base")
    ).rejects.toMatchObject({ code: "ENOENT" });
    schedule({ mode: "probe", probe: { requirements: [] } });
    await expect(repairRFileDependencies(target, missing, "base")).resolves.toEqual({});
    expect(mocks.run).toHaveBeenCalledOnce();
  });

  it("uses a fresh availability result without requesting installation", async () => {
    schedule({ mode: "probe", probe: { requirements: [] } });
    await expect(repairRFileDependencies(target, missing, "base")).resolves.toEqual({});
    expect(choices).not.toHaveBeenCalled();
    expect(processes("install")).toEqual([]);
  });

  it("confirms the captured environment and validates it freshly after installation", async () => {
    const configuration = vi.spyOn(vscode.workspace, "getConfiguration").mockImplementation(() => {
      throw new Error("must not reselect R");
    });
    const information = vi.spyOn(vscode.window, "showInformationMessage");
    schedule({ mode: "probe" }, { mode: "install" }, { mode: "probe", probe: { requirements: [] } });
    await expect(repairRFileDependencies(target, missing, "base")).resolves.toEqual({
      libraryPath: baseline.libraryPaths[0]
    });
    const [, modal, action] = choices.mock.calls[0]!;
    expect(modal).toMatchObject({ modal: true });
    for (const detail of [
      target.rscriptPath,
      baseline.rHome,
      baseline.rVersion,
      baseline.libraryPaths[0]!,
      "arrow >= 23.0.1.1",
      "https://cloud.r-project.org"
    ])
      expect((modal as vscode.MessageOptions).detail).toContain(detail);
    expect(action).toBe("Install");
    expect(processes("probe")).toHaveLength(2);
    expect(processes("install")).toHaveLength(1);
    for (const [options] of mocks.run.mock.calls) {
      expect(options).toMatchObject({
        rscriptPath: target.rscriptPath,
        cwd: target.cwd,
        environment: { PATH: "/captured/bin", LITERAL: "$(keep literal)" }
      });
    }
    expect(processes("install")[0]!.environment).toBe(target.environment);
    expect(processes("probe")[1]!.environment.R_LIBS?.split(process.platform === "win32" ? ";" : ":")[0]).toBe(
      baseline.libraryPaths[0]
    );
    expect(configuration).not.toHaveBeenCalled();
    expect(information).toHaveBeenCalledOnce();
  });

  it.each(["decline", "trust revoked", "cancelled"])(
    "does not write packages when confirmation is %s",
    async (reason) => {
      const cancellation = new vscode.CancellationTokenSource();
      schedule({ mode: "probe" });
      choices.mockImplementation(async () => {
        if (reason === "trust revoked") Object.assign(vscode.workspace, { isTrusted: false });
        if (reason === "cancelled") cancellation.cancel();
        return (reason === "decline" ? undefined : "Install") as never;
      });
      await expect(
        repairRFileDependencies(target, missing, "base", { cancellation: cancellation.token })
      ).resolves.toBe(false);
      expect(processes("install")).toEqual([]);
      cancellation.dispose();
    }
  );

  it.each(["untrusted", "cancelled"])("does not probe an initially %s request", async (reason) => {
    const cancellation = new vscode.CancellationTokenSource();
    if (reason === "untrusted") Object.assign(vscode.workspace, { isTrusted: false });
    else cancellation.cancel();
    await expect(repairRFileDependencies(target, missing, "base", { cancellation: cancellation.token })).resolves.toBe(
      false
    );
    expect(mocks.run).not.toHaveBeenCalled();
    cancellation.dispose();
  });

  it.each(["executable", "library"])("refuses a replaced %s after confirmation", async (kind) => {
    schedule({ mode: "probe" });
    choices.mockImplementation(async () => {
      const changed = kind === "executable" ? target.rscriptPath : baseline.libraryPaths[0]!;
      await rename(changed, `${changed}.old`);
      if (kind === "executable") await writeFile(changed, "replacement executable");
      else await mkdir(changed);
      return "Install" as never;
    });
    await expect(repairRFileDependencies(target, missing, "base")).rejects.toThrow(
      "executable or package library changed"
    );
    expect(processes("install")).toEqual([]);
  });

  it("refuses an installer success when the fresh environment still lacks packages", async () => {
    schedule({ mode: "probe" }, { mode: "install", report: ["Arrow compilation failed"] }, { mode: "probe" });
    const information = vi.spyOn(vscode.window, "showInformationMessage");
    await expect(repairRFileDependencies(target, missing, "base")).rejects.toThrow(
      /Still unavailable: arrow.*Arrow compilation failed/u
    );
    expect(processes("probe")).toHaveLength(2);
    expect(information).not.toHaveBeenCalled();
  });

  it("refuses post-install validation from a changed R environment", async () => {
    schedule({ mode: "probe" }, { mode: "install" }, { mode: "probe", probe: { requirements: [], rVersion: "4.6.0" } });
    await expect(repairRFileDependencies(target, missing, "base")).rejects.toThrow("R environment changed");
  });

  it.each([
    { report: ["Build tools are unavailable"], guidance: "Build tools are unavailable" },
    { report: ["private diagnostic".repeat(1000)], guidance: undefined }
  ])("retains only bounded installation guidance ($guidance)", async ({ report, guidance }) => {
    schedule(
      { mode: "probe" },
      { mode: "install", failure: new Error("The R dependency install process exited with code 1."), report }
    );
    const result = repairRFileDependencies(target, missing, "base");
    await expect(result).rejects.toThrow("exited with code 1");
    const error = await result.catch((value: unknown) => value as Error);
    expect((error as Error).message.length).toBeLessThan(4300);
    if (guidance) expect((error as Error).message).toContain(guidance);
    else expect((error as Error).message).not.toContain("private diagnostic");
    expect(processes("probe")).toHaveLength(1);
  });

  it("confirms a personal-library fallback explicitly when the first library is read-only", async () => {
    mocks.readOnly.add(baseline.libraryPaths[0]!);
    baseline.userLibrary = normalized(join(fixture, "personal", "4.5"));
    schedule({ mode: "probe" }, { mode: "install" }, { mode: "probe", probe: { requirements: [] } });
    await expect(repairRFileDependencies(target, missing, "base")).resolves.toEqual({
      libraryPath: baseline.userLibrary
    });
    expect((choices.mock.calls[0]![1] as vscode.MessageOptions).detail).toContain(
      `Package library: ${baseline.userLibrary}`
    );
  });

  it("resolves a relative personal library against the captured R working directory", async () => {
    mocks.readOnly.add(baseline.libraryPaths[0]!);
    baseline.userLibrary = "relative-library/4.5";
    const expected = normalized(join(target.cwd.fsPath, "relative-library", "4.5"));
    schedule({ mode: "probe" }, { mode: "install" }, { mode: "probe", probe: { requirements: [] } });
    await expect(repairRFileDependencies(target, missing, "base")).resolves.toEqual({ libraryPath: expected });
    expect((choices.mock.calls[0]![1] as vscode.MessageOptions).detail).toContain(`Package library: ${expected}`);
  });

  it("holds writer ownership across waiter cancellation until the terminal actually settles", async () => {
    const cancellation = new vscode.CancellationTokenSource();
    const completion = deferred();
    const settlement = deferred();
    schedule({ mode: "probe" }, { mode: "install", completion, settlement });
    const first = repairRFileDependencies(target, missing, "base", { cancellation: cancellation.token });
    await vi.waitFor(() => expect(processes("install")).toHaveLength(1));
    const installationRoot = dirname(processes("install")[0]!.scriptPath);
    cancellation.cancel();
    completion.reject(new Error("cancelled"));
    await expect(first).resolves.toBe(false);
    await expect(access(installationRoot)).resolves.toBeUndefined();
    const otherExecutable = join(fixture, "other-Rscript");
    await writeFile(otherExecutable, "another captured executable");
    await expect(repairRFileDependencies({ ...target, rscriptPath: otherExecutable }, missing, "base")).rejects.toThrow(
      /still running|already running/u
    );
    expect(processes("probe")).toHaveLength(1);
    settlement.resolve();
    await vi.waitFor(async () => await expect(access(installationRoot)).rejects.toMatchObject({ code: "ENOENT" }));
    schedule({ mode: "probe", probe: { requirements: [] } });
    await expect(repairRFileDependencies(target, missing, "base")).resolves.toEqual({});
    cancellation.dispose();
  });
});
