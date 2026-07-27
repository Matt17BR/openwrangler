import {
  closeSync,
  constants,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statfsSync,
  statSync
} from "node:fs";
import { arch, cpus, release, totalmem, type } from "node:os";
import { join } from "node:path";

const PROC_FILE_MAX_BYTES = 64 * 1024;
const PROC_ENTRY_LIMIT = 32_768;
const RESOURCE_SAMPLE_LIMIT = 1_024;
// Five 300-second editor phases can retain their initial sample plus every interval without crossing the report cap.
const RESOURCE_SAMPLE_INTERVAL_MS = 1_500;
const SYSFS_DEVICE_LIMIT = 32;
const SYSFS_DEPTH_LIMIT = 8;
const SYSFS_TEXT_MAX_BYTES = 4 * 1024;

const LINUX_FILESYSTEM_TYPES = new Map([
  [0x0102_1994n, "tmpfs"],
  [0x2fc1_2fc1n, "zfs"],
  [0x5846_5342n, "xfs"],
  [0x794c_7630n, "overlayfs"],
  [0x9123_683en, "btrfs"],
  [0x0000_ef53n, "ext"]
]);

export function readInstalledPlatformProvenance() {
  const processors = cpus();
  const cpuModel = processors.map((processor) => processor.model.trim()).find(Boolean);
  if (!cpuModel || processors.length === 0 || !Number.isSafeInteger(totalmem()) || totalmem() <= 0) {
    throw new Error("Installed performance could not establish bounded platform provenance.");
  }
  return {
    operatingSystem: type(),
    operatingSystemRelease: release(),
    architecture: arch(),
    cpuModel,
    logicalCpuCount: processors.length,
    totalMemoryBytes: totalmem()
  };
}

export function readInstalledStorageProvenance(target, options = {}) {
  const filesystem = statfsSync(target, { bigint: true });
  if (filesystem.bsize <= 0n || filesystem.bsize > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Installed performance could not establish the source filesystem block size.");
  }
  const magic = BigInt.asUintN(32, filesystem.type);
  const provenance = {
    filesystemType: LINUX_FILESYSTEM_TYPES.get(magic) ?? `linux-magic-0x${magic.toString(16)}`,
    blockSizeBytes: Number(filesystem.bsize),
    deviceModel: null,
    firmwareVersion: null,
    rotational: null
  };
  if ((options.platform ?? process.platform) !== "linux") return provenance;

  const metadata = statSync(target, { bigint: true });
  const { major, minor } = decodeLinuxDevice(metadata.dev);
  const sysDevice = join(options.sysDevBlockRoot ?? "/sys/dev/block", `${major}:${minor}`);
  let root;
  try {
    root = realpathSync(sysDevice);
  } catch {
    return provenance;
  }
  const leaves = collectLinuxStorageLeaves(root);
  const models = new Set();
  const firmware = new Set();
  const rotational = new Set();
  for (const leaf of leaves) {
    const model = firstLinuxDeviceText(leaf, ["device/model", "device/name"]);
    const revision = firstLinuxDeviceText(leaf, ["device/firmware_rev", "device/rev"]);
    const rotationalText = firstLinuxDeviceText(leaf, ["queue/rotational"]);
    if (model) models.add(model);
    if (revision) firmware.add(revision);
    if (rotationalText === "0") rotational.add(false);
    if (rotationalText === "1") rotational.add(true);
  }
  return {
    ...provenance,
    deviceModel: joinedBoundedValues(models),
    firmwareVersion: joinedBoundedValues(firmware),
    rotational: rotational.size === 1 ? [...rotational][0] : null
  };
}

export function decodeLinuxDevice(device) {
  const value = BigInt.asUintN(64, BigInt(device));
  const major = Number(((value >> 8n) & 0xfffn) | ((value >> 32n) & 0xffff_f000n));
  const minor = Number((value & 0xffn) | ((value >> 12n) & 0xffff_ff00n));
  if (!Number.isSafeInteger(major) || major < 0 || !Number.isSafeInteger(minor) || minor < 0) {
    throw new Error("Installed performance encountered an invalid Linux device identifier.");
  }
  return { major, minor };
}

export function parseLinuxProcessStat(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > PROC_FILE_MAX_BYTES) return undefined;
  const close = value.lastIndexOf(")");
  const open = value.indexOf("(");
  if (open <= 0 || close <= open) return undefined;
  const pid = strictPositiveInteger(value.slice(0, open).trim());
  const fields = value
    .slice(close + 1)
    .trim()
    .split(/\s+/u);
  const processGroupId = strictPositiveInteger(fields[2]);
  if (pid === undefined || processGroupId === undefined || fields.length < 22) return undefined;
  return { pid, processGroupId };
}

export function parseLinuxStatusRssBytes(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > PROC_FILE_MAX_BYTES) return undefined;
  const match = /^VmRSS:\s+([1-9]\d*)\s+kB$/mu.exec(value);
  const kibibytes = strictPositiveInteger(match?.[1]);
  if (kibibytes === undefined || kibibytes > Math.floor(Number.MAX_SAFE_INTEGER / 1024)) return undefined;
  return kibibytes * 1024;
}

export function isOpenWranglerRuntimeCommand(arguments_) {
  if (!Array.isArray(arguments_) || arguments_.some((value) => typeof value !== "string")) return false;
  for (let index = 0; index + 1 < arguments_.length; index += 1) {
    if (arguments_[index] === "-m" && arguments_[index + 1] === "openwrangler_runtime.server") return true;
  }
  return false;
}

export function readLinuxProcessGroupSample(processGroupId, options = {}) {
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 0) {
    throw new Error("Installed performance requires one positive editor process-group ID.");
  }
  const processes = readLinuxProcessGroup(processGroupId, options.procRoot ?? "/proc");
  if (processes.length === 0) return undefined;
  let editorTreeRssBytes = 0;
  let pythonRuntimeRssBytes = 0;
  for (const process of processes) {
    editorTreeRssBytes += process.rssBytes;
    if (process.openWranglerRuntime) pythonRuntimeRssBytes += process.rssBytes;
  }
  if (!Number.isSafeInteger(editorTreeRssBytes) || editorTreeRssBytes <= 0) {
    throw new Error("Installed performance encountered an invalid editor-tree RSS total.");
  }
  return {
    editorTreeRssBytes,
    pythonRuntimeRssBytes: pythonRuntimeRssBytes > 0 ? pythonRuntimeRssBytes : null
  };
}

export function createInstalledResourceSampler(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "linux") return unsupportedResourceSampler(platform);
  const procRoot = options.procRoot ?? "/proc";
  const intervalMs = options.intervalMs ?? RESOURCE_SAMPLE_INTERVAL_MS;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 10 || intervalMs > 60_000) {
    throw new Error("Installed performance resource sampling requires a bounded interval.");
  }
  const samples = [];
  let active;
  let timer;
  let failure;
  let sequence = 0;
  const takeSample = () => {
    if (!active || failure) return;
    try {
      const sample = readLinuxProcessGroupSample(active.processGroupId, { procRoot });
      if (!sample) return;
      if (samples.length >= RESOURCE_SAMPLE_LIMIT) {
        throw new Error("Installed performance resource sampling exceeded its fixed sample limit.");
      }
      sequence += 1;
      samples.push({ stage: `${active.phase}:${String(sequence).padStart(4, "0")}`, ...sample });
    } catch (error) {
      failure = error;
    }
  };
  return {
    begin(phase, processGroupId) {
      if (active || timer) throw new Error("Installed performance resource sampling cannot overlap editor phases.");
      if (!/^[a-z][a-z0-9-]{0,63}$/u.test(phase)) {
        throw new Error("Installed performance resource sampling requires a bounded phase name.");
      }
      active = { phase, processGroupId };
      takeSample();
      timer = setInterval(takeSample, intervalMs);
      timer.unref?.();
    },
    end() {
      if (!active) throw new Error("Installed performance resource sampling has no active editor phase.");
      if (timer) clearInterval(timer);
      timer = undefined;
      const completed = active;
      active = undefined;
      if (failure) throw failure;
      if (readLinuxProcessGroupSample(completed.processGroupId, { procRoot })) {
        throw new Error("Installed performance resource sampling found a surviving editor process group.");
      }
    },
    finish() {
      if (active || timer)
        throw new Error("Installed performance resource sampling ended with an active editor phase.");
      if (failure) throw failure;
      if (samples.length === 0) throw new Error("Installed performance did not capture any editor resource samples.");
      const editorPeak = Math.max(...samples.map((sample) => sample.editorTreeRssBytes));
      const runtimeSamples = samples.map((sample) => sample.pythonRuntimeRssBytes).filter((value) => value !== null);
      if (runtimeSamples.length === 0) {
        throw new Error("Installed performance did not observe the Open Wrangler Python runtime.");
      }
      return {
        supported: true,
        sampler: "linux-proc-process-group-v1",
        peakEditorTreeRssBytes: editorPeak,
        peakPythonRuntimeRssBytes: Math.max(...runtimeSamples),
        samples: structuredClone(samples)
      };
    }
  };
}

function unsupportedResourceSampler(platform) {
  const fail = () => {
    throw new Error(`Installed performance RSS sampling is not implemented for ${platform}.`);
  };
  return { begin: fail, end: fail, finish: fail };
}

function readLinuxProcessGroup(processGroupId, procRoot) {
  let entries;
  try {
    entries = readdirSync(procRoot, { withFileTypes: true });
  } catch (error) {
    throw new Error("Installed performance could not enumerate Linux processes.", { cause: error });
  }
  if (entries.length > PROC_ENTRY_LIMIT) {
    throw new Error("Installed performance Linux process enumeration exceeded its fixed entry limit.");
  }
  const processes = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[1-9]\d*$/u.test(entry.name)) continue;
    const directory = join(procRoot, entry.name);
    try {
      const stat = parseLinuxProcessStat(readBoundedProcFile(join(directory, "stat")));
      if (!stat || stat.processGroupId !== processGroupId) continue;
      const rssBytes = parseLinuxStatusRssBytes(readBoundedProcFile(join(directory, "status")));
      if (rssBytes === undefined) continue;
      const command = readBoundedProcFile(join(directory, "cmdline")).split("\0").filter(Boolean);
      processes.push({
        pid: stat.pid,
        rssBytes,
        openWranglerRuntime: isOpenWranglerRuntimeCommand(command)
      });
    } catch (error) {
      if (!["ENOENT", "ESRCH"].includes(error?.code)) throw error;
    }
  }
  return processes;
}

function readBoundedProcFile(file) {
  const buffer = Buffer.allocUnsafe(PROC_FILE_MAX_BYTES + 1);
  let descriptor;
  try {
    descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const bytes = readSync(descriptor, buffer, 0, buffer.length, 0);
    if (bytes > PROC_FILE_MAX_BYTES) throw new Error("Installed performance encountered an oversized procfs field.");
    return buffer.subarray(0, bytes).toString("utf8");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function collectLinuxStorageLeaves(root) {
  const pending = [{ path: root, depth: 0 }];
  const visited = new Set();
  const leaves = [];
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current || visited.has(current.path)) continue;
    if (visited.size >= SYSFS_DEVICE_LIMIT || current.depth > SYSFS_DEPTH_LIMIT) break;
    visited.add(current.path);
    let slaves = [];
    try {
      slaves = readdirSync(join(current.path, "slaves"));
    } catch {
      // A terminal device may expose no slaves directory.
    }
    const resolved = [];
    for (const slave of slaves.slice(0, SYSFS_DEVICE_LIMIT)) {
      try {
        resolved.push(realpathSync(join(current.path, "slaves", slave)));
      } catch {
        // A device can retire while provenance is sampled.
      }
    }
    if (resolved.length === 0) leaves.push(current.path);
    else pending.push(...resolved.map((path) => ({ path, depth: current.depth + 1 })));
  }
  return leaves.slice(0, SYSFS_DEVICE_LIMIT);
}

function firstLinuxDeviceText(root, candidates) {
  for (const candidate of candidates) {
    try {
      const value = readFileSync(join(root, candidate), "utf8").trim();
      if (value && Buffer.byteLength(value, "utf8") <= SYSFS_TEXT_MAX_BYTES && !/[\0\r\n]/u.test(value)) return value;
    } catch {
      // Device metadata is optional.
    }
  }
  return undefined;
}

function joinedBoundedValues(values) {
  if (values.size === 0) return null;
  const joined = [...values].sort().join(", ");
  return Buffer.byteLength(joined, "utf8") <= SYSFS_TEXT_MAX_BYTES ? joined : null;
}

function strictPositiveInteger(value) {
  if (typeof value !== "string" || !/^[1-9]\d*$/u.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}
