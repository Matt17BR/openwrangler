import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statfsSync } from "node:fs";
import { totalmem } from "node:os";
import { resolve, sep } from "node:path";
import {
  captureLinuxDataWranglerStudyProvenance,
  formatLinuxCpuList,
  parseLinuxCpuList
} from "./linux-data-wrangler-study-gate.mjs";

const PROC_MOUNTINFO = "/proc/self/mountinfo";
const OS_RELEASE = "/etc/os-release";
const MACHINE_ID = "/etc/machine-id";

function fail(message) {
  throw new TypeError(message);
}

function decodeMountField(value) {
  return value.replace(/\\([0-7]{3})/gu, (_match, digits) => String.fromCharCode(Number.parseInt(digits, 8)));
}

function isContainedPath(parent, child) {
  const prefix = parent.endsWith(sep) ? parent : `${parent}${sep}`;
  return child === parent || child.startsWith(prefix);
}

function linuxDeviceNumbers(device) {
  const value = BigInt(device);
  const major = ((value >> 8n) & 0xfffn) | ((value >> 32n) & ~0xfffn);
  const minor = (value & 0xffn) | ((value >> 12n) & ~0xffn);
  return `${major}:${minor}`;
}

function parseMountInfo(text, fixturePath, deviceNumbers) {
  const matches = [];
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    const separator = line.indexOf(" - ");
    if (separator < 1) fail("Linux mount information contains a malformed record.");
    const left = line.slice(0, separator).split(" ");
    const right = line.slice(separator + 3).split(" ");
    if (left.length < 6 || right.length < 3) fail("Linux mount information is incomplete.");
    const mountPoint = decodeMountField(left[4]);
    if (left[2] !== deviceNumbers || !isContainedPath(mountPoint, fixturePath)) continue;
    matches.push({
      deviceNumbers,
      root: decodeMountField(left[3]),
      mountPoint,
      mountOptions: left[5],
      optionalFields: left.slice(6),
      filesystemType: right[0],
      source: decodeMountField(right[1]),
      superOptions: right.slice(2).join(" ")
    });
  }
  matches.sort((left, right) => right.mountPoint.length - left.mountPoint.length);
  if (matches.length === 0) fail("The fixture volume is absent from Linux mount information.");
  if (matches[1]?.mountPoint.length === matches[0].mountPoint.length) {
    fail("The fixture volume has ambiguous Linux mount information.");
  }
  return matches[0];
}

function parseOsRelease(text) {
  const values = new Map();
  for (const line of text.split("\n")) {
    if (line.length === 0 || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) fail("Linux operating-system release information is malformed.");
    let value = line.slice(separator + 1);
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\([\\"$`])/gu, "$1");
    }
    values.set(line.slice(0, separator), value);
  }
  const release = values.get("PRETTY_NAME") ?? values.get("NAME");
  if (typeof release !== "string" || release.length === 0 || release.length > 4096 || /[\0\r\n]/u.test(release)) {
    fail("Linux operating-system release information has no bounded name.");
  }
  return release;
}

function digest(value) {
  const canonicalize = (item) => {
    if (Array.isArray(item)) return item.map(canonicalize);
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, canonicalize(item[key])])
      );
    }
    return item;
  };
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)), "utf8")
    .digest("hex");
}

function readOptionalText(readText, path) {
  try {
    return String(readText(path)).trim();
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

export function captureDataWranglerComparisonEnvironment(
  { cpuList, fixturePath, display, zoom },
  {
    captureGateProvenance = captureLinuxDataWranglerStudyProvenance,
    memoryBytes = () => totalmem(),
    readText = (path) => readFileSync(path, "utf8"),
    realpath = realpathSync,
    statFile = (path) => lstatSync(path, { bigint: true }),
    statFilesystem = statfsSync
  } = {}
) {
  if (
    typeof cpuList !== "string" ||
    typeof fixturePath !== "string" ||
    resolve(fixturePath) !== fixturePath ||
    display === null ||
    typeof display !== "object" ||
    zoom === null ||
    typeof zoom !== "object"
  ) {
    fail("Performance-study environment capture requires an explicit CPU list, fixture, display, and zoom.");
  }
  const cpuIds = parseLinuxCpuList(cpuList);
  if (formatLinuxCpuList(cpuIds) !== cpuList) {
    fail("Performance-study CPU list must be canonical.");
  }
  const canonicalFixture = realpath(fixturePath);
  if (canonicalFixture !== fixturePath) fail("Performance-study fixture path must be canonical and link-free.");
  const fixture = statFile(fixturePath);
  if (!fixture.isFile() || fixture.isSymbolicLink() || fixture.nlink !== 1n) {
    fail("Performance-study fixture must be one singly linked regular file.");
  }
  const gate = captureGateProvenance(
    {
      cpuIds,
      display: {
        mode: display.mode,
        width: display.widthPx,
        height: display.heightPx,
        scaleFactor: display.deviceScaleFactor,
        zoomLevel: zoom.level,
        theme: zoom.theme
      }
    },
    { environment: {} }
  );
  if (gate.platform !== "linux" || gate.architecture !== "x64") {
    fail("Performance-study preparation requires Linux x64.");
  }
  const machineId = String(readText(MACHINE_ID)).trim();
  if (!/^[A-Za-z0-9._:-]{8,256}$/u.test(machineId)) fail("Linux machine identity is unavailable or malformed.");
  const observedMemory = memoryBytes();
  if (!Number.isSafeInteger(observedMemory) || observedMemory < 1) {
    fail("Linux total memory is unavailable or exceeds the safe receipt range.");
  }
  const deviceNumbers = linuxDeviceNumbers(fixture.dev);
  const mount = parseMountInfo(readText(PROC_MOUNTINFO), fixturePath, deviceNumbers);
  const deviceRoot = `/sys/dev/block/${deviceNumbers}`;
  const model = readOptionalText(readText, `${deviceRoot}/device/model`) ?? `Linux block device ${deviceNumbers}`;
  if (model.length === 0 || model.length > 256 || /[\0\r\n]/u.test(model)) {
    fail("Linux fixture-storage model is malformed.");
  }
  const rotationalText = readOptionalText(readText, `${deviceRoot}/queue/rotational`);
  if (rotationalText !== "0" && rotationalText !== "1") {
    fail("Linux fixture-storage rotational state is unavailable.");
  }
  const filesystem = statFilesystem(fixturePath, { bigint: true });
  const storageIdentity = {
    deviceNumbers,
    source: mount.source,
    model,
    filesystemType: mount.filesystemType
  };
  const mountIdentity = {
    deviceNumbers,
    root: mount.root,
    mountPoint: mount.mountPoint,
    mountOptions: mount.mountOptions,
    optionalFields: mount.optionalFields,
    superOptions: mount.superOptions
  };
  return Object.freeze({
    machine: Object.freeze({
      platform: gate.platform,
      architecture: gate.architecture,
      osRelease: parseOsRelease(readText(OS_RELEASE)),
      kernelRelease: gate.kernelRelease,
      machineIdSha256: digest(machineId),
      totalMemoryBytes: observedMemory
    }),
    cpu: Object.freeze({
      vendorId: gate.cpu.vendorId,
      model: gate.cpu.modelName,
      logicalProcessorCount: gate.cpu.logicalCpuCount,
      onlineCpuList: gate.cpu.onlineCpuList,
      affinity: Object.freeze([...gate.cpu.pinnedCpuIds]),
      governors: Object.freeze(
        gate.power.governors.map((entry) => Object.freeze({ processor: entry.cpuId, governor: entry.governor }))
      )
    }),
    power: Object.freeze({ source: "ac" }),
    storage: Object.freeze({
      deviceModel: model,
      deviceIdentitySha256: digest(storageIdentity),
      filesystemType: mount.filesystemType,
      mountOptionsSha256: digest(mountIdentity),
      fixtureVolumeIdentitySha256: digest({
        device: fixture.dev.toString(),
        filesystemType: mount.filesystemType,
        filesystemBlockSize: filesystem.bsize.toString(),
        filesystemBlocks: filesystem.blocks.toString()
      }),
      rotational: rotationalText === "1"
    }),
    display: Object.freeze({ ...display }),
    zoom: Object.freeze({ ...zoom })
  });
}
