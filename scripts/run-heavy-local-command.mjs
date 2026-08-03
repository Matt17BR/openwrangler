import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createServer, createConnection } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createProcessTreeMemorySampler,
  formatMemoryBytes,
  resolveHeavyMemoryPolicy
} from "./heavy-process-memory.mjs";

const LEASE_TOKEN = "OPEN_WRANGLER_HEAVY_LEASE_TOKEN";
const LEASE_ADDRESS = "OPEN_WRANGLER_HEAVY_LEASE_ADDRESS";
const LEASE_SCOPE = "OPEN_WRANGLER_HEAVY_LEASE_SCOPE";
const LINUX_CLEANUP_LEASE_TOKEN = "OPEN_WRANGLER_HEAVY_CLEANUP_LEASE_TOKEN";
const LOOPBACK = "127.0.0.1";
const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\openwrangler-heavy-";
const LEASE_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MEMORY_POLL_MS = 250;
const NORMAL_TREE_DRAIN_MS = 500;
const SUPERVISOR_READY_MS = 2_000;
const TERMINATION_GRACE_MS = 2_000;
const KILL_GRACE_MS = 3_000;
const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const linuxSupervisor = resolve(root, "scripts", "linux-process-tree-supervisor.py");

export function parseHeavyCommandArguments(argv) {
  const separator = argv.indexOf("--");
  const label = separator === 1 ? argv[0]?.trim() : undefined;
  const command = separator >= 0 ? argv.slice(separator + 1) : [];
  if (!label || command.length === 0 || command.some((value) => typeof value !== "string" || value.length === 0)) {
    throw new Error("Usage: node scripts/run-heavy-local-command.mjs <label> -- <command> [arguments...]");
  }
  return { label, command };
}

export function heavyCommandLeasePort(scope) {
  const digest = createHash("sha256").update(scope).digest();
  return 45_000 + (digest.readUInt16BE(0) % 10_000);
}

export function heavyCommandLinuxCleanupLeasePort(scope) {
  const digest = createHash("sha256").update(`linux-cleanup-v1\0${scope}`).digest();
  return 35_000 + (digest.readUInt16BE(0) % 10_000);
}

export function heavyCommandLeaseEndpoint(scope, platform = process.platform) {
  if (platform === "win32") {
    return { path: `${WINDOWS_PIPE_PREFIX}${createHash("sha256").update(scope).digest("hex")}` };
  }
  return { host: LOOPBACK, port: heavyCommandLeasePort(scope) };
}

function leaseAddress(endpoint) {
  return "path" in endpoint ? `pipe:${endpoint.path}` : `tcp:${endpoint.host}:${endpoint.port}`;
}

function repositoryScope(environment = process.env) {
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const repository = typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
  if (typeof manifest.name !== "string" || typeof repository !== "string") {
    throw new Error("The heavy-command guard requires a package name and repository URL.");
  }
  return environment[LEASE_SCOPE] ?? `${manifest.name}\n${repository}`;
}

function normalizedCommand(command) {
  if (command[0] === "node") return { executable: process.execPath, args: command.slice(1) };
  if (command[0] === "npm" && process.env.npm_execpath) {
    return { executable: process.execPath, args: [process.env.npm_execpath, ...command.slice(1)] };
  }
  return { executable: command[0], args: command.slice(1) };
}

async function verifyInheritedLease(endpoint, token) {
  return await new Promise((resolveVerification) => {
    const socket = createConnection(endpoint);
    let response = "";
    const timer = setTimeout(() => socket.destroy(), 1_000);
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      response = `${response}${chunk}`.slice(-256);
    });
    socket.once("error", () => resolveVerification(false));
    socket.once("close", () => {
      clearTimeout(timer);
      resolveVerification(response === token);
    });
  });
}

async function acquireLease(endpoint, token, label) {
  const server = createServer((socket) => socket.end(token));
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen({ ...endpoint, exclusive: true }, resolveListen);
  }).catch((error) => {
    if (error?.code === "EADDRINUSE") {
      throw new Error(
        `Another Open Wrangler memory-intensive command is already running. Wait for it to finish before starting "${label}".`
      );
    }
    throw error;
  });
  return server;
}

async function assertLinuxCleanupLeaseAvailable(scope, label) {
  const endpoint = { host: LOOPBACK, port: heavyCommandLinuxCleanupLeasePort(scope) };
  const probe = createServer();
  try {
    await new Promise((resolveListen, rejectListen) => {
      probe.once("error", rejectListen);
      probe.listen({ ...endpoint, exclusive: true }, resolveListen);
    });
  } catch (error) {
    if (error?.code !== "EADDRINUSE") throw error;
    const token = await readLinuxCleanupLeaseToken(endpoint);
    if (token && LEASE_TOKEN_PATTERN.test(token)) {
      throw new Error(
        `A previous Open Wrangler Linux process tree is still draining. Wait for it to stop before starting "${label}".`
      );
    }
    throw new Error(
      `The Open Wrangler Linux cleanup lease is occupied but could not be verified. Refusing to start "${label}".`
    );
  } finally {
    if (probe.listening) await new Promise((resolveClose) => probe.close(resolveClose));
  }
  return endpoint.port;
}

async function readLinuxCleanupLeaseToken(endpoint) {
  return await new Promise((resolveToken) => {
    const socket = createConnection(endpoint);
    let response = "";
    const timer = setTimeout(() => socket.destroy(), 1_000);
    timer.unref();
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      response = `${response}${chunk}`.slice(-256);
    });
    socket.once("error", () => resolveToken(undefined));
    socket.once("close", () => {
      clearTimeout(timer);
      resolveToken(response);
    });
  });
}

function spawnGuardedCommand(resolved, environment, useLinuxSupervisor, linuxCleanupLeasePort) {
  if (useLinuxSupervisor) {
    return spawn(
      "python3",
      [linuxSupervisor, String(process.pid), String(linuxCleanupLeasePort), resolved.executable, ...resolved.args],
      {
        cwd: root,
        detached: true,
        env: environment,
        stdio: ["inherit", "inherit", "inherit", "pipe", "pipe"],
        windowsHide: true
      }
    );
  }
  return spawn(resolved.executable, resolved.args, {
    cwd: root,
    detached: process.platform !== "win32",
    env: environment,
    stdio: "inherit",
    windowsHide: true
  });
}

function createLinuxSupervisorProtocol(child) {
  const control = child.stdio?.[3];
  const report = child.stdio?.[4];
  if (!control || typeof control.write !== "function" || !report || typeof report.on !== "function") {
    throw new Error("The Linux process supervisor did not expose its private launch barrier.");
  }
  const ready = deferred();
  const targetOutcome = deferred();
  let buffered = "";
  let readySeen = false;
  let targetSeen = false;
  let goWritten = false;
  let failed = false;

  function fail(message) {
    if (failed) return;
    failed = true;
    const error = message instanceof Error ? message : new Error(message);
    ready.resolve({ kind: "error", error });
    targetOutcome.resolve({ kind: "error", error });
  }

  function acceptLine(line) {
    if (!readySeen && line === "READY") {
      readySeen = true;
      ready.resolve({ kind: "ready" });
      return;
    }
    const match = /^TARGET (?:(\d{1,3}) -|- (SIG[A-Z0-9]+))$/u.exec(line);
    if (readySeen && !targetSeen && match) {
      const code = match[1] === undefined ? null : Number(match[1]);
      if (code !== null && code > 255) {
        fail("The Linux process supervisor reported an invalid target exit code.");
        return;
      }
      targetSeen = true;
      targetOutcome.resolve({ kind: "exit", code, signal: match[2] ?? null });
      return;
    }
    fail("The Linux process supervisor emitted a malformed or out-of-order control frame.");
  }

  report.setEncoding("utf8");
  report.on("data", (chunk) => {
    if (failed) return;
    buffered = `${buffered}${chunk}`;
    if (Buffer.byteLength(buffered, "utf8") > 1_024) {
      fail("The Linux process supervisor exceeded its bounded control output.");
      return;
    }
    while (buffered.includes("\n")) {
      const newline = buffered.indexOf("\n");
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      acceptLine(line);
      if (failed) return;
    }
  });
  report.once("error", (error) =>
    fail(new Error("The Linux process supervisor control pipe failed.", { cause: error }))
  );
  report.once("close", () => {
    if (buffered.length !== 0 || !targetSeen) {
      fail("The Linux process supervisor closed before reporting the target outcome.");
    }
  });
  control.once("error", (error) =>
    fail(new Error("The Linux process supervisor launch barrier failed.", { cause: error }))
  );

  return Object.freeze({
    ready: ready.promise,
    targetOutcome: targetOutcome.promise,
    async go() {
      if (!readySeen || goWritten || failed) {
        throw new Error("The Linux process supervisor was not ready for launch authorization.");
      }
      await new Promise((resolveWrite, rejectWrite) => {
        control.write("GO\n", "ascii", (error) => {
          if (error) rejectWrite(new Error("The Linux process supervisor GO frame could not be written."));
          else {
            goWritten = true;
            resolveWrite();
          }
        });
      });
    },
    close() {
      control.destroy();
      report.destroy();
    }
  });
}

async function runChild(command, environment, { label, memoryPolicy, linuxCleanupLeasePort }) {
  const resolved = normalizedCommand(command);
  const useLinuxSupervisor = process.platform === "linux" && memoryPolicy.enabled;
  if (useLinuxSupervisor && !Number.isSafeInteger(linuxCleanupLeasePort)) {
    throw new Error("The Linux process supervisor requires one prepared cleanup lease.");
  }
  const child = spawnGuardedCommand(resolved, environment, useLinuxSupervisor, linuxCleanupLeasePort);
  const childOutcome = new Promise((resolveChild) => {
    child.once("error", (error) => resolveChild({ kind: "error", error }));
    child.once("close", (code, signal) => resolveChild({ kind: "exit", code, signal }));
  });
  let supervisorProtocol;
  const signalRequest = deferred();
  const onInterrupt = () => signalRequest.resolve("SIGINT");
  const onTerminate = () => signalRequest.resolve("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  const monitorAbort = new AbortController();
  const memoryObservation = { peakBytes: 0, processCount: 0 };
  let sampler;
  try {
    if (memoryPolicy.enabled) {
      if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
        const outcome = await childOutcome;
        if (outcome.kind === "error") throw outcome.error;
        return { code: outcome.code, signal: outcome.signal };
      }
      try {
        if (useLinuxSupervisor) {
          supervisorProtocol = createLinuxSupervisorProtocol(child);
          const readiness = await Promise.race([
            supervisorProtocol.ready,
            childOutcome.then((outcome) =>
              outcome.kind === "error"
                ? outcome
                : {
                    kind: "error",
                    error: new Error("The Linux process supervisor exited before its launch barrier was armed.")
                  }
            ),
            new Promise((resolveReady) => {
              const timer = setTimeout(
                () =>
                  resolveReady({
                    kind: "error",
                    error: new Error("The Linux process supervisor launch barrier timed out.")
                  }),
                SUPERVISOR_READY_MS
              );
              timer.unref();
            })
          ]);
          if (readiness.kind === "error") throw readiness.error;
        }
        sampler = createProcessTreeMemorySampler(child.pid);
        if (useLinuxSupervisor) await supervisorProtocol.go();
      } catch (error) {
        let terminationError;
        try {
          await terminateChildTree(child, undefined, "SIGKILL");
        } catch (failure) {
          terminationError = failure;
        }
        const setupError = new Error(
          `Open Wrangler stopped "${label}" because process-tree memory accounting could not start.`,
          { cause: error }
        );
        if (terminationError) {
          throw new AggregateError(
            [setupError, terminationError],
            `${setupError.message} Owned-tree cleanup also failed: ${terminationError.message}`
          );
        }
        throw setupError;
      }
      process.stderr.write(
        `Open Wrangler memory guard: ${formatMemoryBytes(memoryPolicy.bytes)} ${sampler.metric.label} cap for "${label}".\n`
      );
    }
    const monitorOutcome = sampler
      ? monitorProcessTreeMemory(sampler, memoryPolicy, memoryObservation, monitorAbort.signal).then(
          (sample) => ({ kind: "memory-limit", sample }),
          (error) => ({ kind: "monitor-error", error })
        )
      : new Promise(() => {});
    const commandOutcome = useLinuxSupervisor ? supervisorProtocol.targetOutcome : childOutcome;
    const supervisorExit = useLinuxSupervisor
      ? childOutcome.then((outcome) =>
          outcome.kind === "error"
            ? outcome
            : {
                kind: "supervisor-exit",
                outcome
              }
        )
      : new Promise(() => {});
    const winner = await Promise.race([
      commandOutcome,
      supervisorExit,
      monitorOutcome,
      signalRequest.promise.then((signal) => ({ kind: "parent-signal", signal }))
    ]);
    if (winner.kind === "exit") {
      monitorAbort.abort();
      const treeReleased = useLinuxSupervisor
        ? await waitForChildExit(child, NORMAL_TREE_DRAIN_MS)
        : !sampler || (await waitForOwnedTreeExit(child.pid, sampler, NORMAL_TREE_DRAIN_MS));
      if (!treeReleased) {
        let terminationError;
        try {
          await terminateChildTree(child, sampler, "SIGTERM", { preserveRoot: useLinuxSupervisor });
        } catch (error) {
          terminationError = error;
        }
        if (useLinuxSupervisor) await boundedChildOutcome(child, childOutcome, KILL_GRACE_MS);
        const orphanError = new Error(
          `Open Wrangler stopped a surviving descendant after "${label}" exited; heavy commands may not leave background processes.`
        );
        if (terminationError) {
          throw new AggregateError(
            [orphanError, terminationError],
            `${orphanError.message} Owned-tree cleanup also failed: ${terminationError.message}`
          );
        }
        throw orphanError;
      }
      if (useLinuxSupervisor) {
        const supervisorOutcome = await boundedChildOutcome(child, childOutcome, KILL_GRACE_MS);
        validateLinuxSupervisorOutcome(winner, supervisorOutcome);
      }
      writeCompletedMemoryObservation(label, sampler, memoryPolicy, memoryObservation);
      return { code: winner.code, signal: winner.signal };
    }
    if (winner.kind === "supervisor-exit") {
      throw new Error("The Linux process supervisor exited without reporting the target outcome.");
    }
    if (winner.kind === "error") {
      monitorAbort.abort();
      let terminationError;
      try {
        await terminateChildTree(child, sampler, "SIGKILL", { preserveRoot: useLinuxSupervisor });
      } catch (error) {
        terminationError = error;
      }
      if (terminationError) {
        throw new AggregateError(
          [winner.error, terminationError],
          `${winner.error.message} Owned-tree cleanup also failed: ${terminationError.message}`
        );
      }
      throw winner.error;
    }

    monitorAbort.abort();
    const terminationSignal = winner.kind === "parent-signal" ? winner.signal : "SIGTERM";
    let terminationError;
    try {
      await terminateChildTree(child, sampler, terminationSignal, { preserveRoot: useLinuxSupervisor });
    } catch (error) {
      terminationError = error;
    }
    const outcome = await boundedChildOutcome(child, childOutcome, KILL_GRACE_MS);
    if (winner.kind === "memory-limit") {
      const message =
        `Open Wrangler stopped "${label}" after its ${winner.sample.processCount}-process tree reached ` +
        `${formatMemoryBytes(winner.sample.bytes)} ${winner.sample.metric.label}, above the ` +
        `${formatMemoryBytes(memoryPolicy.bytes)} local cap. Peak observed: ${formatMemoryBytes(winner.sample.peakBytes)}. ` +
        "Raise OPEN_WRANGLER_HEAVY_MEMORY_LIMIT_MB only when the machine has safe headroom, or set it to off explicitly.";
      const limitError = new Error(message);
      if (terminationError) {
        throw new AggregateError(
          [limitError, terminationError],
          `${message} Owned-tree cleanup also failed: ${terminationError.message}`
        );
      }
      throw limitError;
    }
    if (winner.kind === "monitor-error") {
      const monitorError = new Error(
        `Open Wrangler stopped "${label}" because process-tree memory accounting failed; the cap was not silently bypassed.`,
        { cause: winner.error }
      );
      if (terminationError) {
        throw new AggregateError(
          [monitorError, terminationError],
          `${monitorError.message} Owned-tree cleanup also failed: ${terminationError.message}`
        );
      }
      throw monitorError;
    }
    if (terminationError) throw terminationError;
    if (outcome.kind === "error") throw outcome.error;
    return { code: outcome.code, signal: outcome.signal };
  } finally {
    monitorAbort.abort();
    supervisorProtocol?.close();
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
}

async function boundedChildOutcome(child, childOutcome, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return await childOutcome;
  return await Promise.race([
    childOutcome,
    new Promise((resolveOutcome) => {
      const timer = setTimeout(
        () =>
          resolveOutcome({ kind: "error", error: new Error("The guarded child did not settle after termination.") }),
        timeoutMs
      );
      timer.unref();
    })
  ]);
}

function validateLinuxSupervisorOutcome(targetOutcome, supervisorOutcome) {
  if (supervisorOutcome.kind === "error") throw supervisorOutcome.error;
  if (supervisorOutcome.code !== targetOutcome.code || supervisorOutcome.signal !== targetOutcome.signal) {
    throw new Error("The Linux process supervisor did not preserve the target command's exit outcome.");
  }
}

function deferred() {
  let settled = false;
  let resolvePromise;
  const promise = new Promise((resolveDeferred) => {
    resolvePromise = resolveDeferred;
  });
  return {
    promise,
    resolve(value) {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    }
  };
}

function writeCompletedMemoryObservation(label, sampler, memoryPolicy, observation) {
  if (!sampler || observation.processCount === 0) return;
  process.stderr.write(
    `Open Wrangler memory guard: "${label}" peak ${formatMemoryBytes(observation.peakBytes)} ` +
      `${sampler.metric.label} across ${observation.processCount} process${observation.processCount === 1 ? "" : "es"} ` +
      `(cap ${formatMemoryBytes(memoryPolicy.bytes)}).\n`
  );
}

async function monitorProcessTreeMemory(sampler, memoryPolicy, observation, signal) {
  while (!signal.aborted) {
    const sample = await sampler.sample();
    observation.peakBytes = Math.max(observation.peakBytes, sample.bytes);
    observation.processCount = Math.max(observation.processCount, sample.processCount);
    if (sample.bytes > memoryPolicy.bytes) {
      return Object.freeze({ ...sample, peakBytes: observation.peakBytes });
    }
    await abortableDelay(MEMORY_POLL_MS, signal);
  }
  return await new Promise(() => {});
}

function abortableDelay(milliseconds, signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolveDelay) => {
    const timer = setTimeout(finish, milliseconds);
    timer.unref();
    signal.addEventListener("abort", finish, { once: true });
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolveDelay();
    }
  });
}

export async function terminateChildTree(
  child,
  sampler,
  firstSignal,
  {
    preserveRoot = false,
    platform = process.platform,
    taskkill = runWindowsTaskKill,
    waitForChild = waitForChildExit
  } = {}
) {
  if (!child.pid) return;
  if (platform === "win32") {
    await taskkill(child.pid);
    if (await waitForChild(child, KILL_GRACE_MS)) return;
    throw new Error(`The guarded Windows root process PID ${child.pid} remained after taskkill.`);
  }

  if (sampler) await sampler.signal(firstSignal, { includeRoot: !preserveRoot });
  else signalChildTree(child, firstSignal);
  if (await waitForOwnedTreeExit(child.pid, sampler, TERMINATION_GRACE_MS)) return;
  if (sampler) await sampler.signal("SIGKILL", { includeRoot: !preserveRoot });
  else signalChildTree(child, "SIGKILL");
  if (await waitForOwnedTreeExit(child.pid, sampler, KILL_GRACE_MS)) return;
  throw new Error(`The guarded process tree rooted at PID ${child.pid} remained after SIGKILL.`);
}

async function waitForOwnedTreeExit(rootPid, sampler, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (sampler) {
      if ((await sampler.active()).length === 0) return true;
    } else if (!processGroupIsAlive(rootPid)) {
      return true;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  return false;
}

function processGroupIsAlive(rootPid) {
  try {
    process.kill(-rootPid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveWait) => {
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    child.once("exit", () => finish(true));
    function finish(result) {
      clearTimeout(timer);
      resolveWait(result);
    }
  });
}

async function runWindowsTaskKill(pid) {
  const taskkill = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true
  });
  const outcome = await new Promise((resolveTaskkill) => {
    taskkill.once("error", (error) => resolveTaskkill({ error }));
    taskkill.once("exit", (code) => resolveTaskkill({ code }));
  });
  if (outcome.error) throw new Error("Windows taskkill could not start.", { cause: outcome.error });
  if (outcome.code !== 0 && outcome.code !== 128) {
    throw new Error(`Windows taskkill exited with code ${outcome.code}.`);
  }
}

function signalChildTree(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(process.platform === "win32" ? child.pid : -child.pid, signal);
  } catch (error) {
    if (error?.code === "ESRCH") return;
    try {
      child.kill(signal);
    } catch {
      // The child may have exited between the process-group and direct attempts.
    }
  }
}

export async function withHeavyLocalCommandLease(
  label,
  callback,
  {
    environment = process.env,
    scope = repositoryScope(environment),
    platform = process.platform,
    tokenFactory = randomUUID
  } = {}
) {
  if (typeof label !== "string" || label.trim().length === 0 || typeof callback !== "function") {
    throw new TypeError("A heavy-command lease requires one label and callback.");
  }
  const endpoint = heavyCommandLeaseEndpoint(scope, platform);
  const address = leaseAddress(endpoint);
  const inheritedToken = environment[LEASE_TOKEN];
  if (
    inheritedToken &&
    LEASE_TOKEN_PATTERN.test(inheritedToken) &&
    environment[LEASE_ADDRESS] === address &&
    (await verifyInheritedLease(endpoint, inheritedToken))
  ) {
    return await callback(environment, { inherited: true, scope });
  }

  const token = tokenFactory();
  if (typeof token !== "string" || !LEASE_TOKEN_PATTERN.test(token)) {
    throw new TypeError("A heavy-command lease token must be one UUID.");
  }
  const server = await acquireLease(endpoint, token, label);
  try {
    return await callback(
      {
        ...environment,
        [LEASE_TOKEN]: token,
        [LEASE_ADDRESS]: address
      },
      { inherited: false, scope }
    );
  } finally {
    await new Promise((resolveClose, rejectClose) => {
      server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
    });
  }
}

export async function runHeavyLocalCommand(argv = process.argv.slice(2)) {
  const { label, command } = parseHeavyCommandArguments(argv);
  return await withHeavyLocalCommandLease(label, async (environment, { inherited, scope }) => {
    if (inherited) {
      return await runChild(command, environment, {
        label,
        memoryPolicy: Object.freeze({ enabled: false, source: "inherited-lease" })
      });
    }
    const memoryPolicy = resolveHeavyMemoryPolicy({ environment });
    const linuxCleanupLeasePort =
      process.platform === "linux" && memoryPolicy.enabled
        ? await assertLinuxCleanupLeaseAvailable(scope, label)
        : undefined;
    return await runChild(
      command,
      {
        ...environment,
        ...(linuxCleanupLeasePort === undefined ? {} : { [LINUX_CLEANUP_LEASE_TOKEN]: randomUUID() })
      },
      { label, memoryPolicy, linuxCleanupLeasePort }
    );
  });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runHeavyLocalCommand()
    .then(({ code, signal }) => {
      if (signal) {
        process.stderr.write(`Open Wrangler heavy command ended after signal ${signal}.\n`);
        process.exitCode = 1;
      } else {
        process.exitCode = code ?? 1;
      }
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
