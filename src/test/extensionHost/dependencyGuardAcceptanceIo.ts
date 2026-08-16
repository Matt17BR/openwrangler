import * as assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync
} from "node:fs";
import { DEPENDENCY_GUARD_PROTOCOL, type DependencyGuardRecoveryFixture } from "./dependencyGuardRecoveryFixture";

export interface AcceptanceGuardProcess {
  child: ChildProcessWithoutNullStreams;
  exit: Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>;
  closed: boolean;
  parentPid?: number;
}

export function launchAcceptanceGuardParent(fixture: DependencyGuardRecoveryFixture): AcceptanceGuardProcess {
  const child = spawn(fixture.executable, ["-I", fixture.parentScript], {
    cwd: fixture.directory,
    env: dependencyGuardAcceptanceProcessEnvironment(),
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  const handle: AcceptanceGuardProcess = {
    child,
    exit: Promise.resolve({
      code: null,
      signal: null,
      stdout: "",
      stderr: ""
    }),
    closed: false
  };
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let outputOverflow = false;
  let processError: Error | undefined;
  const capture = (chunks: Buffer[], chunk: Buffer, stream: "stdout" | "stderr"): void => {
    if (stream === "stdout") stdoutBytes += chunk.byteLength;
    else stderrBytes += chunk.byteLength;
    if (stdoutBytes > 65_536 || stderrBytes > 65_536) {
      outputOverflow = true;
      return;
    }
    chunks.push(Buffer.from(chunk));
  };
  child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk, "stdout"));
  child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk, "stderr"));
  child.once("error", (error) => {
    processError = error;
  });
  handle.exit = new Promise((resolve, reject) => {
    child.once("close", (code, signal) => {
      handle.closed = true;
      if (processError) {
        reject(processError);
        return;
      }
      if (outputOverflow) {
        reject(new Error("Dependency-guard acceptance output exceeded its fixed 64 KiB bound."));
        return;
      }
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
  });
  return handle;
}

export function parseAcceptanceGuardFrames(stdout: string): Record<string, unknown>[] {
  assert.ok(Buffer.byteLength(stdout, "utf8") <= 65_536);
  assert.ok(stdout.endsWith("\n") && !stdout.endsWith("\r\n"));
  return stdout
    .slice(0, -1)
    .split("\n")
    .map((frame) => {
      const decoded = JSON.parse(frame) as unknown;
      assert.ok(decoded && typeof decoded === "object" && !Array.isArray(decoded));
      return decoded as Record<string, unknown>;
    });
}

export function readDependencyGuardParentState(file: string): { parentPid: number; guardPid: number } {
  const decoded = readBoundedAcceptanceJson(file);
  assert.deepEqual(Object.keys(decoded).sort(), ["guardPid", "parentPid"]);
  assert.ok(Number.isSafeInteger(decoded.parentPid) && (decoded.parentPid as number) > 0);
  assert.ok(Number.isSafeInteger(decoded.guardPid) && (decoded.guardPid as number) > 0);
  return {
    parentPid: decoded.parentPid as number,
    guardPid: decoded.guardPid as number
  };
}

export function readDependencyGuardParentAuthorization(file: string): Record<string, unknown> {
  const decoded = readBoundedAcceptanceJson(file);
  assert.deepEqual(Object.keys(decoded).sort(), ["guardPid", "kind", "parentPid", "protocol", "token"]);
  return decoded;
}

export function readBoundedAcceptanceJson(file: string): Record<string, unknown> {
  let descriptor: number | undefined;
  let payload: Buffer | undefined;
  let operationError: unknown;
  try {
    descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = fstatSync(descriptor, { bigint: true });
    assert.ok(opened.isFile() && opened.nlink === 1n);
    assert.ok(opened.size > 0n && opened.size <= 4_096n);

    const boundedPayload = Buffer.alloc(4_097);
    let offset = 0;
    while (offset < boundedPayload.byteLength) {
      const count = readSync(descriptor, boundedPayload, offset, boundedPayload.byteLength - offset, null);
      if (count === 0) break;
      offset += count;
    }
    assert.ok(offset > 0 && offset <= 4_096);

    const completed = fstatSync(descriptor, { bigint: true });
    assert.ok(
      completed.isFile() &&
        completed.nlink === 1n &&
        completed.dev === opened.dev &&
        completed.ino === opened.ino &&
        completed.size === opened.size &&
        completed.size === BigInt(offset) &&
        completed.mtimeNs === opened.mtimeNs &&
        completed.ctimeNs === opened.ctimeNs,
      "Bounded acceptance evidence must not change while its owned descriptor is read."
    );
    const pathIdentity = lstatSync(file, { bigint: true });
    assert.ok(
      pathIdentity.isFile() &&
        !pathIdentity.isSymbolicLink() &&
        pathIdentity.nlink === 1n &&
        pathIdentity.dev === completed.dev &&
        pathIdentity.ino === completed.ino,
      "Bounded acceptance evidence must retain its opened file identity."
    );
    payload = Buffer.from(boundedPayload.subarray(0, offset));
  } catch (error) {
    operationError = error;
  }

  let closeError: unknown;
  if (descriptor !== undefined) {
    try {
      closeSync(descriptor);
    } catch (error) {
      closeError = error;
    }
  }
  if (operationError && closeError) {
    throw new AggregateError(
      [operationError, closeError],
      "Bounded acceptance evidence read and descriptor close both failed."
    );
  }
  if (operationError) throw operationError;
  if (closeError) throw closeError;
  assert.ok(payload);

  const decoded = JSON.parse(payload.toString("utf8")) as unknown;
  assert.ok(decoded && typeof decoded === "object" && !Array.isArray(decoded));
  return decoded as Record<string, unknown>;
}

export function acceptanceProcessIsAlive(pid: number): boolean {
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

export function readAcceptanceGuardStatus(fixture: DependencyGuardRecoveryFixture): Record<string, unknown> {
  const stdout = execFileSync(fixture.executable, ["-I", fixture.helperPath, "status"], {
    cwd: fixture.directory,
    env: dependencyGuardAcceptanceProcessEnvironment(),
    input: `${JSON.stringify({
      protocol: DEPENDENCY_GUARD_PROTOCOL,
      kind: "status",
      environment: fixture.environment
    })}\n`,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 30_000,
    windowsHide: true
  });
  const frames = parseAcceptanceGuardFrames(stdout);
  assert.equal(frames.length, 1);
  return frames[0]!;
}

export function readDependencyGuardProbeInvocations(
  fixture: DependencyGuardRecoveryFixture
): Record<string, unknown>[] {
  if (!existsSync(fixture.dependencyProbeLog)) return [];
  const payload = readFileSync(fixture.dependencyProbeLog);
  assert.ok(payload.byteLength <= 65_536, "Dependency-probe invocation evidence exceeded 64 KiB.");
  const lines = payload.toString("utf8").split("\n");
  assert.equal(lines.pop(), "");
  assert.ok(lines.length <= 64, "Dependency-probe invocation evidence exceeded 64 calls.");
  return lines.map((line) => {
    const decoded = JSON.parse(line) as unknown;
    assert.ok(
      decoded &&
        typeof decoded === "object" &&
        !Array.isArray(decoded) &&
        typeof (decoded as Record<string, unknown>).module === "string"
    );
    return decoded as Record<string, unknown>;
  });
}

export function readDependencyGuardAcceptanceInvocations(fixture: DependencyGuardRecoveryFixture): string[][] {
  const payload = readFileSync(fixture.invocationLog);
  assert.ok(payload.byteLength <= 65_536, "Dependency-recovery invocation evidence exceeded 64 KiB.");
  const lines = payload.toString("utf8").split("\n");
  assert.equal(lines.pop(), "");
  assert.ok(lines.length <= 64, "Dependency-recovery invocation evidence exceeded 64 processes.");
  return lines.map((line) => {
    const decoded = JSON.parse(line) as unknown;
    assert.ok(Array.isArray(decoded) && decoded.every((argument) => typeof argument === "string"));
    return decoded as string[];
  });
}

export function dependencyGuardAcceptanceProcessEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  const allowedKeys = new Set([
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
    "WINDIR"
  ]);
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && allowedKeys.has(key.toLocaleUpperCase("en-US"))) {
      environment[key] = value;
    }
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

export function createAcceptanceSignalExclusively(file: string, content: string): void {
  let descriptor: number;
  try {
    descriptor = openSync(
      file,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      // Another cleanup observer already published the one-shot release signal.
      return;
    }
    throw error;
  }

  let operationError: unknown;
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    assert.ok(
      opened.isFile() && opened.nlink === 1n,
      "An acceptance cleanup signal must be one exclusively owned regular file."
    );
    writeFileSync(descriptor, content, "utf8");
    const completed = fstatSync(descriptor, { bigint: true });
    assert.ok(
      completed.isFile() &&
        completed.nlink === 1n &&
        completed.dev === opened.dev &&
        completed.ino === opened.ino &&
        completed.size === BigInt(Buffer.byteLength(content, "utf8")),
      "An acceptance cleanup signal must retain its exclusive file identity while written."
    );
    const pathIdentity = lstatSync(file, { bigint: true });
    assert.ok(
      pathIdentity.isFile() &&
        !pathIdentity.isSymbolicLink() &&
        pathIdentity.nlink === 1n &&
        pathIdentity.dev === completed.dev &&
        pathIdentity.ino === completed.ino,
      "An acceptance cleanup signal path must retain its exclusive file identity."
    );
  } catch (error) {
    operationError = error;
  }

  let closeError: unknown;
  try {
    closeSync(descriptor);
  } catch (error) {
    closeError = error;
  }
  if (operationError && closeError) {
    throw new AggregateError(
      [operationError, closeError],
      "Acceptance cleanup signal publication and descriptor close both failed."
    );
  }
  if (operationError) throw operationError;
  if (closeError) throw closeError;
}
