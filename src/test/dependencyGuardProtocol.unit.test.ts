import { describe, expect, it } from "vitest";
import {
  DEPENDENCY_GUARD_MAX_FRAME_BYTES,
  DependencyGuardProtocolError
} from "../extension/dependencyGuardFrameReader";
import {
  DEPENDENCY_GUARD_EXIT_CODES,
  DEPENDENCY_GUARD_PROTOCOL,
  DependencyGuardCommandError,
  decodeDependencyGuardError,
  decodeDependencyGuardReady,
  decodeDependencyGuardStatus,
  decodeDependencyGuardValidation,
  dependencyGuardCodeForExit,
  dependencyGuardDependencyWire,
  dependencyGuardEnvironmentWire,
  encodeDependencyGuardFrame,
  isCanonicalDependencyGuardToken,
  type DependencyGuardErrorCode
} from "../extension/dependencyGuardProtocol";
import type { PythonEnvironment } from "../extension/pythonEnvironment";
import type { PythonDependency } from "../extension/pythonEnvironmentModel";

const TOKEN = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const EXPECTED_DEPENDENCY_GUARD_EXIT_CODES = {
  invalid_request: 10,
  busy: 11,
  malformed_state: 12,
  validation_failed: 13,
  pip_failed: 14,
  stale_or_missing_marker: 15,
  environment_changed: 16,
  internal_error: 17,
  environment_inconsistent: 18,
  post_install_inconsistent: 19,
  integrity_check_failed: 20
} as const satisfies Readonly<Record<DependencyGuardErrorCode, number>>;
const ENVIRONMENT: PythonEnvironment = {
  executable: "/env/bin/python",
  executableIdentity: {
    device: "2049",
    inode: "998877",
    size: "18200",
    mtimeNs: "1711111111000000000",
    ctimeNs: "1711111112000000000"
  },
  version: "3.12.4",
  packageRoot: "/env",
  packageRootIdentity: { device: "2049", inode: "887766" },
  source: "configuration"
};

describe("dependency guard protocol", () => {
  it("recognizes only lowercase UUID-shaped tokens", () => {
    expect(isCanonicalDependencyGuardToken(TOKEN)).toBe(true);
    for (const value of [
      undefined,
      null,
      1,
      "",
      "11111111-2222-4333-8444-55555555555",
      "{aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee}",
      TOKEN.toUpperCase()
    ]) {
      expect(isCanonicalDependencyGuardToken(value)).toBe(false);
    }
  });

  it("owns the exact environment and dependency wire shapes", () => {
    expect(dependencyGuardEnvironmentWire(ENVIRONMENT)).toEqual({
      executable: "/env/bin/python",
      executableIdentity: {
        device: "2049",
        inode: "998877",
        size: "18200",
        mtimeNs: "1711111111000000000",
        ctimeNs: "1711111112000000000"
      },
      packageRoot: "/env",
      packageRootIdentity: { device: "2049", inode: "887766" },
      pythonVersion: "3.12.4"
    });

    const dependency: PythonDependency = {
      importModule: "pandas",
      distribution: "pandas",
      installSpec: "pandas>=2.2,<4",
      minimumVersion: "2.2",
      maximumVersionExclusive: "4"
    };
    expect(dependencyGuardDependencyWire(dependency)).toEqual({
      importModule: "pandas",
      distribution: "pandas",
      installSpec: "pandas>=2.2,<4",
      exactVersion: null,
      minimumVersion: "2.2",
      maximumVersionExclusive: "4"
    });
    expect(
      dependencyGuardDependencyWire({
        ...dependency,
        installSpec: "pandas==2.2.3",
        exactVersion: "2.2.3",
        minimumVersion: undefined,
        maximumVersionExclusive: undefined
      })
    ).toEqual({
      importModule: "pandas",
      distribution: "pandas",
      installSpec: "pandas==2.2.3",
      exactVersion: "2.2.3",
      minimumVersion: null,
      maximumVersionExclusive: null
    });
  });

  it("encodes one bounded LF-terminated request frame", () => {
    expect(encodeDependencyGuardFrame({ protocol: DEPENDENCY_GUARD_PROTOCOL, kind: "status" })).toEqual(
      Buffer.from(`{"protocol":"${DEPENDENCY_GUARD_PROTOCOL}","kind":"status"}\n`, "utf8")
    );
    expect(() => encodeDependencyGuardFrame({ value: "x".repeat(DEPENDENCY_GUARD_MAX_FRAME_BYTES) })).toThrow(
      `exceeds ${DEPENDENCY_GUARD_MAX_FRAME_BYTES} bytes`
    );
  });

  it("decodes only an exact correlated READY frame", () => {
    const ready = { protocol: DEPENDENCY_GUARD_PROTOCOL, kind: "ready", token: TOKEN };
    expect(decodeDependencyGuardReady(ready, TOKEN)).toEqual(ready);
    for (const frame of [
      { ...ready, token: "11111111-2222-4333-8444-555555555555" },
      { ...ready, token: TOKEN.toUpperCase() },
      { ...ready, protocol: "other" },
      { ...ready, kind: "status" },
      { ...ready, extra: true }
    ]) {
      expect(() => decodeDependencyGuardReady(frame, TOKEN)).toThrow(DependencyGuardProtocolError);
    }
  });

  it("decodes exact clean and dirty status pairs and rejects mixed states", () => {
    const clean = { protocol: DEPENDENCY_GUARD_PROTOCOL, kind: "status", state: "clean", token: null };
    const dirty = { protocol: DEPENDENCY_GUARD_PROTOCOL, kind: "status", state: "dirty", token: TOKEN };
    expect(decodeDependencyGuardStatus(clean)).toEqual(clean);
    expect(decodeDependencyGuardStatus(dirty)).toEqual(dirty);
    for (const frame of [
      { ...clean, token: TOKEN },
      { ...dirty, token: null },
      { ...dirty, token: TOKEN.toUpperCase() },
      { ...dirty, state: "unknown" },
      { ...dirty, extra: true }
    ]) {
      expect(() => decodeDependencyGuardStatus(frame)).toThrow(DependencyGuardProtocolError);
    }
  });

  it("binds validation to one exact expected token", () => {
    const validated = { protocol: DEPENDENCY_GUARD_PROTOCOL, kind: "validated", token: TOKEN };
    expect(decodeDependencyGuardValidation(validated, TOKEN)).toEqual(validated);
    for (const frame of [
      { ...validated, token: "11111111-2222-4333-8444-555555555555" },
      { ...validated, token: TOKEN.toUpperCase() },
      { ...validated, kind: "status" },
      { ...validated, extra: true }
    ]) {
      expect(() => decodeDependencyGuardValidation(frame, TOKEN)).toThrow(DependencyGuardProtocolError);
    }
  });

  it("owns the complete stable helper-error to exit-code mapping", () => {
    expect(DEPENDENCY_GUARD_EXIT_CODES).toEqual(EXPECTED_DEPENDENCY_GUARD_EXIT_CODES);
    for (const [code, exitCode] of Object.entries(EXPECTED_DEPENDENCY_GUARD_EXIT_CODES)) {
      const error = decodeDependencyGuardError(
        { protocol: DEPENDENCY_GUARD_PROTOCOL, kind: "error", code },
        "status",
        "/env/bin/python"
      );
      expect(error).toBeInstanceOf(DependencyGuardCommandError);
      expect(error).toMatchObject({ mode: "status", code, exitCode, executable: "/env/bin/python" });
      expect(dependencyGuardCodeForExit(exitCode)).toBe(code);
    }
    expect(dependencyGuardCodeForExit(0)).toBeUndefined();
    for (const frame of [
      { protocol: DEPENDENCY_GUARD_PROTOCOL, kind: "error", code: "unknown" },
      { protocol: DEPENDENCY_GUARD_PROTOCOL, kind: "error", code: "busy", extra: true },
      { protocol: DEPENDENCY_GUARD_PROTOCOL, kind: "status", code: "busy" },
      { protocol: "other", kind: "error", code: "busy" }
    ]) {
      expect(() => decodeDependencyGuardError(frame, "status", "/env/bin/python")).toThrow(
        DependencyGuardProtocolError
      );
    }
  });
});
