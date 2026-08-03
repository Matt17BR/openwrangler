import { readFileSync, readdirSync } from "node:fs";
import {
  DATA_WRANGLER_STUDY_MAXIMUM_RESOURCE_SAMPLES,
  DATA_WRANGLER_STUDY_RESOURCE_CATEGORIES,
  DATA_WRANGLER_STUDY_RESOURCE_PROTOCOL,
  validateDataWranglerStudyResourceObservation
} from "./data-wrangler-comparison-study.mjs";

const MINIMUM_SUCCESSFUL_SAMPLE_COUNT = 5;
const MAX_PROC_DIRECTORY_ENTRIES = 131_584;
const MAX_CENSUS_PROCESSES = 131_072;
const MAX_PROC_ENTRY_NAME_CHARACTERS = 32;
const MAX_PROC_STAT_CHARACTERS = 4_096;
const MAX_SMAPS_ROLLUP_CHARACTERS = 1_048_576;
const NANOSECONDS_PER_MILLISECOND = 1_000_000n;
const NANOSECONDS_TEXT = /^(?:0|[1-9]\d{0,29})$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const PYTHON_VERSION = /^3\.12(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?$/u;
export const LINUX_PSS_CLOCK_SOURCE = "linux-process-hrtime-bigint";
export const LINUX_PSS_CLOCK_NORMALIZATION = "elapsedMs=(endedMonotonicNanoseconds-originNanoseconds)/1000000";
export const LINUX_PSS_BASELINE_ACKNOWLEDGEMENT_PROTOCOL = "openwrangler-linux-pss-baseline-ack-v1";
export const LINUX_PSS_OWNERSHIP_PROTOCOL = "openwrangler-linux-study-supervisor-v1";

// A sample that finishes more than one quarter of the 200 ms period after its
// scheduled instant is not treated as a gap-free sample. This bound is part of
// the retained observation rather than an implicit timer assumption.
export const LINUX_PSS_MAXIMUM_LATENESS_MS = 50;
export const LINUX_PSS_MAXIMUM_TERMINAL_OVERSHOOT_MS = 250;

// Sub-millisecond clock quantization is tolerated. One reported millisecond past
// the next sample deadline is a terminal sampling gap, not a successful stop.
const TERMINAL_ABORT_JITTER_NS = 500_000n;

function parseProcessStat(stat, pid) {
  const close = stat.lastIndexOf(")");
  if (!stat.startsWith(`${pid} (`) || close < 0) {
    throw new Error(`Could not parse process identity for PID ${pid}.`);
  }
  const fields = stat
    .slice(close + 2)
    .trim()
    .split(/\s+/u);
  const state = fields[0];
  const parentText = fields[1];
  const processGroupText = fields[2];
  const sessionText = fields[3];
  const startTimeTicks = fields[19];
  if (
    state === undefined ||
    !/^\S$/u.test(state) ||
    parentText === undefined ||
    !/^\d+$/u.test(parentText) ||
    processGroupText === undefined ||
    !/^\d+$/u.test(processGroupText) ||
    sessionText === undefined ||
    !/^\d+$/u.test(sessionText) ||
    startTimeTicks === undefined ||
    !/^\d+$/u.test(startTimeTicks)
  ) {
    throw new Error(`Could not parse process parent or identity for PID ${pid}.`);
  }
  const parentPid = Number(parentText);
  const processGroupId = Number(processGroupText);
  const sessionId = Number(sessionText);
  if (
    !Number.isSafeInteger(parentPid) ||
    parentPid < 0 ||
    !Number.isSafeInteger(processGroupId) ||
    processGroupId <= 0 ||
    !Number.isSafeInteger(sessionId) ||
    sessionId <= 0
  ) {
    throw new Error(`Process ownership fields for PID ${pid} exceed the supported range.`);
  }
  return { pid, parentPid, processGroupId, sessionId, startTimeTicks };
}

function parseKilobytes(text, field, pid) {
  const match = new RegExp(`^${field}:\\s+(\\d+) kB$`, "mu").exec(text);
  if (match === null) {
    throw new Error(`Could not read ${field} from smaps_rollup for PID ${pid}.`);
  }
  const bytes = Number(match[1]) * 1024;
  if (!Number.isSafeInteger(bytes)) {
    throw new Error(`${field} for PID ${pid} exceeds the safe integer range.`);
  }
  return bytes;
}

function procPath(procRoot, pid, suffix) {
  return `${procRoot}/${pid}/${suffix}`;
}

function readTextFile(readFile, path, description, maximumCharacters) {
  let value;
  try {
    value = readFile(path, "utf8");
  } catch {
    throw new Error(`Could not read ${description}.`);
  }
  if (typeof value !== "string" || value.length > maximumCharacters) {
    throw new Error(`${description} is missing or exceeds its bound.`);
  }
  return value;
}

function readDirectoryNames(readDirectory, path) {
  let value;
  try {
    value = readDirectory(path);
  } catch {
    throw new Error("Could not enumerate the Linux process census.");
  }
  if (
    !Array.isArray(value) ||
    value.length > MAX_PROC_DIRECTORY_ENTRIES ||
    value.some((entry) => typeof entry !== "string" || entry.length > MAX_PROC_ENTRY_NAME_CHARACTERS)
  ) {
    throw new Error("Linux process census entries are malformed or exceed their bound.");
  }
  return value;
}

function readNumericPids(procRoot, readDirectory) {
  const entries = readDirectoryNames(readDirectory, procRoot);
  const pids = [];
  const seen = new Set();
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) {
      continue;
    }
    const pid = Number(entry);
    if (!Number.isSafeInteger(pid) || pid <= 0 || String(pid) !== entry || seen.has(pid)) {
      throw new Error("Linux process census contains an ambiguous PID entry.");
    }
    seen.add(pid);
    pids.push(pid);
  }
  if (pids.length === 0 || pids.length > MAX_CENSUS_PROCESSES) {
    throw new Error("Linux process census is empty or exceeds its process bound.");
  }
  return pids.sort((left, right) => left - right);
}

function vanishedProcError(error) {
  return ["ENOENT", "ESRCH"].includes(error?.code);
}

function readProcessStat(procRoot, pid, readFile, { allowVanished = false } = {}) {
  let stat;
  try {
    stat = readFile(procPath(procRoot, pid, "stat"), "utf8");
  } catch (error) {
    if (allowVanished && vanishedProcError(error)) {
      return null;
    }
    throw new Error(`Could not read process identity for PID ${pid}.`);
  }
  if (typeof stat !== "string" || stat.length > MAX_PROC_STAT_CHARACTERS) {
    throw new Error(`process identity for PID ${pid} is missing or exceeds its bound.`);
  }
  return parseProcessStat(stat, pid);
}

function sameProcess(left, right) {
  return (
    left.pid === right.pid &&
    left.parentPid === right.parentPid &&
    left.processGroupId === right.processGroupId &&
    left.sessionId === right.sessionId &&
    left.startTimeTicks === right.startTimeTicks
  );
}

function readFullCensus(procRoot, readFile, readDirectory, requiredPids) {
  const pids = readNumericPids(procRoot, readDirectory);
  const census = new Map();
  for (const pid of pids) {
    // Keep the global scan to numeric /proc/<pid>/stat. Sensitive and
    // permission-gated procfs files are read only after ownership is proven.
    const process = readProcessStat(procRoot, pid, readFile, { allowVanished: true });
    if (process === null) {
      if (requiredPids.has(pid)) {
        throw new Error(`Owned Linux PID ${pid} vanished during the process census.`);
      }
      continue;
    }
    census.set(pid, process);
  }
  return census;
}

function ownedProcessesFromCensus(census, ownership) {
  const { supervisorPid, supervisorStartTimeTicks, editorRootPid, editorRootStartTimeTicks, retainedIdentities } =
    ownership;
  const supervisor = census.get(supervisorPid);
  if (supervisor?.startTimeTicks !== supervisorStartTimeTicks) {
    throw new Error("Linux study supervisor is absent or no longer has its launch-time identity.");
  }
  const editorRoot = census.get(editorRootPid);
  if (
    editorRoot?.startTimeTicks !== editorRootStartTimeTicks ||
    editorRoot.processGroupId !== editorRootPid ||
    editorRoot.sessionId !== editorRootPid
  ) {
    throw new Error("Linux editor root is absent or no longer owns its dedicated process group and session.");
  }

  const childrenByParent = new Map();
  for (const process of census.values()) {
    const children = childrenByParent.get(process.parentPid);
    if (children === undefined) {
      childrenByParent.set(process.parentPid, [process.pid]);
    } else {
      children.push(process.pid);
    }
  }
  for (const children of childrenByParent.values()) {
    children.sort((left, right) => left - right);
  }

  // PR_SET_CHILD_SUBREAPER makes orphaned descendants direct children of the
  // supervisor. A numeric stat census plus PPid closure therefore continues
  // to cover double-forked and setsid descendants without reading unrelated
  // processes' namespace, command-line, environment, or smaps files.
  const queue = [supervisorPid];
  const enqueued = new Set(queue);
  const visited = new Set();
  const ownedProcesses = [];
  while (queue.length > 0) {
    const pid = queue.shift();
    if (visited.has(pid)) {
      throw new Error("Owned Linux process graph is ambiguous.");
    }
    visited.add(pid);
    const process = census.get(pid);
    if (process === undefined) {
      throw new Error("Retained Linux process identity is absent from the process census.");
    }
    ownedProcesses.push(process);
    for (const child of childrenByParent.get(pid) ?? []) {
      if (!enqueued.has(child)) {
        enqueued.add(child);
        queue.push(child);
      }
    }
  }

  const ownedByPid = new Map(ownedProcesses.map((process) => [process.pid, process]));
  if (!ownedByPid.has(editorRootPid)) {
    throw new Error("Linux editor root is not owned by the retained study supervisor.");
  }
  for (const [pid, identity] of retainedIdentities) {
    const visible = census.get(pid);
    if (visible === undefined) {
      continue;
    }
    if (visible.startTimeTicks !== identity.startTimeTicks) {
      throw new Error(`Previously owned PID ${pid} was reused in the Linux process census.`);
    }
    if (!ownedByPid.has(pid)) {
      throw new Error(`Previously owned PID ${pid} is alive outside the supervisor-owned process closure.`);
    }
  }
  for (const process of ownedProcesses) {
    if (BigInt(process.startTimeTicks) < BigInt(supervisorStartTimeTicks)) {
      throw new Error("Linux ownership closure contains a process older than its supervisor.");
    }
  }
  return ownedProcesses.filter((process) => process.pid !== supervisorPid).sort((left, right) => left.pid - right.pid);
}

function assertSameOwnedCensus(first, second) {
  if (first.length !== second.length) {
    throw new Error("Owned Linux process population changed during PSS sampling.");
  }
  for (let index = 0; index < first.length; index += 1) {
    if (!sameProcess(first[index], second[index])) {
      throw new Error("Owned Linux process population, parentage, or identity changed during PSS sampling.");
    }
  }
}

function addBytes(total, value, description) {
  const result = total + value;
  if (!Number.isSafeInteger(result)) {
    throw new Error(`${description} exceeds the safe integer range.`);
  }
  return result;
}

function readClockNanoseconds(clock, description) {
  let value;
  try {
    value = clock();
  } catch {
    throw new Error(`Could not read ${description}.`);
  }
  if (typeof value !== "bigint" || value < 0n) {
    throw new TypeError(`${description} must return non-negative process.hrtime.bigint nanoseconds.`);
  }
  return value;
}

function nanosecondsText(value, description) {
  if (typeof value !== "string" || !NANOSECONDS_TEXT.test(value)) {
    throw new TypeError(`${description} must be decimal nanoseconds.`);
  }
  return BigInt(value);
}

function elapsedMilliseconds(timestamp, origin) {
  if (timestamp < origin) {
    throw new Error("PSS sampler absolute monotonic clock regressed behind its origin.");
  }
  return Number(timestamp - origin) / Number(NANOSECONDS_PER_MILLISECOND);
}

function validateFilesystemIdentity(identity, description) {
  if (
    identity === null ||
    typeof identity !== "object" ||
    Array.isArray(identity) ||
    Object.keys(identity).sort().join("\0") !== ["device", "inode", "mtimeNs", "sizeBytes"].join("\0") ||
    typeof identity.device !== "string" ||
    !/^\d+$/u.test(identity.device) ||
    typeof identity.inode !== "string" ||
    !/^\d+$/u.test(identity.inode) ||
    !Number.isSafeInteger(identity.sizeBytes) ||
    identity.sizeBytes <= 0 ||
    typeof identity.mtimeNs !== "string" ||
    !/^\d+$/u.test(identity.mtimeNs)
  ) {
    throw new TypeError(`${description} is malformed.`);
  }
  return Object.freeze({ ...identity });
}

function validateOwnershipReceipt(receipt, { supervisor, editorRoot }) {
  if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new TypeError("PSS sampler requires a verified Linux study-supervisor ownership receipt.");
  }
  const expectedKeys = [
    "protocol",
    "kind",
    "nonce",
    "supervisor",
    "editorRoot",
    "supervisorSource",
    "pythonExecutable",
    "invocationPolicySha256",
    "invocationSha256",
    "payloadArgvSha256",
    "payloadEnvironmentSha256"
  ];
  const supervisorSourceFilesystemIdentity = validateFilesystemIdentity(
    receipt.supervisorSource?.filesystemIdentity,
    "PSS supervisor source filesystem identity"
  );
  const pythonExecutableFilesystemIdentity = validateFilesystemIdentity(
    receipt.pythonExecutable?.filesystemIdentity,
    "PSS supervisor Python filesystem identity"
  );
  if (
    Object.keys(receipt).sort().join("\0") !== [...expectedKeys].sort().join("\0") ||
    receipt.protocol !== LINUX_PSS_OWNERSHIP_PROTOCOL ||
    receipt.kind !== "launch" ||
    typeof receipt.nonce !== "string" ||
    !SHA256.test(receipt.nonce) ||
    Object.keys(receipt.supervisor ?? {})
      .sort()
      .join("\0") !== ["pid", "startTimeTicks", "subreaperVerified", "pidfdVerified"].sort().join("\0") ||
    receipt.supervisor.pid !== supervisor.pid ||
    receipt.supervisor.startTimeTicks !== supervisor.startTimeTicks ||
    receipt.supervisor.subreaperVerified !== true ||
    receipt.supervisor.pidfdVerified !== true ||
    Object.keys(receipt.editorRoot ?? {})
      .sort()
      .join("\0") !== ["pid", "startTimeTicks", "processGroupId", "sessionId"].sort().join("\0") ||
    receipt.editorRoot.pid !== editorRoot.pid ||
    receipt.editorRoot.startTimeTicks !== editorRoot.startTimeTicks ||
    receipt.editorRoot.processGroupId !== editorRoot.pid ||
    receipt.editorRoot.sessionId !== editorRoot.pid ||
    editorRoot.processGroupId !== receipt.editorRoot.processGroupId ||
    editorRoot.sessionId !== receipt.editorRoot.sessionId ||
    editorRoot.parentPid !== supervisor.pid ||
    Object.keys(receipt.supervisorSource ?? {})
      .sort()
      .join("\0") !== ["sha256", "filesystemIdentity"].sort().join("\0") ||
    !SHA256.test(receipt.supervisorSource.sha256) ||
    Object.keys(receipt.pythonExecutable ?? {})
      .sort()
      .join("\0") !== ["implementation", "version", "sha256", "filesystemIdentity"].sort().join("\0") ||
    receipt.pythonExecutable.implementation !== "CPython" ||
    !SHA256.test(receipt.pythonExecutable.sha256) ||
    !PYTHON_VERSION.test(receipt.pythonExecutable.version) ||
    !SHA256.test(receipt.invocationPolicySha256) ||
    !SHA256.test(receipt.invocationSha256) ||
    !SHA256.test(receipt.payloadArgvSha256) ||
    !SHA256.test(receipt.payloadEnvironmentSha256)
  ) {
    throw new TypeError("PSS sampler ownership receipt is malformed or does not bind its supervisor and editor root.");
  }
  return Object.freeze({
    ...receipt,
    supervisor: Object.freeze({ ...receipt.supervisor }),
    editorRoot: Object.freeze({ ...receipt.editorRoot }),
    supervisorSource: Object.freeze({
      ...receipt.supervisorSource,
      filesystemIdentity: supervisorSourceFilesystemIdentity
    }),
    pythonExecutable: Object.freeze({
      ...receipt.pythonExecutable,
      filesystemIdentity: pythonExecutableFilesystemIdentity
    })
  });
}

function type7MedianFive(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[2];
}

function rollingBaselineAcknowledgement(samples) {
  const sample = samples.at(-1);
  const acknowledgement = {
    protocol: LINUX_PSS_BASELINE_ACKNOWLEDGEMENT_PROTOCOL,
    sampleIndex: samples.length - 1,
    sampleElapsedMs: sample.elapsedMs,
    sampleScheduledMonotonicNanoseconds: sample.scheduledMonotonicNanoseconds,
    sampleStartedMonotonicNanoseconds: sample.startedMonotonicNanoseconds,
    sampleEndedMonotonicNanoseconds: sample.endedMonotonicNanoseconds,
    stableBaseline: null
  };
  if (samples.length < MINIMUM_SUCCESSFUL_SAMPLE_COUNT) {
    return Object.freeze(acknowledgement);
  }
  const baseline = samples.slice(-MINIMUM_SUCCESSFUL_SAMPLE_COUNT);
  const values = baseline.map((entry) => entry.totalPssBytes);
  const medianPssBytes = type7MedianFive(values);
  const rangePssBytes = Math.max(...values) - Math.min(...values);
  const maximumRangePssBytes = Math.max(64 * 1024 * 1024, medianPssBytes * 0.05);
  if (rangePssBytes > maximumRangePssBytes) {
    return Object.freeze(acknowledgement);
  }
  acknowledgement.stableBaseline = Object.freeze({
    sampleCount: MINIMUM_SUCCESSFUL_SAMPLE_COUNT,
    firstSampleIndex: samples.length - MINIMUM_SUCCESSFUL_SAMPLE_COUNT,
    lastSampleIndex: samples.length - 1,
    firstStartedMonotonicNanoseconds: baseline[0].startedMonotonicNanoseconds,
    lastEndedMonotonicNanoseconds: sample.endedMonotonicNanoseconds,
    medianPssBytes,
    rangePssBytes,
    maximumRangePssBytes
  });
  return Object.freeze(acknowledgement);
}

function abortAwareWait(milliseconds, signal) {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let timer;
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      signal.removeEventListener("abort", finish);
      resolve();
    };
    signal.addEventListener("abort", finish, { once: true });
    timer = setTimeout(finish, milliseconds);
    if (signal.aborted) {
      finish();
    }
  });
}

export class LinuxPssTreeSampler {
  constructor({
    supervisorPid,
    supervisorStartTimeTicks,
    editorRootPid,
    editorRootStartTimeTicks,
    ownershipReceipt,
    classify,
    procRoot = "/proc",
    readFile = readFileSync,
    readDirectory = readdirSync,
    clock = process.hrtime.bigint,
    originNanoseconds
  }) {
    if (process.platform !== "linux" && procRoot === "/proc") {
      throw new Error("Linux PSS sampling is supported only on Linux.");
    }
    if (!Number.isSafeInteger(supervisorPid) || supervisorPid <= 0) {
      throw new TypeError("PSS sampler supervisor PID must be a positive integer.");
    }
    if (typeof supervisorStartTimeTicks !== "string" || !/^\d+$/u.test(supervisorStartTimeTicks)) {
      throw new TypeError("PSS sampler requires the launch-time supervisor startTimeTicks.");
    }
    if (!Number.isSafeInteger(editorRootPid) || editorRootPid <= 0 || editorRootPid === supervisorPid) {
      throw new TypeError("PSS sampler editor-root PID must be a distinct positive integer.");
    }
    if (typeof editorRootStartTimeTicks !== "string" || !/^\d+$/u.test(editorRootStartTimeTicks)) {
      throw new TypeError("PSS sampler requires the launch-time editor-root startTimeTicks.");
    }
    if (typeof classify !== "function") {
      throw new TypeError("PSS sampler requires an explicit process classifier.");
    }
    if (typeof readFile !== "function" || typeof readDirectory !== "function" || typeof clock !== "function") {
      throw new TypeError("PSS sampler dependencies must be functions.");
    }
    this.supervisorPid = supervisorPid;
    this.supervisorStartTimeTicks = supervisorStartTimeTicks;
    this.rootPid = editorRootPid;
    this.rootStartTimeTicks = editorRootStartTimeTicks;
    this.classify = classify;
    this.procRoot = procRoot.replace(/\/$/u, "");
    this.readFile = readFile;
    this.readDirectory = readDirectory;
    const supervisor = readProcessStat(this.procRoot, supervisorPid, readFile);
    const editorRoot = readProcessStat(this.procRoot, editorRootPid, readFile);
    this.ownership = validateOwnershipReceipt(ownershipReceipt, { supervisor, editorRoot });
    this.clock = clock;
    this.originNanoseconds =
      originNanoseconds === undefined
        ? readClockNanoseconds(clock, "PSS sampler clock")
        : typeof originNanoseconds === "bigint"
          ? originNanoseconds
          : nanosecondsText(originNanoseconds, "PSS sampler clock origin");
    if (this.originNanoseconds < 0n) {
      throw new TypeError("PSS sampler clock origin must be non-negative nanoseconds.");
    }
    this.identities = new Map([[editorRootPid, { startTimeTicks: editorRootStartTimeTicks }]]);
    this.categories = new Map();
  }

  clockReceipt() {
    return Object.freeze({
      source: LINUX_PSS_CLOCK_SOURCE,
      originNanoseconds: this.originNanoseconds.toString(),
      normalization: LINUX_PSS_CLOCK_NORMALIZATION
    });
  }

  ownershipReceipt() {
    return this.ownership;
  }

  retainedOwnedIdentities() {
    return Object.freeze(
      [...this.identities.entries()]
        .sort(([left], [right]) => left - right)
        .map(([pid, identity]) =>
          Object.freeze({
            pid,
            startTimeTicks: identity.startTimeTicks
          })
        )
    );
  }

  readClockNanoseconds(description = "PSS sampler clock") {
    const value = readClockNanoseconds(this.clock, description);
    if (value < this.originNanoseconds) {
      throw new Error("PSS sampler clock is not monotonic with its retained origin.");
    }
    return value;
  }

  assertKnownIdentity(process) {
    if (process.pid === this.rootPid && process.startTimeTicks !== this.rootStartTimeTicks) {
      throw new Error(`Root PID ${process.pid} no longer has its launch-time process identity.`);
    }
    const knownIdentity = this.identities.get(process.pid);
    if (knownIdentity !== undefined && knownIdentity.startTimeTicks !== process.startTimeTicks) {
      throw new Error(`PID ${process.pid} was reused during PSS sampling.`);
    }
  }

  sample({ scheduledMonotonicNanoseconds } = {}) {
    const startedAt = this.readClockNanoseconds("PSS sample-start clock");
    const scheduledAt =
      scheduledMonotonicNanoseconds === undefined
        ? startedAt
        : typeof scheduledMonotonicNanoseconds === "bigint"
          ? scheduledMonotonicNanoseconds
          : nanosecondsText(scheduledMonotonicNanoseconds, "PSS scheduled sample timestamp");
    if (scheduledAt < this.originNanoseconds || startedAt < scheduledAt) {
      throw new Error("PSS sample start precedes its scheduled absolute monotonic instant.");
    }
    // Both boundary scans cover every visible numeric /proc PID using stat
    // only. Equality is required for the supervisor-owned closure, not for
    // unrelated desktop churn.
    const firstCensus = readFullCensus(
      this.procRoot,
      this.readFile,
      this.readDirectory,
      new Set([this.supervisorPid, this.rootPid])
    );
    const root = firstCensus.get(this.rootPid);
    if (root === undefined) {
      throw new Error("Linux editor root is absent from the process census.");
    }
    this.assertKnownIdentity(root);
    const ownership = {
      supervisorPid: this.supervisorPid,
      supervisorStartTimeTicks: this.supervisorStartTimeTicks,
      editorRootPid: this.rootPid,
      editorRootStartTimeTicks: this.rootStartTimeTicks,
      retainedIdentities: this.identities
    };
    const ownedProcesses = ownedProcessesFromCensus(firstCensus, ownership);
    for (const process of ownedProcesses) {
      this.assertKnownIdentity(process);
      this.identities.set(process.pid, { startTimeTicks: process.startTimeTicks });
    }

    const processes = [];
    for (const process of ownedProcesses) {
      const before = readProcessStat(this.procRoot, process.pid, this.readFile);
      if (!sameProcess(process, before)) {
        throw new Error(`PID ${process.pid} changed identity or parentage before its PSS read.`);
      }
      const rollup = readTextFile(
        this.readFile,
        procPath(this.procRoot, process.pid, "smaps_rollup"),
        `PSS rollup for PID ${process.pid}`,
        MAX_SMAPS_ROLLUP_CHARACTERS
      );
      const after = readProcessStat(this.procRoot, process.pid, this.readFile);
      if (!sameProcess(process, after)) {
        throw new Error(`PID ${process.pid} changed identity or parentage during its PSS read.`);
      }

      let category;
      try {
        category = this.classify({
          pid: process.pid,
          startTimeTicks: process.startTimeTicks,
          rootPid: this.rootPid,
          rootStartTimeTicks: this.rootStartTimeTicks
        });
      } catch {
        throw new Error(`Could not classify PID ${process.pid} for PSS sampling.`);
      }
      if (!DATA_WRANGLER_STUDY_RESOURCE_CATEGORIES.includes(category)) {
        throw new Error(`PID ${process.pid} did not receive one valid PSS category.`);
      }
      const categoryKey = `${process.pid}:${process.startTimeTicks}`;
      const knownCategory = this.categories.get(categoryKey);
      if (knownCategory !== undefined && knownCategory !== category) {
        throw new Error(`PID ${process.pid} changed PSS category during sampling.`);
      }
      processes.push({
        pid: process.pid,
        startTimeTicks: process.startTimeTicks,
        category,
        pssBytes: parseKilobytes(rollup, "Pss", process.pid),
        rssBytes: parseKilobytes(rollup, "Rss", process.pid)
      });
    }

    const finalCensus = readFullCensus(
      this.procRoot,
      this.readFile,
      this.readDirectory,
      new Set([this.supervisorPid, this.rootPid])
    );
    const finalOwnedProcesses = ownedProcessesFromCensus(finalCensus, ownership);
    assertSameOwnedCensus(ownedProcesses, finalOwnedProcesses);

    const categories = Object.fromEntries(DATA_WRANGLER_STUDY_RESOURCE_CATEGORIES.map((category) => [category, 0]));
    let totalPssBytes = 0;
    let totalRssBytes = 0;
    for (const process of processes) {
      totalPssBytes = addBytes(totalPssBytes, process.pssBytes, "Total PSS");
      totalRssBytes = addBytes(totalRssBytes, process.rssBytes, "Total RSS");
      categories[process.category] = addBytes(categories[process.category], process.pssBytes, "PSS category total");
    }
    const endedAt = this.readClockNanoseconds("PSS sample-end clock");
    for (const process of processes) {
      this.categories.set(`${process.pid}:${process.startTimeTicks}`, process.category);
    }
    return {
      scheduledMonotonicNanoseconds: scheduledAt.toString(),
      startedMonotonicNanoseconds: startedAt.toString(),
      endedMonotonicNanoseconds: endedAt.toString(),
      latenessMs: Number(startedAt - scheduledAt) / Number(NANOSECONDS_PER_MILLISECOND),
      elapsedMs: elapsedMilliseconds(endedAt, this.originNanoseconds),
      totalPssBytes,
      totalRssBytes,
      categories,
      processes
    };
  }
}

function excessiveLatenessCount(now, due, intervalNanoseconds, maximumLatenessNanoseconds) {
  if (now <= due + maximumLatenessNanoseconds) {
    return 0;
  }
  const excess = now - due - maximumLatenessNanoseconds;
  const count = (excess + intervalNanoseconds - 1n) / intervalNanoseconds;
  if (count > BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Math.max(1, Number(count));
}

export async function collectLinuxPssObservation({
  sampler,
  signal,
  intervalMs = 200,
  wait = abortAwareWait,
  scheduleClock = () => process.hrtime.bigint(),
  onSample,
  getTerminalBoundaryNanoseconds = () => null
}) {
  if (!(sampler instanceof LinuxPssTreeSampler)) {
    throw new TypeError("PSS collection requires a LinuxPssTreeSampler.");
  }
  if (intervalMs !== 200) {
    throw new TypeError("The comparison study requires a 200 ms PSS interval.");
  }
  if (
    signal === null ||
    typeof signal !== "object" ||
    typeof signal.aborted !== "boolean" ||
    typeof signal.addEventListener !== "function" ||
    typeof signal.removeEventListener !== "function"
  ) {
    throw new TypeError("PSS collection requires an AbortSignal.");
  }
  if (
    typeof wait !== "function" ||
    typeof scheduleClock !== "function" ||
    (onSample !== undefined && typeof onSample !== "function") ||
    typeof getTerminalBoundaryNanoseconds !== "function"
  ) {
    throw new TypeError("PSS collector dependencies must be functions.");
  }

  const intervalNanoseconds = BigInt(intervalMs) * NANOSECONDS_PER_MILLISECOND;
  const maximumLatenessNanoseconds = BigInt(LINUX_PSS_MAXIMUM_LATENESS_MS) * NANOSECONDS_PER_MILLISECOND;
  const maximumTerminalOvershootMs = LINUX_PSS_MAXIMUM_TERMINAL_OVERSHOOT_MS;
  const maximumTerminalOvershootNanoseconds = BigInt(maximumTerminalOvershootMs) * NANOSECONDS_PER_MILLISECOND;
  const samples = [];
  let missedSamples = 0;
  let lastScheduleTime = null;
  let abortTime = null;
  let abortClockFailed = false;
  let pinnedTerminalBoundary = null;
  let terminalBoundary = null;
  const observationBase = () => ({
    protocol: DATA_WRANGLER_STUDY_RESOURCE_PROTOCOL,
    clock: sampler.clockReceipt(),
    ownershipTracker: sampler.ownershipReceipt(),
    intervalMs,
    maximumLatenessMs: LINUX_PSS_MAXIMUM_LATENESS_MS,
    missedSamples,
    terminalBoundary,
    retainedOwnedIdentities: sampler.retainedOwnedIdentities(),
    samples
  });
  const invalidObservation = () =>
    validateDataWranglerStudyResourceObservation({
      ...observationBase(),
      valid: false,
      reasonClass: "resource-sampling"
    });
  const finishObservation = () => {
    if (samples.length < MINIMUM_SUCCESSFUL_SAMPLE_COUNT) {
      return invalidObservation();
    }
    return validateDataWranglerStudyResourceObservation({
      ...observationBase(),
      valid: true,
      reasonClass: null
    });
  };
  const readScheduleTime = () => {
    const value = readClockNanoseconds(scheduleClock, "PSS schedule clock");
    if (value < sampler.originNanoseconds || (lastScheduleTime !== null && value < lastScheduleTime)) {
      throw new Error("PSS schedule clock is not monotonic.");
    }
    lastScheduleTime = value;
    return value;
  };
  const invalidateAtDue = (scheduledAt) => {
    try {
      const now = readScheduleTime();
      missedSamples += Math.max(
        1,
        excessiveLatenessCount(now, scheduledAt, intervalNanoseconds, maximumLatenessNanoseconds)
      );
    } catch {
      missedSamples += 1;
    }
    return invalidObservation();
  };
  const captureAbortTime = () => {
    try {
      abortTime = readScheduleTime();
    } catch {
      abortClockFailed = true;
    }
  };
  const finishTerminalObservation = (nextDue) => {
    if (abortClockFailed || abortTime === null) {
      missedSamples += 1;
      return invalidObservation();
    }
    if (abortTime > nextDue + TERMINAL_ABORT_JITTER_NS) {
      const terminalLateness = abortTime - nextDue - TERMINAL_ABORT_JITTER_NS;
      const count = (terminalLateness + intervalNanoseconds - 1n) / intervalNanoseconds;
      missedSamples += count > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Math.max(1, Number(count));
      return invalidObservation();
    }
    return finishObservation();
  };
  const readTerminalBoundary = () => {
    let value;
    try {
      value = getTerminalBoundaryNanoseconds();
    } catch {
      throw new Error("Could not read the PSS terminal boundary.");
    }
    if (value === null) {
      if (pinnedTerminalBoundary !== null) {
        throw new Error("PSS terminal boundary disappeared after publication.");
      }
      return null;
    }
    const boundary = typeof value === "bigint" ? value : nanosecondsText(value, "PSS terminal boundary");
    if (boundary < sampler.originNanoseconds) {
      throw new Error("PSS terminal boundary precedes the retained monotonic origin.");
    }
    if (pinnedTerminalBoundary !== null && boundary !== pinnedTerminalBoundary) {
      throw new Error("PSS terminal boundary changed after publication.");
    }
    pinnedTerminalBoundary = boundary;
    return boundary;
  };
  const finishAtBoundary = (sample) => {
    const target = readTerminalBoundary();
    if (target === null) {
      return null;
    }
    const sampleStartedAt = nanosecondsText(sample.startedMonotonicNanoseconds, "PSS sample-start monotonic timestamp");
    if (sampleStartedAt < target) {
      return null;
    }
    if (
      samples
        .slice(0, -1)
        .some(
          (previousSample) =>
            nanosecondsText(
              previousSample.startedMonotonicNanoseconds,
              "Previous PSS sample-start monotonic timestamp"
            ) >= target
        )
    ) {
      missedSamples += 1;
      return invalidObservation();
    }
    const overshootNanoseconds = sampleStartedAt - target;
    if (overshootNanoseconds > maximumTerminalOvershootNanoseconds) {
      missedSamples += excessiveLatenessCount(sampleStartedAt, target, intervalNanoseconds, maximumLatenessNanoseconds);
      return invalidObservation();
    }
    terminalBoundary = {
      targetMonotonicNanoseconds: target.toString(),
      firstEligibleSampleScheduledMonotonicNanoseconds: sample.scheduledMonotonicNanoseconds,
      firstEligibleSampleStartedMonotonicNanoseconds: sample.startedMonotonicNanoseconds,
      firstEligibleSampleEndedMonotonicNanoseconds: sample.endedMonotonicNanoseconds,
      startOvershootMs: Number(overshootNanoseconds) / Number(NANOSECONDS_PER_MILLISECOND),
      sampleLatenessMs: sample.latenessMs,
      maximumOvershootMs: maximumTerminalOvershootMs
    };
    return finishObservation();
  };

  let due;
  try {
    due = readScheduleTime();
  } catch {
    missedSamples += 1;
    return invalidObservation();
  }
  if (signal.aborted) {
    return invalidObservation();
  }
  signal.addEventListener("abort", captureAbortTime, { once: true });
  try {
    while (true) {
      if (signal.aborted) {
        return finishTerminalObservation(due);
      }
      let sample;
      try {
        sample = sampler.sample({ scheduledMonotonicNanoseconds: due });
      } catch {
        return invalidateAtDue(due);
      }
      const previousSample = samples.at(-1);
      let now;
      try {
        now = readScheduleTime();
      } catch {
        return invalidateAtDue(due);
      }
      const scheduledAt = nanosecondsText(
        sample.scheduledMonotonicNanoseconds,
        "PSS scheduled sample monotonic timestamp"
      );
      const startedAt = nanosecondsText(sample.startedMonotonicNanoseconds, "PSS sample-start monotonic timestamp");
      const endedAt = nanosecondsText(sample.endedMonotonicNanoseconds, "PSS sample-end monotonic timestamp");
      if (scheduledAt !== due || startedAt < scheduledAt || endedAt < startedAt || endedAt > now) {
        missedSamples += 1;
        return invalidObservation();
      }
      if (samples.length >= DATA_WRANGLER_STUDY_MAXIMUM_RESOURCE_SAMPLES) {
        missedSamples += 1;
        return invalidObservation();
      }
      samples.push(sample);
      if (
        previousSample !== undefined &&
        (scheduledAt <=
          nanosecondsText(
            previousSample.scheduledMonotonicNanoseconds,
            "Previous PSS scheduled sample monotonic timestamp"
          ) ||
          startedAt <=
            nanosecondsText(
              previousSample.startedMonotonicNanoseconds,
              "Previous PSS sample-start monotonic timestamp"
            ) ||
          endedAt <=
            nanosecondsText(previousSample.endedMonotonicNanoseconds, "Previous PSS sample-end monotonic timestamp"))
      ) {
        missedSamples += 1;
        return invalidObservation();
      }
      const samplingMisses = excessiveLatenessCount(now, due, intervalNanoseconds, maximumLatenessNanoseconds);
      if (samplingMisses > 0) {
        missedSamples += samplingMisses;
        return invalidObservation();
      }

      if (onSample !== undefined) {
        let acknowledgementResult;
        try {
          acknowledgementResult = onSample(rollingBaselineAcknowledgement(samples));
        } catch {
          return invalidateAtDue(due);
        }
        if (acknowledgementResult !== undefined) {
          if (acknowledgementResult !== null && typeof acknowledgementResult?.then === "function") {
            void Promise.resolve(acknowledgementResult).catch(() => {});
          }
          return invalidateAtDue(due);
        }
        try {
          now = readScheduleTime();
        } catch {
          return invalidateAtDue(due);
        }
        const acknowledgementMisses = excessiveLatenessCount(now, due, intervalNanoseconds, maximumLatenessNanoseconds);
        if (acknowledgementMisses > 0) {
          missedSamples += acknowledgementMisses;
          return invalidObservation();
        }
      }

      let boundaryResult;
      try {
        boundaryResult = finishAtBoundary(sample);
      } catch {
        return invalidateAtDue(due);
      }
      if (boundaryResult !== null) {
        return boundaryResult;
      }

      const nextDue = due + intervalNanoseconds;
      if (signal.aborted) {
        return finishTerminalObservation(nextDue);
      }
      while (now < nextDue && !signal.aborted) {
        const beforeWait = now;
        try {
          await wait(Number(nextDue - now) / Number(NANOSECONDS_PER_MILLISECOND), signal);
        } catch {
          return invalidateAtDue(nextDue);
        }
        try {
          now = readScheduleTime();
        } catch {
          return invalidateAtDue(nextDue);
        }
        if (signal.aborted) {
          return finishTerminalObservation(nextDue);
        }
        const waitMisses = excessiveLatenessCount(now, nextDue, intervalNanoseconds, maximumLatenessNanoseconds);
        if (waitMisses > 0) {
          missedSamples += waitMisses;
          return invalidObservation();
        }
        if (now < nextDue && now <= beforeWait) {
          return invalidateAtDue(nextDue);
        }
      }
      if (signal.aborted) {
        return finishTerminalObservation(nextDue);
      }
      due = nextDue;
    }
  } finally {
    signal.removeEventListener("abort", captureAbortTime);
  }
}
