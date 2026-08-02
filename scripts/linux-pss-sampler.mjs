import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import {
  DATA_WRANGLER_STUDY_RESOURCE_CATEGORIES,
  DATA_WRANGLER_STUDY_RESOURCE_PROTOCOL,
  validateDataWranglerStudyResourceObservation
} from "./data-wrangler-comparison-study.mjs";

function parseStartTime(stat, pid) {
  const close = stat.lastIndexOf(")");
  if (!stat.startsWith(`${pid} (`) || close < 0) {
    throw new Error(`Could not parse process identity for PID ${pid}.`);
  }
  const fields = stat
    .slice(close + 2)
    .trim()
    .split(/\s+/u);
  const startTime = fields[19];
  if (startTime === undefined || !/^\d+$/u.test(startTime)) {
    throw new Error(`Could not read process start time for PID ${pid}.`);
  }
  return startTime;
}

function parseKilobytes(text, field, pid) {
  const match = new RegExp(`^${field}:\\s+(\\d+) kB$`, "mu").exec(text);
  if (match === null) {
    throw new Error(`Could not read ${field} from smaps_rollup for PID ${pid}.`);
  }
  const kilobytes = Number(match[1]);
  const bytes = kilobytes * 1024;
  if (!Number.isSafeInteger(bytes)) {
    throw new Error(`${field} for PID ${pid} exceeds the safe integer range.`);
  }
  return bytes;
}

function procPath(procRoot, pid, suffix) {
  return `${procRoot}/${pid}/${suffix}`;
}

function readIdentity(procRoot, pid, readFile) {
  return parseStartTime(readFile(procPath(procRoot, pid, "stat"), "utf8"), pid);
}

function childPids(procRoot, pid, readFile) {
  const text = readFile(procPath(procRoot, pid, `task/${pid}/children`), "utf8").trim();
  if (text.length === 0) {
    return [];
  }
  return text.split(/\s+/u).map((value) => {
    const child = Number(value);
    if (!Number.isSafeInteger(child) || child <= 0) {
      throw new Error(`Could not parse child PID owned by ${pid}.`);
    }
    return child;
  });
}

export class LinuxPssTreeSampler {
  constructor({ rootPid, classify, procRoot = "/proc", readFile = readFileSync, clock = () => performance.now() }) {
    if (process.platform !== "linux" && procRoot === "/proc") {
      throw new Error("Linux PSS sampling is supported only on Linux.");
    }
    if (!Number.isSafeInteger(rootPid) || rootPid <= 0) {
      throw new TypeError("PSS sampler root PID must be a positive integer.");
    }
    if (typeof classify !== "function") {
      throw new TypeError("PSS sampler requires an explicit process classifier.");
    }
    this.rootPid = rootPid;
    this.classify = classify;
    this.procRoot = procRoot.replace(/\/$/u, "");
    this.readFile = readFile;
    this.clock = clock;
    this.startedAt = clock();
    this.identities = new Map();
    this.categories = new Map();
  }

  sample() {
    const queue = [this.rootPid];
    const visited = new Set();
    const processes = [];
    while (queue.length > 0) {
      const pid = queue.shift();
      if (visited.has(pid)) {
        continue;
      }
      visited.add(pid);
      const before = readIdentity(this.procRoot, pid, this.readFile);
      const knownIdentity = this.identities.get(pid);
      if (knownIdentity !== undefined && knownIdentity !== before) {
        throw new Error(`PID ${pid} was reused during PSS sampling.`);
      }
      const children = childPids(this.procRoot, pid, this.readFile);
      const rollup = this.readFile(procPath(this.procRoot, pid, "smaps_rollup"), "utf8");
      const after = readIdentity(this.procRoot, pid, this.readFile);
      if (before !== after) {
        throw new Error(`PID ${pid} changed identity during PSS sampling.`);
      }
      this.identities.set(pid, before);
      const category = this.classify({ pid, startTimeTicks: before, rootPid: this.rootPid });
      if (!DATA_WRANGLER_STUDY_RESOURCE_CATEGORIES.includes(category)) {
        throw new Error(`PID ${pid} did not receive one valid PSS category.`);
      }
      const knownCategory = this.categories.get(`${pid}:${before}`);
      if (knownCategory !== undefined && knownCategory !== category) {
        throw new Error(`PID ${pid} changed PSS category during sampling.`);
      }
      this.categories.set(`${pid}:${before}`, category);
      processes.push({
        pid,
        startTimeTicks: before,
        category,
        pssBytes: parseKilobytes(rollup, "Pss", pid),
        rssBytes: parseKilobytes(rollup, "Rss", pid)
      });
      queue.push(...children);
    }
    processes.sort((left, right) => left.pid - right.pid);
    const categories = Object.fromEntries(DATA_WRANGLER_STUDY_RESOURCE_CATEGORIES.map((category) => [category, 0]));
    let totalPssBytes = 0;
    let totalRssBytes = 0;
    for (const process of processes) {
      totalPssBytes += process.pssBytes;
      totalRssBytes += process.rssBytes;
      categories[process.category] += process.pssBytes;
    }
    return {
      elapsedMs: Math.max(0, this.clock() - this.startedAt),
      totalPssBytes,
      totalRssBytes,
      categories,
      processes
    };
  }
}

export async function collectLinuxPssObservation({
  sampler,
  signal,
  intervalMs = 200,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  scheduleClock = () => performance.now()
}) {
  if (!(sampler instanceof LinuxPssTreeSampler)) {
    throw new TypeError("PSS collection requires a LinuxPssTreeSampler.");
  }
  if (intervalMs !== 200) {
    throw new TypeError("The comparison study requires a 200 ms PSS interval.");
  }
  const samples = [];
  let missedSamples = 0;
  let next = scheduleClock();
  const invalidObservation = () =>
    validateDataWranglerStudyResourceObservation({
      protocol: DATA_WRANGLER_STUDY_RESOURCE_PROTOCOL,
      valid: false,
      reasonClass: "resource-sampling",
      intervalMs,
      missedSamples,
      samples
    });
  while (!signal.aborted) {
    try {
      samples.push(sampler.sample());
    } catch {
      missedSamples += 1;
      return invalidObservation();
    }
    const lateness = scheduleClock() - next;
    if (lateness >= intervalMs) {
      missedSamples += Math.max(1, Math.floor(lateness / intervalMs));
      return invalidObservation();
    }
    next += intervalMs;
    await wait(Math.max(0, next - scheduleClock()));
  }
  const observation = {
    protocol: DATA_WRANGLER_STUDY_RESOURCE_PROTOCOL,
    valid: true,
    reasonClass: null,
    intervalMs,
    missedSamples,
    samples
  };
  return validateDataWranglerStudyResourceObservation(observation);
}
