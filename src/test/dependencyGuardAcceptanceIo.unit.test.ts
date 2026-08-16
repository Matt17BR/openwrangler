import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAcceptanceSignalExclusively,
  dependencyGuardAcceptanceProcessEnvironment,
  parseAcceptanceGuardFrames,
  readBoundedAcceptanceJson,
  readDependencyGuardAcceptanceInvocations,
  readDependencyGuardParentAuthorization,
  readDependencyGuardParentState,
  readDependencyGuardProbeInvocations
} from "./extensionHost/dependencyGuardAcceptanceIo";
import type { DependencyGuardRecoveryFixture } from "./extensionHost/dependencyGuardRecoveryFixture";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "openwrangler-dependency-guard-io-"));
  roots.push(root);
  return root;
}

function fixture(root: string): DependencyGuardRecoveryFixture {
  return {
    directory: root,
    executable: "/fixture/python",
    helperPath: "/fixture/guard.py",
    environment: {
      executable: "/fixture/python",
      executableIdentity: { device: "1", inode: "2", size: "3", mtimeNs: "4", ctimeNs: "5" },
      packageRoot: "/fixture",
      packageRootIdentity: { device: "1", inode: "6" },
      pythonVersion: "3.13.7"
    },
    dependency: {
      importModule: "fixture",
      distribution: "fixture",
      installSpec: "fixture==1",
      minimumVersion: "1",
      maximumVersionExclusive: "2"
    },
    marker: join(root, "marker"),
    pipStarted: join(root, "started"),
    pipRelease: join(root, "release"),
    pipCompleted: join(root, "completed"),
    parentScript: join(root, "parent.py"),
    parentState: join(root, "state.json"),
    parentAuthorized: join(root, "authorized.json"),
    parentCrashFrame: "crash\n",
    invocationLog: join(root, "invocations.jsonl"),
    dependencyProbeLog: join(root, "probes.jsonl")
  };
}

describe("dependency-guard acceptance IO", () => {
  it("parses only bounded LF-delimited object frames", () => {
    expect(parseAcceptanceGuardFrames('{"kind":"ready"}\n{"kind":"done"}\n')).toEqual([
      { kind: "ready" },
      { kind: "done" }
    ]);
    expect(() => parseAcceptanceGuardFrames('{"kind":"ready"}\r\n')).toThrow();
    expect(() => parseAcceptanceGuardFrames("[]\n")).toThrow();
    expect(() => parseAcceptanceGuardFrames("x".repeat(65_537) + "\n")).toThrow();
  });

  it("reads one bounded identity-stable JSON file and exact parent schemas", () => {
    const root = fixtureRoot();
    const state = join(root, "state.json");
    const authorized = join(root, "authorized.json");
    writeFileSync(state, JSON.stringify({ guardPid: 13, parentPid: 12 }));
    writeFileSync(
      authorized,
      JSON.stringify({ guardPid: 13, kind: "authorized", parentPid: 12, protocol: "v1", token: "token" })
    );

    expect(readBoundedAcceptanceJson(state)).toEqual({ guardPid: 13, parentPid: 12 });
    expect(readDependencyGuardParentState(state)).toEqual({ guardPid: 13, parentPid: 12 });
    expect(readDependencyGuardParentAuthorization(authorized)).toEqual({
      guardPid: 13,
      kind: "authorized",
      parentPid: 12,
      protocol: "v1",
      token: "token"
    });
    writeFileSync(join(root, "oversized.json"), "x".repeat(4_097));
    expect(() => readBoundedAcceptanceJson(join(root, "oversized.json"))).toThrow();
  });

  it("publishes one exclusive identity-bound cleanup signal without overwriting it", () => {
    const signal = join(fixtureRoot(), "release");

    createAcceptanceSignalExclusively(signal, "release\n");
    createAcceptanceSignalExclusively(signal, "replacement\n");

    expect(readFileSync(signal, "utf8")).toBe("release\n");
  });

  it("bounds and validates dependency probe and process invocation evidence", () => {
    const owned = fixture(fixtureRoot());
    expect(readDependencyGuardProbeInvocations(owned)).toEqual([]);
    writeFileSync(owned.dependencyProbeLog, '{"module":"pandas"}\n{"module":"polars"}\n');
    writeFileSync(owned.invocationLog, '["python","-I"]\n["python","-m","pip"]\n');

    expect(readDependencyGuardProbeInvocations(owned)).toEqual([{ module: "pandas" }, { module: "polars" }]);
    expect(readDependencyGuardAcceptanceInvocations(owned)).toEqual([
      ["python", "-I"],
      ["python", "-m", "pip"]
    ]);
  });

  it("passes only platform allowlisted host values plus explicit runner overrides", () => {
    const environment = dependencyGuardAcceptanceProcessEnvironment({ OPEN_WRANGLER_ACCEPTANCE_SENTINEL: "owned" });
    const allowed = new Set([
      "APPDATA",
      "COMSPEC",
      "HOME",
      "LANG",
      "LC_ALL",
      "LOCALAPPDATA",
      "PATH",
      "PATHEXT",
      "SYSTEMROOT",
      "TEMP",
      "TMP",
      "TMPDIR",
      "TZ",
      "USERPROFILE",
      "WINDIR",
      "OPEN_WRANGLER_ACCEPTANCE_SENTINEL"
    ]);

    expect(environment.OPEN_WRANGLER_ACCEPTANCE_SENTINEL).toBe("owned");
    expect(Object.keys(environment).every((key) => allowed.has(key.toLocaleUpperCase("en-US")))).toBe(true);
  });
});
