import { describe, expect, it } from "vitest";
import {
  DEPENDENCY_GUARD_ACCEPTANCE_TOKEN,
  DEPENDENCY_GUARD_PARENT_CRASH_EXIT_CODE,
  DEPENDENCY_GUARD_PROTOCOL,
  dependencyGuardFakePipSource,
  dependencyGuardInvocationRecorderSource,
  dependencyGuardParentSource,
  dependencyGuardProbeRecorderSource,
  dependencyGuardProtocolFrames,
  type DependencyGuardAcceptanceDependency,
  type DependencyGuardAcceptanceEnvironment
} from "./extensionHost/dependencyGuardRecoveryFixture";

const environment: DependencyGuardAcceptanceEnvironment = {
  executable: "/fixture/environment/bin/python",
  executableIdentity: { device: "1", inode: "2", size: "3", mtimeNs: "4", ctimeNs: "5" },
  packageRoot: "/fixture/environment",
  packageRootIdentity: { device: "1", inode: "6" },
  pythonVersion: "3.13.7"
};

const dependency: DependencyGuardAcceptanceDependency = {
  importModule: "openwrangler_guard_fixture",
  distribution: "openwrangler-guard-fixture",
  installSpec: "openwrangler-guard-fixture>=1.0.0,<2.0.0",
  exactVersion: null,
  minimumVersion: "1.0.0",
  maximumVersionExclusive: "2.0.0"
};

describe("dependency-guard recovery fixture", () => {
  it("builds JSON-safe invocation and dependency-probe recorders", () => {
    const invocationLog = '/fixture/"invocations".jsonl';
    const probeLog = '/fixture/"probes".jsonl';
    const invocation = dependencyGuardInvocationRecorderSource(invocationLog);
    const probes = dependencyGuardProbeRecorderSource(probeLog);

    expect(invocation).toContain(`open(${JSON.stringify(invocationLog)}, "a", encoding="utf-8")`);
    expect(invocation).toContain("json.dumps(sys.argv, separators=(',', ':')) + '\\n'");
    expect(invocation).toContain("stream.flush(); os.fsync(stream.fileno()); stream.close()");
    expect(probes).toContain(`_log_path = ${JSON.stringify(probeLog)}`);
    expect(probes).toContain("def _recording_find_spec(name, *args, **kwargs):");
    expect(probes).toContain("stream.flush()\n        os.fsync(stream.fileno())");
    expect(probes).toContain("return _original_find_spec(name, *args, **kwargs)");
    expect(probes.endsWith("\n")).toBe(true);
  });

  it("builds exclusive atomic fake-pip start and completion publications with fixed bounds", () => {
    const source = dependencyGuardFakePipSource("/fixture/started", "/fixture/release", "/fixture/completed");

    expect(source).toContain("with open(temporary_path, 'x', encoding='utf-8') as stream:");
    expect(source).toContain("json.dump(value, stream, sort_keys=True)");
    expect(source).toContain("stream.flush()\n        os.fsync(stream.fileno())");
    expect(source).toContain("os.replace(temporary_path, path)");
    expect(source).toContain("publish_json(started_path, {'args': sys.argv[1:]})");
    expect(source).toContain("deadline = time.monotonic() + 60");
    expect(source).toContain("raise SystemExit(91)");
    expect(source).toContain("time.sleep(0.025)");
    expect(source).toContain("publish_json(completed_path, {'completed': True})");
  });

  it("builds exact correlated install, authorization, and crash protocol frames", () => {
    const frames = dependencyGuardProtocolFrames(environment, dependency);

    expect(JSON.parse(frames.install)).toEqual({
      protocol: DEPENDENCY_GUARD_PROTOCOL,
      kind: "install",
      token: DEPENDENCY_GUARD_ACCEPTANCE_TOKEN,
      environment,
      dependencies: [dependency]
    });
    expect(JSON.parse(frames.go)).toEqual({
      protocol: DEPENDENCY_GUARD_PROTOCOL,
      kind: "go",
      token: DEPENDENCY_GUARD_ACCEPTANCE_TOKEN
    });
    expect(JSON.parse(frames.crash)).toEqual({
      protocol: DEPENDENCY_GUARD_PROTOCOL,
      kind: "crash",
      token: DEPENDENCY_GUARD_ACCEPTANCE_TOKEN
    });
    expect(Object.values(frames).every((frame) => frame.endsWith("\n"))).toBe(true);
  });

  it("builds a bounded parent that authorizes before its exact deliberate crash", () => {
    const frames = dependencyGuardProtocolFrames(environment, dependency);
    const source = dependencyGuardParentSource({
      directory: "/fixture",
      helperPath: '/fixture/"guard".py',
      parentState: "/fixture/state.json",
      parentAuthorized: "/fixture/authorized.json",
      pipRelease: "/fixture/release",
      installFrame: frames.install,
      goFrame: frames.go,
      parentCrashFrame: frames.crash
    });

    expect(source).toContain(`helper_path = ${JSON.stringify('/fixture/"guard".py')}`);
    expect(source).toContain("[sys.executable, '-I', helper_path, 'install']");
    expect(source).toContain("ready_raw = guard.stdout.readline(65537)");
    expect(source).toContain("len(ready_raw) > 65536");
    expect(source.indexOf("guard.stdin.write(go_frame)")).toBeLessThan(source.indexOf("authorized = True"));
    expect(source.indexOf("authorized = True")).toBeLessThan(source.indexOf("crash_request = sys.stdin.buffer.read"));
    expect(source).toContain(`crash_exit_code = ${DEPENDENCY_GUARD_PARENT_CRASH_EXIT_CODE}`);
    expect(source).toContain("os._exit(crash_exit_code)");
    expect(source).toContain("if authorized:\n            try:");
    expect(source).toContain("guard.wait(timeout=10)");
    expect(source.endsWith("\n")).toBe(true);
  });
});
