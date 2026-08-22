import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEPENDENCY_GUARD_ACCEPTANCE_TOKEN,
  DEPENDENCY_GUARD_FIXTURE_DISTRIBUTION,
  DEPENDENCY_GUARD_FIXTURE_IMPORT_FILE,
  DEPENDENCY_GUARD_FIXTURE_IMPORT_MODULE,
  DEPENDENCY_GUARD_FIXTURE_METADATA_DIRECTORY,
  DEPENDENCY_GUARD_PARENT_CRASH_EXIT_CODE,
  DEPENDENCY_GUARD_PROTOCOL,
  createDependencyGuardFixtureDistribution,
  dependencyGuardFakePipSource,
  dependencyGuardInvocationRecorderSource,
  dependencyGuardParentSource,
  dependencyGuardProbeRecorderSource,
  dependencyGuardProtocolFrames,
  type DependencyGuardAcceptanceDependency,
  type DependencyGuardAcceptanceEnvironment
} from "./extensionHost/dependencyGuardRecoveryFixture";

interface DependencyGuardFixtureOwnershipReceipt {
  readonly files: readonly string[] | null;
  readonly owned: boolean;
  readonly recordSource: string;
}

type DependencyGuardFixtureRecordMutation = (recordSource: string) => string | null;

const expectedDependencyGuardFixtureRecordSource = [
  `${DEPENDENCY_GUARD_FIXTURE_IMPORT_FILE},,`,
  `${DEPENDENCY_GUARD_FIXTURE_METADATA_DIRECTORY}/METADATA,,`,
  `${DEPENDENCY_GUARD_FIXTURE_METADATA_DIRECTORY}/RECORD,,`,
  ""
].join("\n");

const dependencyGuardPath = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "python",
  "openwrangler_runtime",
  "dependency_guard.py"
);
const testPython =
  process.env.OPEN_WRANGLER_TEST_PYTHON ??
  process.env.OPEN_WRANGLER_PYTHON ??
  (process.platform === "win32" ? "python" : "python3");

function inspectFixtureOwnership(
  mutateRecord?: DependencyGuardFixtureRecordMutation
): DependencyGuardFixtureOwnershipReceipt {
  const directory = mkdtempSync(path.join(tmpdir(), "openwrangler-dependency-record-"));
  try {
    createDependencyGuardFixtureDistribution(directory);
    const recordPath = path.join(directory, DEPENDENCY_GUARD_FIXTURE_METADATA_DIRECTORY, "RECORD");
    const recordSource = readFileSync(recordPath, "utf8");
    if (mutateRecord !== undefined) {
      const mutatedRecordSource = mutateRecord(recordSource);
      if (mutatedRecordSource === null) {
        rmSync(recordPath);
      } else {
        if (mutatedRecordSource === recordSource) {
          throw new Error("The hostile RECORD mutation must change the isolated fixture copy.");
        }
        writeFileSync(recordPath, mutatedRecordSource, { encoding: "utf8" });
      }
    }
    // This owner tests RECORD mapping. The dependency-guard owners separately
    // cover descriptor identity, so pin only the imported file identity here to
    // keep unrelated OS-temp ancestor activity out of this fixture proof.
    const ownership = JSON.parse(
      execFileSync(
        testPython,
        [
          "-I",
          "-B",
          "-c",
          [
            "import importlib",
            "import importlib.metadata",
            "import importlib.util",
            "import json",
            "import os",
            "import sys",
            "guard_path, site_packages = sys.argv[1:]",
            "sys.path.insert(0, site_packages)",
            "specification = importlib.util.spec_from_file_location('openwrangler_dependency_guard_fixture_test', guard_path)",
            "guard = importlib.util.module_from_spec(specification)",
            "specification.loader.exec_module(guard)",
            `module = importlib.import_module(${JSON.stringify(DEPENDENCY_GUARD_FIXTURE_IMPORT_MODULE)})`,
            `distribution = importlib.metadata.distribution(${JSON.stringify(DEPENDENCY_GUARD_FIXTURE_DISTRIBUTION)})`,
            "origin = os.path.normcase(os.path.abspath(module.__file__))",
            "owned_identity = ('dependency-record-fixture',)",
            "guard._regular_module_file_identity = lambda candidate: (",
            "    owned_identity",
            "    if isinstance(candidate, str)",
            "    and os.path.normcase(os.path.abspath(candidate)) == origin",
            "    else None",
            ")",
            "files = distribution.files",
            "print(json.dumps({",
            "    'files': None if files is None else [str(item) for item in files],",
            "    'owned': guard._distribution_owns_module(distribution, module),",
            "}, separators=(',', ':'), sort_keys=True))"
          ].join("\n"),
          dependencyGuardPath,
          directory
        ],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 30_000,
          windowsHide: true
        }
      )
    ) as DependencyGuardFixtureOwnershipReceipt;
    return { ...ownership, recordSource };
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

const environment: DependencyGuardAcceptanceEnvironment = {
  executable: "/fixture/environment/bin/python",
  executableIdentity: { device: "1", inode: "2", size: "3", mtimeNs: "4", ctimeNs: "5" },
  packageRoot: "/fixture/environment",
  packageRootIdentity: { device: "1", inode: "6" },
  pythonVersion: "3.13.7"
};

const dependency: DependencyGuardAcceptanceDependency = {
  importModule: DEPENDENCY_GUARD_FIXTURE_IMPORT_MODULE,
  distribution: DEPENDENCY_GUARD_FIXTURE_DISTRIBUTION,
  installSpec: `${DEPENDENCY_GUARD_FIXTURE_DISTRIBUTION}>=1.0.0,<2.0.0`,
  exactVersion: null,
  minimumVersion: "1.0.0",
  maximumVersionExclusive: "2.0.0"
};

describe("dependency-guard recovery fixture", () => {
  it("binds the synthetic module to its exact distribution RECORD", () => {
    const receipt = inspectFixtureOwnership();

    expect(receipt).toEqual({
      files: [
        DEPENDENCY_GUARD_FIXTURE_IMPORT_FILE,
        `${DEPENDENCY_GUARD_FIXTURE_METADATA_DIRECTORY}/METADATA`,
        `${DEPENDENCY_GUARD_FIXTURE_METADATA_DIRECTORY}/RECORD`
      ],
      owned: true,
      recordSource: expectedDependencyGuardFixtureRecordSource
    });
  });

  const hostileRecordMutations: ReadonlyArray<
    readonly [string, DependencyGuardFixtureRecordMutation, readonly string[] | null]
  > = [
    ["an absent RECORD", () => null, null],
    [
      "a mismatched module entry",
      (recordSource) =>
        recordSource.replace(
          `${DEPENDENCY_GUARD_FIXTURE_IMPORT_FILE},,`,
          `${DEPENDENCY_GUARD_FIXTURE_IMPORT_MODULE}/fixture.py,,`
        ),
      [
        `${DEPENDENCY_GUARD_FIXTURE_METADATA_DIRECTORY}/METADATA`,
        `${DEPENDENCY_GUARD_FIXTURE_METADATA_DIRECTORY}/RECORD`
      ]
    ],
    [
      "a foreign module entry",
      (recordSource) =>
        recordSource.replace(`${DEPENDENCY_GUARD_FIXTURE_IMPORT_FILE},,`, "foreign_guard_fixture/__init__.py,,"),
      [
        `${DEPENDENCY_GUARD_FIXTURE_METADATA_DIRECTORY}/METADATA`,
        `${DEPENDENCY_GUARD_FIXTURE_METADATA_DIRECTORY}/RECORD`
      ]
    ]
  ];

  it.each(hostileRecordMutations)("rejects fixture ownership with %s", (_label, mutateRecord, expectedFiles) => {
    expect(inspectFixtureOwnership(mutateRecord)).toEqual({
      files: expectedFiles,
      owned: false,
      recordSource: expectedDependencyGuardFixtureRecordSource
    });
  });

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
    expect(source).toContain("from pip._internal.cli.main import main as pip_main");
    expect(source.indexOf("if sys.argv[1:] == ['check', '--disable-pip-version-check']:")).toBeLessThan(
      source.indexOf("publish_json(started_path, {'args': sys.argv[1:]})")
    );
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
