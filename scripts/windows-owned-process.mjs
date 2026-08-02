import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { win32 } from "node:path";
import { Transform } from "node:stream";
import { assertWindowsEditorProcessSupervisorReceipt } from "./editor-acceptance.mjs";

const LAUNCH_FRAME_MAX_BYTES = 256 * 1024;
const CONTROL_FRAME_MAX_BYTES = 1024;
const DIRECT_SPAWN_OPTION_KEYS = new Set(["cwd", "env", "shell", "stdio"]);
const TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const WINDOWS_OWNED_PROCESS_READY_PREFIX = "OPEN_WRANGLER_WINDOWS_JOB_READY:";
export const WINDOWS_OWNED_PROCESS_EMPTY_PREFIX = "OPEN_WRANGLER_WINDOWS_JOB_EMPTY:";

export function spawnArmedWindowsProcess(
  executable,
  args,
  options,
  {
    platform = process.platform,
    spawnProcess = spawn,
    supervisorReceipt,
    assertSupervisorReceipt = assertWindowsEditorProcessSupervisorReceipt,
    token = randomUUID()
  } = {}
) {
  if (platform !== "win32") {
    throw new Error("The armed Windows process supervisor is available only on Windows.");
  }
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== "string")) {
    throw new Error("The armed Windows process arguments must be strings.");
  }
  if (!options || typeof options !== "object") {
    throw new Error("The armed Windows process requires explicit launch options.");
  }
  assertDirectSpawnOptions(options);
  if (typeof executable !== "string" || !win32.isAbsolute(executable)) {
    throw new Error("The armed Windows process executable must be an absolute Windows path.");
  }
  const cwd = options.cwd ?? process.cwd();
  if (typeof cwd !== "string" || !win32.isAbsolute(cwd)) {
    throw new Error("The armed Windows process working directory must be an absolute Windows path.");
  }
  if (typeof token !== "string" || !TOKEN.test(token)) {
    throw new Error("The armed Windows process requires one canonical private token.");
  }

  const environment = Object.fromEntries(
    Object.entries(options.env ?? {}).map(([key, value]) => {
      if (typeof value !== "string") {
        throw new Error(`The armed Windows process environment value ${JSON.stringify(key)} must be a string.`);
      }
      return [key, value];
    })
  );
  const launchFrame = encodeFrame(
    {
      protocol: 2,
      command: "launch-armed",
      executable,
      args,
      cwd,
      environment,
      attestationToken: token
    },
    LAUNCH_FRAME_MAX_BYTES,
    "launch"
  );
  const supervisor = assertSupervisorReceipt(supervisorReceipt);
  const child = spawnProcess(supervisor, [], {
    cwd,
    env: environment,
    detached: false,
    shell: false,
    windowsHide: true,
    stdio: supervisorStdio(options.stdio)
  });
  if (
    !child.stdin ||
    typeof child.stdin.write !== "function" ||
    typeof child.stdin.end !== "function" ||
    typeof child.stdin.destroy !== "function"
  ) {
    throw abandonSupervisor(child, "The armed Windows supervisor did not expose its control lease.");
  }
  if (!child.stderr || typeof child.stderr.pipe !== "function") {
    throw abandonSupervisor(child, "The armed Windows supervisor did not expose its attestation channel.");
  }

  let protocol;
  let controlError;
  let goRequested = false;
  let goWritten = false;
  let terminateRequested = false;
  let leaseRevoked = false;
  let abortPromise;
  let resolveAbortSignal;
  const abortSignal = new Promise((resolve) => {
    resolveAbortSignal = resolve;
  });

  function abort() {
    if (abortPromise) return abortPromise;
    leaseRevoked = true;
    resolveAbortSignal();
    abortPromise = Promise.resolve();
    try {
      child.stdin.destroy();
    } catch {
      try {
        child.kill?.("SIGKILL");
      } catch {
        protocol?.loseVerification();
      }
      protocol?.loseVerification();
    }
    return abortPromise;
  }

  protocol = createArmedStderrProtocol(child.stderr, token, abort);
  child.once("error", () => protocol.loseVerification());
  child.stdin.on("error", (error) => {
    controlError ??= error;
    protocol.loseVerification();
  });
  const launchWritten = writeFrame(child.stdin, launchFrame).catch((error) => {
    controlError ??= error;
    protocol.loseVerification();
    throw error;
  });
  const ready = Promise.all([launchWritten, protocol.ready]).then(() => undefined);
  void ready.catch(() => {});

  async function waitForReadyOrAbort(action) {
    if (leaseRevoked) {
      throw new Error(`The armed Windows process control lease was revoked before ${action}.`);
    }
    await Promise.race([
      ready,
      abortSignal.then(() => {
        throw new Error(`The armed Windows process control lease was revoked before ${action}.`);
      })
    ]);
    if (leaseRevoked) {
      throw new Error(`The armed Windows process control lease was revoked before ${action}.`);
    }
  }

  async function go() {
    if (goRequested || terminateRequested || leaseRevoked) {
      throw new Error("The armed Windows process accepts exactly one GO authorization.");
    }
    goRequested = true;
    await waitForReadyOrAbort("GO");
    if (controlError || protocol.verificationLost() || leaseRevoked) {
      throw new Error("The armed Windows process lost its control lease before GO.");
    }
    try {
      await writeFrame(
        child.stdin,
        encodeFrame({ protocol: 2, command: "go", attestationToken: token }, CONTROL_FRAME_MAX_BYTES, "GO")
      );
      goWritten = true;
    } catch (error) {
      controlError ??= error;
      protocol.loseVerification();
      throw error;
    }
  }

  async function terminate() {
    if (terminateRequested || leaseRevoked || (goRequested && !goWritten)) {
      throw new Error("The armed Windows process accepts at most one termination request.");
    }
    terminateRequested = true;
    await waitForReadyOrAbort("termination");
    if (controlError || protocol.verificationLost() || leaseRevoked) {
      throw new Error("The armed Windows process lost its control lease before termination.");
    }
    try {
      await writeFrame(
        child.stdin,
        encodeFrame(
          { protocol: 2, command: "terminate", attestationToken: token },
          CONTROL_FRAME_MAX_BYTES,
          "termination"
        )
      );
    } catch (error) {
      controlError ??= error;
      protocol.loseVerification();
      throw error;
    }
  }

  return Object.freeze({
    child,
    ready,
    stderr: protocol.output,
    go,
    terminate,
    abort,
    closeLease: abort,
    verifyEmpty: () => protocol.empty
  });
}

function assertDirectSpawnOptions(options) {
  for (const key of Object.keys(options)) {
    if (!DIRECT_SPAWN_OPTION_KEYS.has(key)) {
      throw new Error(`The armed Windows process does not accept the spawn option ${JSON.stringify(key)}.`);
    }
  }
  if (options.shell !== undefined && options.shell !== false) {
    throw new Error("The armed Windows supervisor must be spawned directly with shell disabled.");
  }
}

function encodeFrame(value, maximumBytes, label) {
  const frame = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(frame, "utf8") > maximumBytes) {
    throw new Error(`The armed Windows process ${label} frame exceeds ${maximumBytes} bytes.`);
  }
  return frame;
}

function writeFrame(stream, frame) {
  return new Promise((resolve, reject) => {
    if (!stream.writable) {
      reject(new Error("The armed Windows process control lease is closed."));
      return;
    }
    stream.write(frame, "utf8", (error) => {
      if (error) reject(new Error("The armed Windows process control frame could not be written."));
      else resolve();
    });
  });
}

function supervisorStdio(stdio) {
  if (stdio === undefined || stdio === "pipe") return ["pipe", "pipe", "pipe"];
  if (!Array.isArray(stdio) || (stdio[2] ?? "pipe") !== "pipe") {
    throw new Error("Armed Windows processes require a piped stderr attestation channel.");
  }
  return ["pipe", stdio[1] ?? "pipe", "pipe"];
}

function abandonSupervisor(child, message) {
  for (const stream of new Set([child.stdin, child.stdout, child.stderr])) {
    try {
      stream?.destroy?.();
    } catch {
      // The fixed error below keeps ownership unverified.
    }
  }
  try {
    child.kill?.("SIGKILL");
  } catch {
    // The fixed error below keeps ownership unverified.
  }
  return new Error(message);
}

function createArmedStderrProtocol(stream, token, onVerificationLost) {
  const readyMarker = Buffer.from(`${WINDOWS_OWNED_PROCESS_READY_PREFIX}${token}\n`, "ascii");
  const emptyMarker = Buffer.from(`${WINDOWS_OWNED_PROCESS_EMPTY_PREFIX}${token}\n`, "ascii");
  const retainedSuffix = Math.max(readyMarker.length, emptyMarker.length) - 1;
  let pending = Buffer.alloc(0);
  let readySeen = false;
  let emptySeen = false;
  let lost = false;
  let readySettled = false;
  let emptySettled = false;
  let flushed = false;
  let sourceEnded = false;
  let resolveReady;
  let rejectReady;
  let resolveEmpty;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const empty = new Promise((resolve) => {
    resolveEmpty = resolve;
  });

  function settleEmpty(value) {
    if (emptySettled) return;
    emptySettled = true;
    resolveEmpty(value);
  }

  function loseVerification() {
    if (lost) return;
    lost = true;
    if (!readySettled) {
      readySettled = true;
      rejectReady(new Error("The armed Windows supervisor did not produce one exact READY proof."));
    }
    settleEmpty(false);
    try {
      onVerificationLost();
    } catch {
      // Verification remains permanently lost even if lease revocation faults.
    }
  }

  const output = new Transform({
    transform(chunk, _encoding, callback) {
      try {
        const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const combined = pending.length === 0 ? incoming : Buffer.concat([pending, incoming]);
        let offset = 0;
        while (true) {
          const readyAt = combined.indexOf(readyMarker, offset);
          const emptyAt = combined.indexOf(emptyMarker, offset);
          const nextAt = readyAt < 0 ? emptyAt : emptyAt < 0 ? readyAt : Math.min(readyAt, emptyAt);
          if (nextAt < 0) break;
          if (nextAt > offset) this.push(combined.subarray(offset, nextAt));
          if (nextAt === readyAt) {
            if (readySeen || emptySeen) loseVerification();
            readySeen = true;
            if (!readySettled && !lost) {
              readySettled = true;
              resolveReady();
            }
            offset = nextAt + readyMarker.length;
          } else {
            if (!readySeen || emptySeen) loseVerification();
            emptySeen = true;
            offset = nextAt + emptyMarker.length;
          }
        }
        const remaining = combined.subarray(offset);
        const publishLength = Math.max(0, remaining.length - retainedSuffix);
        if (publishLength > 0) this.push(remaining.subarray(0, publishLength));
        pending = Buffer.from(remaining.subarray(publishLength));
        callback();
      } catch (error) {
        loseVerification();
        callback(error);
      }
    },
    flush(callback) {
      flushed = true;
      if (pending.length > 0) this.push(pending);
      pending = Buffer.alloc(0);
      if (!readySeen) loseVerification();
      settleEmpty(!lost && readySeen && emptySeen);
      callback();
    }
  });
  output.once("error", loseVerification);
  output.once("close", () => {
    if (!flushed) loseVerification();
  });
  stream.once("error", (error) => {
    loseVerification();
    output.destroy(error);
  });
  stream.once("end", () => {
    sourceEnded = true;
  });
  stream.once("close", () => {
    if (!sourceEnded) {
      loseVerification();
      if (!output.destroyed) output.destroy();
    }
  });
  stream.pipe(output);
  return {
    ready,
    empty,
    output,
    loseVerification,
    verificationLost: () => lost
  };
}
