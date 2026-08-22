import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  dependencyInstallPipInitSource,
  dependencyInstallLifecycleSources,
  dependencyIsolatedInvocationSource,
  sameAcceptanceExecutable,
  validateDependencyInstallParentPipAuthority,
  waitForDependencyInstallLifecycleStart,
  withDependencyInstallLifecyclePython,
  type DependencyInstallCommandOutcome
} from "./extensionHost/dependencyInstallLifecycleFixture";

const directFixturePython =
  process.env.OPEN_WRANGLER_TEST_PYTHON ??
  process.env.OPEN_WRANGLER_PYTHON ??
  (process.platform === "win32" ? "python" : "python3");

const directFixtureArguments = [
  "install",
  "--no-input",
  "--no-user",
  "--",
  "openwrangler-direct-fixture>=1,<2"
] as const;

function waitForFixtureMarker(predicate: () => boolean, timeoutMs: number, description: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error(`Timed out waiting for ${description}.`));
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

function childOutcome(child: ChildProcess): Promise<DependencyInstallCommandOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (outcome: DependencyInstallCommandOutcome): void => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    child.once("error", (error) => settle({ status: "rejected", error }));
    child.once("close", (code, signal) => {
      if (code === 0 && signal === null) {
        settle({ status: "fulfilled", value: true });
      } else {
        settle({
          status: "rejected",
          error: new Error(`The direct fake-pip child closed with code ${String(code)} and signal ${String(signal)}.`)
        });
      }
    });
  });
}

function boundedChildOutcome(
  outcome: Promise<DependencyInstallCommandOutcome>,
  timeoutMs = 10_000
): Promise<DependencyInstallCommandOutcome> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("The direct fake-pip child did not settle within its bound.")),
      timeoutMs
    );
    timer.unref();
    void outcome.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function selectedParentPipReceipt(): Record<string, string> {
  return JSON.parse(
    execFileSync(
      directFixturePython,
      [
        "-I",
        "-c",
        [
          "import importlib.metadata",
          "import json",
          "import pip",
          "import pip._vendor.packaging.requirements",
          "import pip._vendor.packaging.specifiers",
          "import pip._vendor.packaging.utils",
          "import pip._vendor.packaging.version",
          "import sys",
          "print(json.dumps({",
          "    'executable': sys.executable,",
          "    'packagePath': __import__('os').path.dirname(pip.__file__),",
          "    'packagingRequirementsPath': pip._vendor.packaging.requirements.__file__,",
          "    'packagingSpecifiersPath': pip._vendor.packaging.specifiers.__file__,",
          "    'packagingUtilsPath': pip._vendor.packaging.utils.__file__,",
          "    'packagingVersionPath': pip._vendor.packaging.version.__file__,",
          "    'version': importlib.metadata.version('pip'),",
          "}, sort_keys=True))"
        ].join("\n")
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, windowsHide: true }
    )
  ) as Record<string, string>;
}

describe("dependency-install lifecycle fixtures", () => {
  const root = path.parse(process.cwd()).root;
  const purelib = path.join(root, "fixture", "parent", "site-packages");
  const packagePath = path.join(purelib, "pip");
  const packagingPath = path.join(packagePath, "_vendor", "packaging");
  const parentReceipt = {
    executable: path.join(root, "fixture", "parent", "bin", "python"),
    pipImportRoot: purelib,
    pip: path.join(packagePath, "__init__.py"),
    pipDistributionVersion: "25.1.1",
    pipRequirements: path.join(packagingPath, "requirements.py"),
    pipSpecifiers: path.join(packagingPath, "specifiers.py"),
    pipUtils: path.join(packagingPath, "utils.py"),
    pipVersion: path.join(packagingPath, "version.py")
  };
  const directoryStatus = () => ({ isDirectory: () => true });

  it("normalizes equivalent acceptance executable paths", () => {
    const executable = path.join(path.parse(process.cwd()).root, "fixture", "environment", "bin", "python");

    expect(sameAcceptanceExecutable(executable, path.join(executable, "..", "python"))).toBe(true);
    expect(sameAcceptanceExecutable(executable, path.join(executable, "..", "python-other"))).toBe(false);
  });

  it("builds one safely quoted isolated-interpreter invocation marker", () => {
    const invocationLog = path.join(path.parse(process.cwd()).root, 'fixture "quoted"', "invocations.log");
    const source = dependencyIsolatedInvocationSource(invocationLog);

    expect(source).toBe(
      `import builtins; builtins.open(${JSON.stringify(invocationLog)}, "a", encoding="utf-8").write("invoked\\n")\n`
    );
  });

  it("builds atomic lifecycle publications with exact environment evidence and bounds", () => {
    const started = "/fixture/pip-started.json";
    const release = "/fixture/release-pip";
    const completed = "/fixture/pip-completed.json";
    const { fakePip } = dependencyInstallLifecycleSources(started, release, completed);

    expect(fakePip).toContain(`started_path = ${JSON.stringify(started)}`);
    expect(fakePip).toContain(`release_path = ${JSON.stringify(release)}`);
    expect(fakePip).toContain(`completed_path = ${JSON.stringify(completed)}`);
    expect(fakePip).toContain("if sys.argv[1:] == ['check', '--disable-pip-version-check']:\n    raise SystemExit(0)");
    expect(fakePip).toContain("with open(temporary_path, 'x', encoding='utf-8') as stream:");
    expect(fakePip).toContain("stream.flush()\n        os.fsync(stream.fileno())");
    expect(fakePip).toContain("os.replace(temporary_path, path)");
    for (const field of [
      '"args": sys.argv[1:]',
      '"cwd": os.getcwd()',
      '"pipNoInput": os.environ.get("PIP_NO_INPUT")',
      '"pipConfigFile": os.environ.get("PIP_CONFIG_FILE")',
      '"pipUser": os.environ.get("PIP_USER")',
      '"pythonPathPresent": "PYTHONPATH" in environment_keys',
      '"pythonHomePresent": "PYTHONHOME" in environment_keys'
    ]) {
      expect(fakePip).toContain(field);
    }
    expect(fakePip.indexOf("publish_json(started_path, details)")).toBeLessThan(
      fakePip.indexOf("while not os.path.exists(release_path):")
    );
    expect(fakePip.indexOf("if sys.argv[1:] == ['check', '--disable-pip-version-check']:")).toBeLessThan(
      fakePip.indexOf("publish_json(started_path, details)")
    );
    expect(fakePip).toContain("deadline = time.monotonic() + 30");
    expect(fakePip).toContain("raise SystemExit(92)");
    expect(fakePip).toContain("time.sleep(0.025)");
    expect(fakePip).toContain("publish_json(completed_path, {**details, 'released': True})");
    expect(fakePip.endsWith("\n")).toBe(true);
  });

  it("binds the fake pip namespace to one verified parent vendored-packaging owner", () => {
    const authority = validateDependencyInstallParentPipAuthority(parentReceipt, directoryStatus);

    expect(authority).toEqual({
      executable: parentReceipt.executable,
      packagePath,
      packagingRequirementsPath: parentReceipt.pipRequirements,
      packagingSpecifiersPath: parentReceipt.pipSpecifiers,
      packagingUtilsPath: parentReceipt.pipUtils,
      packagingVersionPath: parentReceipt.pipVersion,
      version: parentReceipt.pipDistributionVersion
    });
    expect(dependencyInstallPipInitSource(authority)).toBe(
      `__version__ = "25.1.1"\n__path__.append(${JSON.stringify(packagePath)})\n`
    );
  });

  it("rejects absent, substituted, and unverified parent vendored-packaging ownership", () => {
    expect(() =>
      validateDependencyInstallParentPipAuthority({ ...parentReceipt, pipRequirements: undefined }, directoryStatus)
    ).toThrow(/Requirement implementation must be one absolute path/u);
    expect(() =>
      validateDependencyInstallParentPipAuthority(
        { ...parentReceipt, pipVersion: path.join(root, "fixture", "substitute", "version.py") },
        directoryStatus
      )
    ).toThrow(/Version implementation must belong to the verified parent pip packaging owner/u);
    expect(() =>
      validateDependencyInstallParentPipAuthority(
        { ...parentReceipt, pip: path.join(root, "fixture", "unowned", "pip", "__init__.py") },
        directoryStatus
      )
    ).toThrow(/must belong to the selected parent interpreter's import root/u);
    expect(() =>
      validateDependencyInstallParentPipAuthority(parentReceipt, (candidate) => ({
        isDirectory: () => candidate !== packagingPath
      }))
    ).toThrow(/packaging owner must be a directory/u);
  });

  it("surfaces exact command rejection before the bounded start-marker wait", async () => {
    const rejection = new Error("dependency guard rejected the fixture directly");
    const waitCalls: Array<{ timeoutMs: number; description: string }> = [];

    await expect(
      waitForDependencyInstallLifecycleStart({
        pendingCommand: Promise.resolve({ status: "rejected", error: rejection }),
        started: path.join(root, "fixture", "pip-started.json"),
        waitFor: (_predicate, timeoutMs, description) => {
          waitCalls.push({ timeoutMs, description });
          return new Promise<void>(() => undefined);
        }
      })
    ).rejects.toBe(rejection);
    expect(waitCalls).toEqual([
      {
        timeoutMs: 10_000,
        description: "the disposable fake pip process to publish its start marker"
      }
    ]);
  });

  it("preserves marker success and bounded marker failures", async () => {
    let markerPredicate: (() => boolean) | undefined;
    await expect(
      waitForDependencyInstallLifecycleStart({
        pendingCommand: new Promise(() => undefined),
        started: path.join(root, "fixture", "pip-started.json"),
        waitFor: async (predicate) => {
          markerPredicate = predicate;
        }
      })
    ).resolves.toBeUndefined();
    expect(markerPredicate?.()).toBe(false);

    const timeout = new Error("bounded marker timeout");
    await expect(
      waitForDependencyInstallLifecycleStart({
        pendingCommand: new Promise(() => undefined),
        started: path.join(root, "fixture", "pip-started.json"),
        waitFor: async () => {
          throw timeout;
        }
      })
    ).rejects.toBe(timeout);
  });

  it("rejects an impossible fulfilled command before the start marker", async () => {
    await expect(
      waitForDependencyInstallLifecycleStart({
        pendingCommand: Promise.resolve({ status: "fulfilled", value: false }),
        started: path.join(root, "fixture", "pip-started.json"),
        waitFor: () => new Promise<void>(() => undefined)
      })
    ).rejects.toThrow(/fulfilled with false before the disposable fake pip process published its start marker/u);
  });

  it("removes empty and working-directory import entries from the isolated interpreter", () => {
    const { siteCustomize } = dependencyInstallLifecycleSources(
      "/fixture/pip-started.json",
      "/fixture/release-pip",
      "/fixture/pip-completed.json"
    );

    expect(siteCustomize).toContain('sys.path[:] = [entry for entry in sys.path if entry != ""]');
    expect(siteCustomize).toContain("cwd = os.path.normcase(os.path.abspath(os.getcwd()))");
    expect(siteCustomize).toContain("if os.path.normcase(os.path.abspath(entry)) != cwd");
    expect(siteCustomize.endsWith("\n")).toBe(true);
  });

  it.each(["parent-pip-validation", "virtual-environment-creation", "fake-pip-preparation", "fixture-preflight"])(
    "cleans the complete owned lifetime when %s fails before start",
    async (stage) => {
      let directory: string | undefined;
      let cleanupCalls = 0;
      let useCalls = 0;
      const failure = new Error(`injected ${stage} failure`);

      await expect(
        withDependencyInstallLifecyclePython(
          "unused-python",
          async () => {
            useCalls += 1;
          },
          {
            makeTemporaryDirectory: (prefix) => {
              directory = mkdtempSync(prefix);
              return directory;
            },
            createLifecycle: (ownedDirectory) => {
              const environment = path.join(ownedDirectory, "environment");
              if (stage !== "parent-pip-validation") mkdirSync(environment);
              if (stage === "fake-pip-preparation" || stage === "fixture-preflight") {
                const pipPackage = path.join(environment, "pip");
                mkdirSync(pipPackage);
                writeFileSync(path.join(pipPackage, "__main__.py"), "# owned fake pip\n", {
                  encoding: "utf8",
                  flag: "wx"
                });
              }
              writeFileSync(path.join(ownedDirectory, `${stage}.marker`), "owned\n", {
                encoding: "utf8",
                flag: "wx"
              });
              throw failure;
            },
            cleanupTemporaryDirectory: (ownedDirectory) => {
              cleanupCalls += 1;
              rmSync(ownedDirectory, { force: true, recursive: true });
            }
          }
        )
      ).rejects.toBe(failure);

      expect(useCalls).toBe(0);
      expect(cleanupCalls).toBe(1);
      expect(directory).toBeDefined();
      expect(existsSync(directory as string)).toBe(false);
    }
  );

  it("keeps the shutdown journey inside the shared lifecycle owner", () => {
    const source = readFileSync(
      path.join(import.meta.dirname, "extensionHost", "dependencyInstallShutdownJourney.ts"),
      "utf8"
    );

    expect(source).toContain("await withDependencyInstallLifecyclePython(");
    expect(source).not.toContain("mkdtempSync");
    expect(source).not.toContain("createDependencyInstallLifecyclePython");
    expect(source.indexOf("await withDependencyInstallLifecyclePython(")).toBeLessThan(
      source.indexOf('vscode.workspace.getConfiguration("openWrangler")')
    );
  });

  it("executes the provisioned fake-pip READY/GO lifecycle and cleans success and rejection", async () => {
    const expectedParent = selectedParentPipReceipt();

    for (const rejectCompletion of [false, true]) {
      let ownedDirectory: string | undefined;
      let child: ChildProcess | undefined;
      let pendingOutcome: Promise<DependencyInstallCommandOutcome> | undefined;
      const observed: string[] = [];
      const run = withDependencyInstallLifecyclePython(directFixturePython, async ({ directory, lifecycle }) => {
        ownedDirectory = directory;
        expect(lifecycle.parentPip).toEqual(expectedParent);
        expect(path.isAbsolute(lifecycle.parentPip.executable)).toBe(true);
        expect(sameAcceptanceExecutable(lifecycle.parentPip.executable, expectedParent.executable)).toBe(true);
        for (const candidate of [
          lifecycle.parentPip.packagePath,
          lifecycle.parentPip.packagingRequirementsPath,
          lifecycle.parentPip.packagingSpecifiersPath,
          lifecycle.parentPip.packagingUtilsPath,
          lifecycle.parentPip.packagingVersionPath
        ]) {
          expect(existsSync(candidate)).toBe(true);
        }
        expect(existsSync(lifecycle.started)).toBe(false);
        expect(existsSync(lifecycle.release)).toBe(false);
        expect(existsSync(lifecycle.completed)).toBe(false);
        if (rejectCompletion) mkdirSync(lifecycle.completed);

        const environment = { ...process.env };
        delete environment.PYTHONHOME;
        delete environment.PYTHONPATH;
        environment.PIP_CONFIG_FILE = process.platform === "win32" ? "nul" : "/dev/null";
        environment.PIP_NO_INPUT = "1";
        environment.PIP_USER = "0";
        child = spawn(lifecycle.executable, ["-I", "-m", "pip", ...directFixtureArguments], {
          cwd: directory,
          env: environment,
          stdio: "ignore",
          windowsHide: true
        });
        pendingOutcome = childOutcome(child);
        try {
          await waitForDependencyInstallLifecycleStart({
            pendingCommand: pendingOutcome,
            started: lifecycle.started,
            waitFor: waitForFixtureMarker
          });
          observed.push("READY", "start");
          const started = JSON.parse(readFileSync(lifecycle.started, "utf8")) as Record<string, unknown>;
          expect(started.args).toEqual(directFixtureArguments);
          expect(started.cwd).toBe(directory);
          expect(started.pipNoInput).toBe("1");
          expect(started.pipUser).toBe("0");
          expect(started.pipConfigFile).toBe(process.platform === "win32" ? "nul" : "/dev/null");
          expect(started.pythonPathPresent).toBe(false);
          expect(started.pythonHomePresent).toBe(false);
          expect(existsSync(lifecycle.release)).toBe(false);
          expect(existsSync(lifecycle.completed)).toBe(rejectCompletion);

          writeFileSync(lifecycle.release, "GO\n", { encoding: "utf8", flag: "wx" });
          observed.push("GO", "release");
          const outcome = await boundedChildOutcome(pendingOutcome);
          if (rejectCompletion) {
            expect(outcome.status).toBe("rejected");
            throw outcome.status === "rejected" ? outcome.error : new Error("Expected fake-pip rejection.");
          }
          expect(outcome).toEqual({ status: "fulfilled", value: true });
          const completed = JSON.parse(readFileSync(lifecycle.completed, "utf8")) as Record<string, unknown>;
          expect(completed).toEqual({ ...started, released: true });
          observed.push("completed");
        } finally {
          if (child.exitCode === null && child.signalCode === null) child.kill();
          await boundedChildOutcome(pendingOutcome);
          expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
        }
      });

      if (rejectCompletion) {
        await expect(run).rejects.toThrow(/direct fake-pip child closed/u);
        expect(observed).toEqual(["READY", "start", "GO", "release"]);
      } else {
        await expect(run).resolves.toBeUndefined();
        expect(observed).toEqual(["READY", "start", "GO", "release", "completed"]);
      }
      expect(ownedDirectory).toBeDefined();
      expect(existsSync(ownedDirectory as string)).toBe(false);
    }
  }, 120_000);
});
