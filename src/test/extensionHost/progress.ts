import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
  type BigIntStats
} from "node:fs";
import { isAbsolute } from "node:path";

export const ACCEPTANCE_PROGRESS_MAX_BYTES = 1024;
export const ACCEPTANCE_PROGRESS_PROTOCOL = 1;

export interface AcceptanceProgressEnvelope {
  protocol: typeof ACCEPTANCE_PROGRESS_PROTOCOL;
  runId: string;
  phase: string;
  checkpoint: string;
}

interface AcceptanceProgressWriteOptions {
  randomId?: () => string;
}

export function acceptanceProgressSignalPath(progressPath: string, runId: string, phase: string): string {
  return `${progressPath}.${runId.replaceAll("-", "")}.${phase}.heartbeat`;
}

export function writeAcceptanceProgressCheckpoint(
  progressPath: string,
  envelope: AcceptanceProgressEnvelope,
  { randomId = randomUUID }: AcceptanceProgressWriteOptions = {}
): void {
  if (
    typeof progressPath !== "string" ||
    progressPath.length === 0 ||
    progressPath.length > 16_384 ||
    !isAbsolute(progressPath) ||
    /[\0\r\n]/u.test(progressPath)
  ) {
    throw new Error("An editor acceptance progress path must be a bounded absolute filesystem path.");
  }
  if (!isAcceptanceProgressEnvelope(envelope)) {
    throw new Error(
      "An editor acceptance checkpoint must be an exact protocol/runId/phase/checkpoint envelope with bounded single-line strings."
    );
  }
  const serialized = `${JSON.stringify(envelope)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > ACCEPTANCE_PROGRESS_MAX_BYTES) {
    throw new Error("An editor acceptance checkpoint envelope must be at most 1024 UTF-8 bytes including its newline.");
  }

  const suffix = randomId();
  if (!/^[0-9A-Za-z-]{1,64}$/u.test(suffix)) {
    throw new Error("An editor acceptance checkpoint temporary suffix must be a bounded safe identifier.");
  }
  publishAcceptanceProgressFile(progressPath, serialized, suffix, "checkpoint");
  publishAcceptanceProgressFile(
    acceptanceProgressSignalPath(progressPath, envelope.runId, envelope.phase),
    "",
    suffix,
    "heartbeat"
  );
}

function publishAcceptanceProgressFile(targetPath: string, content: string, suffix: string, description: string): void {
  const temporaryPath = `${targetPath}.${process.pid}.${suffix}.tmp`;
  let descriptor: number | undefined;
  let ownedIdentity: BigIntStats | undefined;
  let renamed = false;
  let operationError: unknown;
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    ownedIdentity = fstatSync(descriptor, { bigint: true });
    if (!ownedIdentity.isFile() || ownedIdentity.nlink !== 1n) {
      throw new Error(`The acceptance ${description} temporary must be one exclusively owned regular file.`);
    }
    writeFileSync(descriptor, content, { encoding: "utf8" });
    const completed = fstatSync(descriptor, { bigint: true });
    if (
      !completed.isFile() ||
      completed.nlink !== 1n ||
      completed.dev !== ownedIdentity.dev ||
      completed.ino !== ownedIdentity.ino
    ) {
      throw new Error(`The acceptance ${description} temporary changed while it was written.`);
    }
    closeSync(descriptor);
    descriptor = undefined;
    const pathIdentity = lstatSync(temporaryPath, { bigint: true });
    if (
      !pathIdentity.isFile() ||
      pathIdentity.isSymbolicLink() ||
      pathIdentity.nlink !== 1n ||
      pathIdentity.dev !== completed.dev ||
      pathIdentity.ino !== completed.ino
    ) {
      throw new Error(`The acceptance ${description} temporary path changed before publication.`);
    }
    renameSync(temporaryPath, targetPath);
    renamed = true;
  } catch (error) {
    operationError = error;
  }

  const cleanupErrors: unknown[] = [];
  if (descriptor !== undefined) {
    try {
      closeSync(descriptor);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (!renamed && ownedIdentity) {
    try {
      const current = lstatSync(temporaryPath, { bigint: true });
      if (
        current.isFile() &&
        !current.isSymbolicLink() &&
        current.nlink === 1n &&
        current.dev === ownedIdentity.dev &&
        current.ino === ownedIdentity.ino
      ) {
        rmSync(temporaryPath, { force: true });
      }
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") {
        cleanupErrors.push(error);
      }
    }
  }
  if (operationError && cleanupErrors.length > 0) {
    throw new AggregateError(
      [operationError, ...cleanupErrors],
      `Acceptance ${description} publication and temporary cleanup both failed.`
    );
  }
  if (operationError) throw operationError;
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, `Acceptance ${description} temporary cleanup failed.`);
  }
}

function isAcceptanceProgressEnvelope(value: unknown): value is AcceptanceProgressEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 4 || keys.join(",") !== "checkpoint,phase,protocol,runId") return false;
  return (
    record.protocol === ACCEPTANCE_PROGRESS_PROTOCOL &&
    typeof record.runId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(record.runId) &&
    typeof record.phase === "string" &&
    /^[a-z][a-z0-9-]{0,63}$/u.test(record.phase) &&
    typeof record.checkpoint === "string" &&
    record.checkpoint.length > 0 &&
    !/[\0\r\n]/u.test(record.checkpoint)
  );
}
