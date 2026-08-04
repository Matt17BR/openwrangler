import { readFileSync, readdirSync } from "node:fs";

const KIBIBYTE = 1024;

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer.`);
  }
  return value;
}

function parseStat(text, expectedPid) {
  const close = text.lastIndexOf(")");
  if (!text.startsWith(`${expectedPid} (`) || close < 0) {
    throw new Error(`Could not parse /proc/${expectedPid}/stat.`);
  }
  const fields = text
    .slice(close + 2)
    .trim()
    .split(/\s+/u);
  const parentPid = Number(fields[1]);
  const processGroupId = Number(fields[2]);
  const startTimeTicks = fields[19];
  if (
    !Number.isSafeInteger(parentPid) ||
    parentPid < 0 ||
    !Number.isSafeInteger(processGroupId) ||
    processGroupId <= 0 ||
    !/^\d+$/u.test(startTimeTicks ?? "")
  ) {
    throw new Error(`Could not parse ownership fields from /proc/${expectedPid}/stat.`);
  }
  return { pid: expectedPid, parentPid, processGroupId, startTimeTicks };
}

function readStat(procRoot, pid, readFile) {
  try {
    return parseStat(readFile(`${procRoot}/${pid}/stat`, "utf8"), pid);
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes(error?.code)) return null;
    throw error;
  }
}

function readPssBytes(procRoot, process, readFile) {
  const before = readStat(procRoot, process.pid, readFile);
  if (!before || before.startTimeTicks !== process.startTimeTicks) return null;
  let text;
  try {
    text = readFile(`${procRoot}/${process.pid}/smaps_rollup`, "utf8");
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes(error?.code)) return null;
    throw error;
  }
  const match = /^Pss:\s+(\d+) kB$/mu.exec(text);
  if (!match) throw new Error(`/proc/${process.pid}/smaps_rollup has no Pss total.`);
  const after = readStat(procRoot, process.pid, readFile);
  if (!after || after.startTimeTicks !== process.startTimeTicks) return null;
  const bytes = Number(match[1]) * KIBIBYTE;
  if (!Number.isSafeInteger(bytes)) throw new Error(`PSS for PID ${process.pid} is too large.`);
  return bytes;
}

function processCensus(procRoot, readDirectory, readFile) {
  const census = new Map();
  for (const name of readDirectory(procRoot)) {
    if (!/^[1-9]\d*$/u.test(name)) continue;
    const pid = Number(name);
    if (!Number.isSafeInteger(pid)) continue;
    const process = readStat(procRoot, pid, readFile);
    if (process) census.set(pid, process);
  }
  return census;
}

function ownedProcesses(census, rootPid, expectedRootStartTimeTicks) {
  const root = census.get(rootPid);
  if (!root) throw new Error(`Root process ${rootPid} is no longer running.`);
  if (expectedRootStartTimeTicks && root.startTimeTicks !== expectedRootStartTimeTicks) {
    throw new Error(`Root process ${rootPid} was replaced.`);
  }
  const owned = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of census.values()) {
      if (!owned.has(process.pid) && owned.has(process.parentPid)) {
        owned.add(process.pid);
        changed = true;
      }
    }
  }
  return [...owned].map((pid) => census.get(pid)).sort((left, right) => left.pid - right.pid);
}

export function readLinuxPssTree(
  rootPid,
  {
    expectedRootStartTimeTicks,
    procRoot = "/proc",
    readDirectory = readdirSync,
    readFile = readFileSync,
    now = () => process.hrtime.bigint()
  } = {}
) {
  positiveInteger(rootPid, "Root PID");
  if (expectedRootStartTimeTicks !== undefined && !/^\d+$/u.test(expectedRootStartTimeTicks)) {
    throw new TypeError("Expected root start time must be Linux clock ticks.");
  }
  const census = processCensus(procRoot, readDirectory, readFile);
  const processes = [];
  for (const process of ownedProcesses(census, rootPid, expectedRootStartTimeTicks)) {
    const pssBytes = readPssBytes(procRoot, process, readFile);
    if (pssBytes !== null) processes.push({ pid: process.pid, pssBytes });
  }
  if (processes.length === 0) throw new Error("No owned process supplied a PSS sample.");
  return Object.freeze({
    monotonicNs: now().toString(),
    rootPid,
    rootStartTimeTicks: census.get(rootPid).startTimeTicks,
    processCount: processes.length,
    pssBytes: processes.reduce((total, process) => total + process.pssBytes, 0),
    processes: Object.freeze(processes.map(Object.freeze))
  });
}

export function startLinuxPssSampler(rootPid, options = {}) {
  const intervalMs = options.intervalMs ?? 200;
  positiveInteger(intervalMs, "PSS sample interval");
  let expectedRootStartTimeTicks = options.expectedRootStartTimeTicks;
  const read =
    options.read ??
    (() => {
      const sample = readLinuxPssTree(rootPid, { ...options, expectedRootStartTimeTicks });
      expectedRootStartTimeTicks ??= sample.rootStartTimeTicks;
      return sample;
    });
  const setTimer = options.setTimer ?? setInterval;
  const clearTimer = options.clearTimer ?? clearInterval;
  const samples = [];
  let error;
  let ended = false;
  const capture = () => {
    if (error || ended) return;
    try {
      samples.push(read());
    } catch (caught) {
      if (samples.length > 0 && /no longer running/u.test(String(caught?.message))) ended = true;
      else error = caught;
    }
  };
  capture();
  const timer = setTimer(capture, intervalMs);
  return Object.freeze({
    stop({ captureFinal = true } = {}) {
      clearTimer(timer);
      if (captureFinal) capture();
      if (error) throw error;
      return Object.freeze([...samples]);
    }
  });
}
