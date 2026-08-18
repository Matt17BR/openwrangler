import {
  DEPENDENCY_GUARD_MAX_FRAME_BYTES,
  DependencyGuardProtocolError,
  type DependencyGuardMode
} from "./dependencyGuardFrameReader";
import type { PythonEnvironment } from "./pythonEnvironment";
import type { PythonDependency } from "./pythonEnvironmentModel";
import { isFullyQualifiedPythonPath } from "./pythonPath";

export const DEPENDENCY_GUARD_PROTOCOL = "openwrangler-dependency-guard-v1";

export type DependencyGuardErrorCode =
  | "invalid_request"
  | "busy"
  | "malformed_state"
  | "validation_failed"
  | "pip_failed"
  | "stale_or_missing_marker"
  | "environment_changed"
  | "internal_error";

export const DEPENDENCY_GUARD_EXIT_CODES: Readonly<Record<DependencyGuardErrorCode, number>> = {
  invalid_request: 10,
  busy: 11,
  malformed_state: 12,
  validation_failed: 13,
  pip_failed: 14,
  stale_or_missing_marker: 15,
  environment_changed: 16,
  internal_error: 17
};

const DEPENDENCY_GUARD_CODES_BY_EXIT = new Map<number, DependencyGuardErrorCode>(
  Object.entries(DEPENDENCY_GUARD_EXIT_CODES).map(([code, exitCode]) => [exitCode, code as DependencyGuardErrorCode])
);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface DependencyGuardReady {
  readonly protocol: typeof DEPENDENCY_GUARD_PROTOCOL;
  readonly kind: "ready";
  readonly token: string;
}

export type DependencyGuardStatus =
  | {
      readonly protocol: typeof DEPENDENCY_GUARD_PROTOCOL;
      readonly kind: "status";
      readonly state: "clean";
      readonly token: null;
    }
  | {
      readonly protocol: typeof DEPENDENCY_GUARD_PROTOCOL;
      readonly kind: "status";
      readonly state: "dirty";
      readonly token: string;
    };

export interface DependencyGuardValidation {
  readonly protocol: typeof DEPENDENCY_GUARD_PROTOCOL;
  readonly kind: "validated";
  readonly token: string;
}

export class DependencyGuardCommandError extends Error {
  readonly exitCode: number;

  constructor(
    readonly mode: DependencyGuardMode,
    readonly code: DependencyGuardErrorCode,
    readonly executable: string
  ) {
    const exitCode = DEPENDENCY_GUARD_EXIT_CODES[code];
    super(`Open Wrangler dependency guard ${mode} with ${executable} failed with ${code} (exit code ${exitCode}).`);
    this.name = "DependencyGuardCommandError";
    this.exitCode = exitCode;
  }
}

export function dependencyGuardCodeForExit(exitCode: number): DependencyGuardErrorCode | undefined {
  return DEPENDENCY_GUARD_CODES_BY_EXIT.get(exitCode);
}

export function decodeDependencyGuardReady(frame: Record<string, unknown>, token: string): DependencyGuardReady {
  requireExactFrameKeys(frame, ["protocol", "kind", "token"], "install");
  if (
    frame.protocol !== DEPENDENCY_GUARD_PROTOCOL ||
    frame.kind !== "ready" ||
    frame.token !== token ||
    !isCanonicalDependencyGuardToken(frame.token)
  ) {
    throw new DependencyGuardProtocolError("install", "the helper published an invalid or mis-correlated READY frame");
  }
  return { protocol: DEPENDENCY_GUARD_PROTOCOL, kind: "ready", token };
}

export function decodeDependencyGuardStatus(frame: Record<string, unknown>): DependencyGuardStatus {
  requireExactFrameKeys(frame, ["protocol", "kind", "state", "token"], "status");
  if (frame.protocol !== DEPENDENCY_GUARD_PROTOCOL || frame.kind !== "status") {
    throw new DependencyGuardProtocolError("status", "the helper published an invalid status frame");
  }
  if (frame.state === "clean" && frame.token === null) {
    return { protocol: DEPENDENCY_GUARD_PROTOCOL, kind: "status", state: "clean", token: null };
  }
  if (frame.state === "dirty" && typeof frame.token === "string" && isCanonicalDependencyGuardToken(frame.token)) {
    return { protocol: DEPENDENCY_GUARD_PROTOCOL, kind: "status", state: "dirty", token: frame.token };
  }
  throw new DependencyGuardProtocolError("status", "the helper published an inconsistent status state/token pair");
}

export function decodeDependencyGuardValidation(
  frame: Record<string, unknown>,
  expectedToken: string
): DependencyGuardValidation {
  requireExactFrameKeys(frame, ["protocol", "kind", "token"], "validate");
  if (
    frame.protocol !== DEPENDENCY_GUARD_PROTOCOL ||
    frame.kind !== "validated" ||
    typeof frame.token !== "string" ||
    !isCanonicalDependencyGuardToken(frame.token) ||
    frame.token !== expectedToken
  ) {
    throw new DependencyGuardProtocolError(
      "validate",
      "the helper published an invalid or mis-correlated validation frame"
    );
  }
  return { protocol: DEPENDENCY_GUARD_PROTOCOL, kind: "validated", token: frame.token };
}

export function decodeDependencyGuardError(
  frame: Record<string, unknown>,
  mode: DependencyGuardMode,
  executable: string
): DependencyGuardCommandError {
  requireExactFrameKeys(frame, ["protocol", "kind", "code"], mode);
  if (
    frame.protocol !== DEPENDENCY_GUARD_PROTOCOL ||
    frame.kind !== "error" ||
    typeof frame.code !== "string" ||
    !isDependencyGuardErrorCode(frame.code)
  ) {
    throw new DependencyGuardProtocolError(mode, "the helper published an invalid error frame");
  }
  return new DependencyGuardCommandError(mode, frame.code, executable);
}

export function dependencyGuardEnvironmentWire(environment: PythonEnvironment): {
  executable: string;
  executableIdentity: {
    device: string;
    inode: string;
    size: string;
    mtimeNs: string;
    ctimeNs: string;
  };
  packageRoot: string;
  packageRootIdentity: { device: string; inode: string };
  pythonVersion: string;
} {
  return {
    executable: environment.executable,
    executableIdentity: {
      device: environment.executableIdentity.device,
      inode: environment.executableIdentity.inode,
      size: environment.executableIdentity.size,
      mtimeNs: environment.executableIdentity.mtimeNs,
      ctimeNs: environment.executableIdentity.ctimeNs
    },
    packageRoot: environment.packageRoot,
    packageRootIdentity: {
      device: environment.packageRootIdentity.device,
      inode: environment.packageRootIdentity.inode
    },
    pythonVersion: environment.version
  };
}

export function dependencyGuardDependencyWire(dependency: PythonDependency): {
  importModule: string;
  distribution: string;
  installSpec: string;
  exactVersion: string | null;
  minimumVersion: string | null;
  maximumVersionExclusive: string | null;
} {
  return {
    importModule: dependency.importModule,
    distribution: dependency.distribution,
    installSpec: dependency.installSpec,
    exactVersion: dependency.exactVersion ?? null,
    minimumVersion: dependency.minimumVersion ?? null,
    maximumVersionExclusive: dependency.maximumVersionExclusive ?? null
  };
}

export function validateDependencyGuardTarget(environment: PythonEnvironment, helperPath: string): void {
  if (!isFullyQualifiedPythonPath(environment.executable)) {
    throw new Error("Python dependency guard requires an absolute executable path.");
  }
  if (!isFullyQualifiedPythonPath(environment.packageRoot)) {
    throw new Error("Python dependency guard requires an absolute package-root path.");
  }
  if (!isFullyQualifiedPythonPath(helperPath)) {
    throw new Error("Python dependency guard requires an absolute helper path.");
  }
}

export function encodeDependencyGuardFrame(payload: unknown): Buffer {
  const encoded = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
  if (encoded.length > DEPENDENCY_GUARD_MAX_FRAME_BYTES) {
    throw new Error(
      `Dependency guard request exceeds ${DEPENDENCY_GUARD_MAX_FRAME_BYTES} bytes including its LF terminator.`
    );
  }
  return encoded;
}

export function isCanonicalDependencyGuardToken(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function requireExactFrameKeys(
  frame: Record<string, unknown>,
  expected: readonly string[],
  mode: DependencyGuardMode
): void {
  const actual = Object.keys(frame);
  if (actual.length !== expected.length || expected.some((key) => !Object.hasOwn(frame, key))) {
    throw new DependencyGuardProtocolError(mode, "the helper frame had an unexpected shape");
  }
}

function isDependencyGuardErrorCode(value: string): value is DependencyGuardErrorCode {
  return Object.hasOwn(DEPENDENCY_GUARD_EXIT_CODES, value);
}
