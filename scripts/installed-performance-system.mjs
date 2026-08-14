import { readFileSync, readdirSync, realpathSync, statfsSync, statSync } from "node:fs";
import { arch, cpus, release, totalmem, type } from "node:os";
import { join } from "node:path";

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

export function readInstalledPlatformProvenance({ editorDisplayMode } = {}) {
  const processors = cpus();
  const cpuModel = processors.map((processor) => processor.model.trim()).find(Boolean);
  const totalMemoryBytes = totalmem();
  if (
    !cpuModel ||
    processors.length === 0 ||
    !Number.isSafeInteger(totalMemoryBytes) ||
    totalMemoryBytes <= 0 ||
    !["headless", "xvfb", "current"].includes(editorDisplayMode)
  ) {
    throw new Error("Installed performance could not establish bounded platform provenance.");
  }
  return {
    operatingSystem: type(),
    operatingSystemRelease: release(),
    architecture: arch(),
    cpuModel,
    logicalCpuCount: processors.length,
    totalMemoryBytes,
    editorDisplayMode
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
