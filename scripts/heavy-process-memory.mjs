import { execFile, execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { totalmem } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MIB = 1024 * 1024;
const DEFAULT_FRACTION = 0.25;
const DEFAULT_MINIMUM_MIB = 256;
const DEFAULT_MAXIMUM_MIB = 8192;
const MAXIMUM_EXPLICIT_MIB = 131_072;
export const HEAVY_MEMORY_LIMIT = "OPEN_WRANGLER_HEAVY_MEMORY_LIMIT_MB";

export function resolveHeavyMemoryPolicy({
  environment = process.env,
  platform = process.platform,
  totalMemoryBytes = totalmem(),
  constrainedMemoryBytes = process.constrainedMemory?.(),
  availableMemoryBytes = process.availableMemory?.()
} = {}) {
  const configured = environment[HEAVY_MEMORY_LIMIT];
  if (configured === "off") {
    return Object.freeze({ enabled: false, source: "explicit-off" });
  }
  if (configured !== undefined) {
    if (!/^[1-9][0-9]*$/u.test(configured)) {
      throw new Error(`${HEAVY_MEMORY_LIMIT} must be a whole number of MiB or "off".`);
    }
    const mebibytes = Number(configured);
    if (!Number.isSafeInteger(mebibytes) || mebibytes > MAXIMUM_EXPLICIT_MIB) {
      throw new Error(`${HEAVY_MEMORY_LIMIT} must be between 1 and ${MAXIMUM_EXPLICIT_MIB} MiB.`);
    }
    assertSupportedPlatform(platform);
    return Object.freeze({ enabled: true, bytes: mebibytes * MIB, mebibytes, source: "explicit" });
  }

  if (isContinuousIntegration(environment)) {
    return Object.freeze({ enabled: false, source: "continuous-integration" });
  }
  if (platform !== "linux" && platform !== "darwin") {
    return Object.freeze({ enabled: false, source: "unsupported-local-platform" });
  }
  if (!Number.isSafeInteger(totalMemoryBytes) || totalMemoryBytes <= 0) {
    throw new Error("The local heavy-command memory guard could not determine physical memory safely.");
  }
  const effectiveMemoryBytes = [totalMemoryBytes, constrainedMemoryBytes, availableMemoryBytes]
    .filter((value) => Number.isSafeInteger(value) && value > 0)
    .reduce((minimum, value) => Math.min(minimum, value), totalMemoryBytes);
  const physicalMebibytes = Math.floor(effectiveMemoryBytes / MIB);
  const mebibytes = Math.max(
    DEFAULT_MINIMUM_MIB,
    Math.min(DEFAULT_MAXIMUM_MIB, Math.floor(physicalMebibytes * DEFAULT_FRACTION))
  );
  return Object.freeze({ enabled: true, bytes: mebibytes * MIB, mebibytes, source: "local-default" });
}

function isContinuousIntegration(environment) {
  return [environment.CI, environment.GITHUB_ACTIONS, environment.TF_BUILD].some(
    (value) => typeof value === "string" && /^(?:1|true)$/iu.test(value)
  );
}

function assertSupportedPlatform(platform) {
  if (platform === "linux" || platform === "darwin") return;
  throw new Error(
    `${HEAVY_MEMORY_LIMIT} is supported only on Linux and macOS. ` +
      "Windows needs an externally enforced Job Object or container limit; the wrapper will not claim a limit it cannot enforce."
  );
}

export function parseLinuxProcessStat(contents) {
  if (typeof contents !== "string") throw new Error("Linux process stat contents must be text.");
  const open = contents.indexOf("(");
  const close = contents.lastIndexOf(")");
  if (open <= 0 || close <= open) throw new Error("Linux process stat is malformed.");
  const pid = Number(contents.slice(0, open).trim());
  const fields = contents
    .slice(close + 1)
    .trim()
    .split(/\s+/u);
  const state = fields[0];
  const ppid = Number(fields[1]);
  const pgid = Number(fields[2]);
  const start = fields[19];
  if (
    !/^[A-Za-z]$/u.test(state) ||
    ![pid, ppid, pgid].every(Number.isSafeInteger) ||
    pid <= 0 ||
    ppid < 0 ||
    pgid < 0 ||
    !/^\d+$/u.test(start)
  ) {
    throw new Error("Linux process stat is malformed.");
  }
  return Object.freeze({ pid, ppid, pgid, state, identity: `${pid}:${start}` });
}

export function parseMacProcessRows(contents) {
  if (typeof contents !== "string") throw new Error("macOS process rows must be text.");
  const rows = [];
  for (const line of contents.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(line);
    if (!match) throw new Error("macOS process accounting returned a malformed row.");
    const [, pidText, ppidText, pgidText, rssText, started] = match;
    const pid = Number(pidText);
    const ppid = Number(ppidText);
    const pgid = Number(pgidText);
    const rssKibibytes = Number(rssText);
    if (
      ![pid, ppid, pgid, rssKibibytes].every(Number.isSafeInteger) ||
      pid <= 0 ||
      ppid < 0 ||
      pgid < 0 ||
      rssKibibytes < 0 ||
      started.length === 0 ||
      started.length > 128
    ) {
      throw new Error("macOS process accounting returned an invalid row.");
    }
    rows.push(
      Object.freeze({
        pid,
        ppid,
        pgid,
        identity: `${pid}:${started}`,
        memoryBytes: rssKibibytes * 1024
      })
    );
  }
  return rows;
}

export function collectOwnedProcessRows(
  rows,
  rootPid,
  capturedIdentities = new Map(),
  { processGroupVerified = false } = {}
) {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) throw new Error("A process-tree root PID is required.");
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const selected = new Map();
  const root = byPid.get(rootPid);
  const capturedRootIdentity = capturedIdentities.get(rootPid);
  const rootIdentityMatches = !root || capturedRootIdentity === undefined || capturedRootIdentity === root.identity;
  const capturedGroupMemberPresent = rows.some(
    (row) => row.pgid === rootPid && capturedIdentities.get(row.pid) === row.identity
  );
  const processGroupIdentityWitnessed =
    processGroupVerified && rootIdentityMatches && (root !== undefined || capturedGroupMemberPresent);
  if (root && rootIdentityMatches) selected.set(root.pid, root);
  for (const row of rows) {
    if ((processGroupIdentityWitnessed && row.pgid === rootPid) || capturedIdentities.get(row.pid) === row.identity) {
      selected.set(row.pid, row);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!selected.has(row.pid) && selected.has(row.ppid)) {
        selected.set(row.pid, row);
        changed = true;
      }
    }
  }
  for (const row of selected.values()) capturedIdentities.set(row.pid, row.identity);
  return [...selected.values()].sort((left, right) => left.pid - right.pid);
}

export function createProcessTreeMemorySampler(rootPid, { platform = process.platform } = {}) {
  assertSupportedPlatform(platform);
  if (platform === "linux") return createLinuxSampler(rootPid);
  return createMacSampler(rootPid);
}

function createLinuxSampler(rootPid) {
  const capturedIdentities = new Map();
  const metric = detectLinuxMemoryMetric();
  const initialRoot = readLinuxProcessRow(rootPid);
  if (initialRoot.pgid !== rootPid) {
    throw new Error(`The guarded process PID ${rootPid} did not own its expected process group.`);
  }
  capturedIdentities.set(rootPid, initialRoot.identity);
  const selector = createOwnedProcessSelector(rootPid, capturedIdentities, {
    processGroupVerified: true
  });

  function processRows() {
    const rows = [];
    for (const entry of readdirSync("/proc", { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[1-9][0-9]*$/u.test(entry.name)) continue;
      try {
        rows.push(parseLinuxProcessStat(readFileSync(`/proc/${entry.name}/stat`, "utf8")));
      } catch (error) {
        if (error?.code === "ENOENT" || error?.code === "ESRCH") continue;
        throw new Error(`The Linux process-tree accounting scan failed for PID ${entry.name}.`, { cause: error });
      }
    }
    return rows;
  }

  function ownedRows() {
    return selector.select(processRows());
  }

  return samplerFromRows(
    rootPid,
    capturedIdentities,
    metric,
    ownedRows,
    (row) => {
      if (row.state === "Z" || row.state === "X") return 0;
      const path = metric.kind === "pss" ? `/proc/${row.pid}/smaps_rollup` : `/proc/${row.pid}/status`;
      try {
        return parseLinuxMemoryBytes(readFileSync(path, "utf8"), metric.kind);
      } catch (error) {
        if (linuxProcessIdentityStillMatches(row)) {
          throw new Error(`Memory accounting failed for live Open Wrangler child PID ${row.pid}.`, { cause: error });
        }
        return 0;
      }
    },
    linuxProcessIdentityStillMatches
  );
}

function detectLinuxMemoryMetric() {
  try {
    parseLinuxMemoryBytes(readFileSync("/proc/self/smaps_rollup", "utf8"), "pss");
    return Object.freeze({ kind: "pss", label: "proportional set size (PSS)" });
  } catch (error) {
    try {
      parseLinuxMemoryBytes(readFileSync("/proc/self/status", "utf8"), "rss");
      return Object.freeze({ kind: "rss", label: "resident set size (RSS; PSS is unavailable)" });
    } catch {
      throw new Error("Linux exposes neither readable PSS nor RSS process accounting.", { cause: error });
    }
  }
}

function parseLinuxMemoryBytes(contents, kind) {
  const field = kind === "pss" ? "Pss" : "VmRSS";
  const match = new RegExp(`^${field}:\\s+([0-9]+)\\s+kB$`, "mu").exec(contents);
  if (!match) throw new Error(`Linux ${field} accounting is missing.`);
  const kibibytes = Number(match[1]);
  if (!Number.isSafeInteger(kibibytes) || kibibytes < 0) throw new Error(`Linux ${field} accounting is invalid.`);
  return kibibytes * 1024;
}

function linuxProcessIdentityStillMatches(row) {
  try {
    return readLinuxProcessRow(row.pid).identity === row.identity;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ESRCH") return false;
    throw error;
  }
}

function readLinuxProcessRow(pid) {
  return parseLinuxProcessStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
}

function createMacSampler(rootPid) {
  const capturedIdentities = new Map();
  const metric = Object.freeze({ kind: "rss", label: "resident set size (RSS)" });
  const initialRows = parseMacProcessRows(
    execFileSync("/bin/ps", ["-p", String(rootPid), "-o", "pid=,ppid=,pgid=,rss=,lstart="], {
      encoding: "utf8",
      maxBuffer: 4 * 1024,
      timeout: 2_000,
      windowsHide: true
    })
  );
  const initialRoot = initialRows.length === 1 && initialRows[0].pid === rootPid ? initialRows[0] : undefined;
  if (!initialRoot || initialRoot.pgid !== rootPid) {
    throw new Error(`The guarded process PID ${rootPid} did not own its expected process group.`);
  }
  capturedIdentities.set(rootPid, initialRoot.identity);
  const selector = createOwnedProcessSelector(rootPid, capturedIdentities, {
    processGroupVerified: true
  });
  async function ownedRows() {
    const { stdout } = await execFileAsync("/bin/ps", ["-axo", "pid=,ppid=,pgid=,rss=,lstart="], {
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      timeout: 2_000,
      windowsHide: true
    });
    return selector.select(parseMacProcessRows(stdout));
  }
  return samplerFromRows(
    rootPid,
    capturedIdentities,
    metric,
    ownedRows,
    (row) => row.memoryBytes,
    macProcessIdentityStillMatches
  );
}

function macProcessIdentityStillMatches(row) {
  let stdout;
  try {
    stdout = execFileSync("/bin/ps", ["-p", String(row.pid), "-o", "pid=,ppid=,pgid=,rss=,lstart="], {
      encoding: "utf8",
      maxBuffer: 4 * 1024,
      timeout: 2_000,
      windowsHide: true
    });
  } catch (error) {
    if (error?.status === 1 || error?.code === "ESRCH") return false;
    throw new Error(`macOS process identity revalidation failed for PID ${row.pid}.`, { cause: error });
  }
  const currentRows = parseMacProcessRows(stdout);
  return currentRows.length === 1 && currentRows[0].pid === row.pid && currentRows[0].identity === row.identity;
}

function createOwnedProcessSelector(
  rootPid,
  capturedIdentities,
  { processGroupVerified: initiallyVerified = false } = {}
) {
  let processGroupVerified = initiallyVerified;
  return {
    get processGroupVerified() {
      return processGroupVerified;
    },
    select(rows) {
      const root = rows.find((row) => row.pid === rootPid);
      if (root) {
        const capturedRootIdentity = capturedIdentities.get(rootPid);
        if (capturedRootIdentity !== undefined && capturedRootIdentity !== root.identity) {
          throw new Error(`The guarded process PID ${rootPid} changed identity during process-tree accounting.`);
        }
        if (root.pgid !== rootPid) {
          throw new Error(`The guarded process PID ${rootPid} did not own its expected process group.`);
        }
        processGroupVerified = true;
      }
      return collectOwnedProcessRows(rows, rootPid, capturedIdentities, { processGroupVerified });
    }
  };
}

export function signalIdentityCheckedProcessRows(
  selected,
  signal,
  { rootPid, includeRoot = true, currentPid = process.pid, identityStillMatches, killProcess = process.kill } = {}
) {
  if (typeof identityStillMatches !== "function" || typeof killProcess !== "function") {
    throw new Error("Process signaling requires identity verification and a signal primitive.");
  }
  for (const row of selected) {
    if (row.pid === currentPid || (!includeRoot && row.pid === rootPid)) continue;
    const identityMatches = identityStillMatches(row);
    if (typeof identityMatches !== "boolean") {
      throw new Error(`Process identity verification returned an invalid result for PID ${row.pid}.`);
    }
    if (!identityMatches) continue;
    try {
      killProcess(row.pid, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
}

function samplerFromRows(rootPid, capturedIdentities, metric, ownedRows, memoryBytes, identityStillMatches) {
  async function rows() {
    return await ownedRows();
  }
  return Object.freeze({
    metric,
    capturedIdentities,
    async sample() {
      const selected = await rows();
      let bytes = 0;
      for (const row of selected) bytes += memoryBytes(row);
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Process-tree memory accounting overflowed.");
      return Object.freeze({ bytes, processCount: selected.length, metric });
    },
    async signal(signal, { includeRoot = true } = {}) {
      const selected = await rows();
      signalIdentityCheckedProcessRows(selected, signal, {
        rootPid,
        includeRoot,
        identityStillMatches
      });
    },
    async active() {
      return (await rows()).filter((row) => row.state !== "Z" && row.state !== "X");
    }
  });
}

export function formatMemoryBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown";
  const gibibytes = bytes / (1024 * 1024 * 1024);
  if (gibibytes >= 1) return `${gibibytes.toFixed(2)} GiB`;
  return `${(bytes / MIB).toFixed(0)} MiB`;
}
