import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  dependencyInstallPipInitSource,
  dependencyInstallLifecycleSources,
  dependencyIsolatedInvocationSource,
  sameAcceptanceExecutable,
  validateDependencyInstallParentPipAuthority,
  waitForDependencyInstallLifecycleStart
} from "./extensionHost/dependencyInstallLifecycleFixture";

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
});
