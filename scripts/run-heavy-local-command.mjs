import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createServer, createConnection } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LEASE_TOKEN = "OPEN_WRANGLER_HEAVY_LEASE_TOKEN";
const LEASE_PORT = "OPEN_WRANGLER_HEAVY_LEASE_PORT";
const LEASE_SCOPE = "OPEN_WRANGLER_HEAVY_LEASE_SCOPE";
const LOOPBACK = "127.0.0.1";
const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));

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

function repositoryScope() {
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const repository = typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
  if (typeof manifest.name !== "string" || typeof repository !== "string") {
    throw new Error("The heavy-command guard requires a package name and repository URL.");
  }
  return process.env[LEASE_SCOPE] ?? `${manifest.name}\n${repository}`;
}

function normalizedCommand(command) {
  if (command[0] === "node") return { executable: process.execPath, args: command.slice(1) };
  if (command[0] === "npm" && process.env.npm_execpath) {
    return { executable: process.execPath, args: [process.env.npm_execpath, ...command.slice(1)] };
  }
  return { executable: command[0], args: command.slice(1) };
}

async function verifyInheritedLease(port, token) {
  return await new Promise((resolveVerification) => {
    const socket = createConnection({ host: LOOPBACK, port });
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

async function acquireLease(port, token, label) {
  const server = createServer((socket) => socket.end(token));
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen({ host: LOOPBACK, port, exclusive: true }, resolveListen);
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

async function runChild(command, environment) {
  const resolved = normalizedCommand(command);
  const child = spawn(resolved.executable, resolved.args, {
    cwd: root,
    detached: process.platform !== "win32",
    env: environment,
    stdio: "inherit",
    windowsHide: true
  });
  return await new Promise((resolveChild, rejectChild) => {
    let escalation;
    const forwardSignal = (signal) => {
      signalChildTree(child, signal);
      escalation ??= setTimeout(() => signalChildTree(child, "SIGKILL"), 5_000);
      escalation.unref();
    };
    const onInterrupt = () => forwardSignal("SIGINT");
    const onTerminate = () => forwardSignal("SIGTERM");
    const cleanup = () => {
      if (escalation) clearTimeout(escalation);
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
    };
    child.once("error", (error) => {
      cleanup();
      rejectChild(error);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      resolveChild({ code, signal });
    });
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);
  });
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

export async function runHeavyLocalCommand(argv = process.argv.slice(2)) {
  const { label, command } = parseHeavyCommandArguments(argv);
  const scope = repositoryScope();
  const port = heavyCommandLeasePort(scope);
  const inheritedToken = process.env[LEASE_TOKEN];
  const inheritedPort = Number.parseInt(process.env[LEASE_PORT] ?? "", 10);
  if (
    inheritedToken &&
    /^[0-9a-f-]{36}$/u.test(inheritedToken) &&
    inheritedPort === port &&
    (await verifyInheritedLease(port, inheritedToken))
  ) {
    return await runChild(command, process.env);
  }

  const token = randomUUID();
  const server = await acquireLease(port, token, label);
  try {
    return await runChild(command, {
      ...process.env,
      [LEASE_TOKEN]: token,
      [LEASE_PORT]: String(port)
    });
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
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
