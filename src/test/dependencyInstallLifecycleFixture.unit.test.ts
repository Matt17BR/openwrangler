import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  dependencyInstallLifecycleSources,
  dependencyIsolatedInvocationSource,
  sameAcceptanceExecutable
} from "./extensionHost/dependencyInstallLifecycleFixture";

describe("dependency-install lifecycle fixtures", () => {
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
    expect(fakePip).toContain("deadline = time.monotonic() + 30");
    expect(fakePip).toContain("raise SystemExit(92)");
    expect(fakePip).toContain("time.sleep(0.025)");
    expect(fakePip).toContain("publish_json(completed_path, {**details, 'released': True})");
    expect(fakePip.endsWith("\n")).toBe(true);
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
