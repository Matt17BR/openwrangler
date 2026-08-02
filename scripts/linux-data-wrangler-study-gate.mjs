import { readFileSync, readdirSync } from "node:fs";
import { arch, release } from "node:os";
import { performance } from "node:perf_hooks";

export const LINUX_DATA_WRANGLER_STUDY_PROVENANCE_PROTOCOL = "openwrangler-linux-data-wrangler-study-provenance-v1";
export const LINUX_DATA_WRANGLER_STUDY_GATE_PROTOCOL = "openwrangler-linux-data-wrangler-study-gate-v1";
export const LINUX_DATA_WRANGLER_STUDY_GATE_SELECTION_POLICY =
  "accept the first complete passing window and retain every attempted window";
export const LINUX_DATA_WRANGLER_STUDY_GATE_THRESHOLDS = Object.freeze({
  windowMs: 10_000,
  intervalMs: 1_000,
  maximumMeanNonIdleCpuPercent: 10,
  maximumOneSecondNonIdleCpuPercent: 25,
  maximumCpuSomeAvg10Percent: 1,
  maximumMemoryFullAvg10Percent: 0,
  maximumSwapPageDelta: 0,
  maximumThermalThrottleDelta: 0,
  requireExactAcPowerState: true,
  requireExactGovernorSet: true,
  requireExactAffinity: true,
  maximumSampleLatenessMs: 250
});

const PROC_STAT = "/proc/stat";
const PROC_CPUINFO = "/proc/cpuinfo";
const PROC_PRESSURE_CPU = "/proc/pressure/cpu";
const PROC_PRESSURE_MEMORY = "/proc/pressure/memory";
const PROC_VMSTAT = "/proc/vmstat";
const PROC_SELF_STATUS = "/proc/self/status";
const SYS_CPU_ROOT = "/sys/devices/system/cpu";
const SYS_POWER_SUPPLY_ROOT = "/sys/class/power_supply";
const EXTERNAL_POWER_TYPES = new Set(["Mains", "USB", "USB_C", "USB_PD", "Wireless"]);
const THERMAL_COUNTER_FILES = Object.freeze({
  core: "core_throttle_count",
  package: "package_throttle_count"
});
export const LINUX_DATA_WRANGLER_STUDY_GATE_FAILURE_CODES = Object.freeze([
  "sampling-unavailable",
  "sample-timing",
  "provenance-drift",
  "cpu-mean",
  "cpu-window",
  "cpu-pressure",
  "memory-pressure",
  "swap-activity",
  "thermal-throttle",
  "ac-power-drift",
  "governor-drift",
  "affinity-drift"
]);
export const LINUX_DATA_WRANGLER_STUDY_GATE_TERMINAL_FAILURE_CODES = Object.freeze(["deadline-no-complete-window"]);

function defaultDependencies() {
  return {
    platform: process.platform,
    architecture: () => arch(),
    kernelRelease: () => release(),
    environment: process.env,
    readText: (path) => readFileSync(path, "utf8"),
    readDirectory: (path) => readdirSync(path),
    clock: () => performance.now(),
    wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
  };
}

function dependencies(overrides = {}) {
  return { ...defaultDependencies(), ...overrides };
}

function fail(message) {
  throw new TypeError(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected, label) {
  if (!isRecord(value)) {
    fail(`${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} has missing or unknown fields.`);
  }
}

function boundedString(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || /[\0\r\n]/u.test(value)) {
    fail(`${label} must be one bounded single-line string.`);
  }
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalJson);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalJson(value[key])])
    );
  }
  return value;
}

function sameValue(left, right) {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

export function parseLinuxCpuList(text) {
  if (
    typeof text !== "string" ||
    text.length === 0 ||
    text.length > 4096 ||
    !/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/u.test(text)
  ) {
    fail("Linux CPU list is invalid.");
  }
  const values = new Set();
  for (const part of text.split(",")) {
    const [firstText, lastText = firstText] = part.split("-");
    const first = Number(firstText);
    const last = Number(lastText);
    nonNegativeInteger(first, "Linux CPU list start");
    nonNegativeInteger(last, "Linux CPU list end");
    if (last < first || last - first > 65_535) {
      fail("Linux CPU list range is invalid or unreasonably large.");
    }
    for (let value = first; value <= last; value += 1) {
      if (values.has(value)) {
        fail("Linux CPU list contains an overlapping processor.");
      }
      values.add(value);
    }
  }
  return [...values].sort((left, right) => left - right);
}

export function formatLinuxCpuList(cpuIds) {
  validateCpuIds(cpuIds);
  const ranges = [];
  let first = cpuIds[0];
  let last = first;
  for (const value of cpuIds.slice(1)) {
    if (value === last + 1) {
      last = value;
      continue;
    }
    ranges.push(first === last ? `${first}` : `${first}-${last}`);
    first = value;
    last = value;
  }
  ranges.push(first === last ? `${first}` : `${first}-${last}`);
  return ranges.join(",");
}

function validateCpuIds(cpuIds) {
  if (!Array.isArray(cpuIds) || cpuIds.length === 0 || cpuIds.length > 4096) {
    fail("Linux study provenance requires one bounded non-empty CPU list.");
  }
  let previous = -1;
  for (const cpuId of cpuIds) {
    nonNegativeInteger(cpuId, "Linux study CPU ID");
    if (cpuId <= previous) {
      fail("Linux study CPU IDs must be unique and strictly increasing.");
    }
    previous = cpuId;
  }
  return cpuIds;
}

function validateDisplayConfiguration(display) {
  exactKeys(display, ["mode", "width", "height", "scaleFactor", "zoomLevel", "theme"], "Study display configuration");
  if (display.mode !== "headless-ozone") {
    fail("Study display mode must be headless-ozone.");
  }
  for (const key of ["width", "height"]) {
    if (!Number.isSafeInteger(display[key]) || display[key] <= 0 || display[key] > 16_384) {
      fail(`Study display ${key} is invalid.`);
    }
  }
  if (typeof display.scaleFactor !== "number" || !Number.isFinite(display.scaleFactor) || display.scaleFactor <= 0) {
    fail("Study display scale factor is invalid.");
  }
  if (typeof display.zoomLevel !== "number" || !Number.isFinite(display.zoomLevel)) {
    fail("Study display zoom level is invalid.");
  }
  boundedString(display.theme, "Study display theme");
  return display;
}

function normalizeSingleLine(text, label) {
  return boundedString(String(text).trim(), label);
}

function readCpuInfo(readText) {
  const records = readText(PROC_CPUINFO)
    .trim()
    .split(/\n\s*\n/u)
    .filter(Boolean)
    .map(
      (section) =>
        new Map(
          section.split("\n").map((line) => {
            const separator = line.indexOf(":");
            if (separator <= 0) {
              fail("Linux CPU information contains a malformed field.");
            }
            return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
          })
        )
    );
  if (records.length === 0) {
    fail("Linux CPU information is empty.");
  }
  const processors = records.map((record) => Number(record.get("processor")));
  validateCpuIds(processors);
  const vendors = new Set(records.map((record) => record.get("vendor_id")));
  const models = new Set(records.map((record) => record.get("model name")));
  if (vendors.size !== 1 || models.size !== 1 || vendors.has(undefined) || models.has(undefined)) {
    fail("Linux study CPUs must expose one exact vendor and model.");
  }
  return {
    vendorId: normalizeSingleLine([...vendors][0], "Linux CPU vendor"),
    modelName: normalizeSingleLine([...models][0], "Linux CPU model"),
    logicalCpuCount: processors.length,
    processorIds: processors
  };
}

function readAffinity(readText) {
  const match = /^Cpus_allowed_list:\s*(\S+)\s*$/mu.exec(readText(PROC_SELF_STATUS));
  if (match === null) {
    fail("Linux process affinity is unavailable.");
  }
  return formatLinuxCpuList(parseLinuxCpuList(match[1]));
}

function governorPath(cpuId) {
  return `${SYS_CPU_ROOT}/cpu${cpuId}/cpufreq/scaling_governor`;
}

function thermalDirectory(cpuId) {
  return `${SYS_CPU_ROOT}/cpu${cpuId}/thermal_throttle`;
}

function thermalPath(counter) {
  return `${thermalDirectory(counter.cpuId)}/${THERMAL_COUNTER_FILES[counter.kind]}`;
}

function readGovernors(cpuIds, readText) {
  return cpuIds.map((cpuId) => ({
    cpuId,
    governor: normalizeSingleLine(readText(governorPath(cpuId)), `Linux cpu${cpuId} governor`)
  }));
}

function discoverThermalCounters(cpuIds, readDirectory) {
  const counters = [];
  for (const cpuId of cpuIds) {
    let entries;
    try {
      entries = readDirectory(thermalDirectory(cpuId));
    } catch (error) {
      if (error?.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    const available = new Set(entries);
    for (const kind of ["core", "package"]) {
      if (available.has(THERMAL_COUNTER_FILES[kind])) {
        counters.push({ id: `cpu${cpuId}-${kind}`, cpuId, kind });
      }
    }
  }
  if (counters.length === 0) {
    fail("Linux thermal-throttle counters are unavailable for the pinned CPUs.");
  }
  return counters;
}

function readExternalPower(readDirectory, readText, { requireOnline = true } = {}) {
  const supplies = [];
  for (const name of [...readDirectory(SYS_POWER_SUPPLY_ROOT)].sort()) {
    if (!/^[A-Za-z0-9_.:+-]{1,128}$/u.test(name)) {
      fail("Linux power-supply name is invalid.");
    }
    const type = normalizeSingleLine(readText(`${SYS_POWER_SUPPLY_ROOT}/${name}/type`), "Linux power-supply type");
    if (!EXTERNAL_POWER_TYPES.has(type)) {
      continue;
    }
    const onlineText = String(readText(`${SYS_POWER_SUPPLY_ROOT}/${name}/online`)).trim();
    if (onlineText !== "0" && onlineText !== "1") {
      fail("Linux external-power state is invalid.");
    }
    supplies.push({ name, type, online: onlineText === "1" });
  }
  if (supplies.length === 0 || (requireOnline && !supplies.some((supply) => supply.online))) {
    fail("The Linux study requires one observable online external-power supply.");
  }
  return supplies;
}

function displayProvenance(configuration, environment) {
  return {
    ...structuredClone(configuration),
    hostEnvironment: {
      displaySet: Boolean(environment.DISPLAY),
      waylandDisplaySet: Boolean(environment.WAYLAND_DISPLAY),
      xdgSessionTypeSet: Boolean(environment.XDG_SESSION_TYPE)
    }
  };
}

export function captureLinuxDataWranglerStudyProvenance({ cpuIds, display }, dependencyOverrides = {}) {
  const deps = dependencies(dependencyOverrides);
  if (deps.platform !== "linux") {
    fail("The Data Wrangler study gate requires Linux.");
  }
  validateCpuIds(cpuIds);
  validateDisplayConfiguration(display);
  const cpuInfo = readCpuInfo(deps.readText);
  if (cpuIds.some((cpuId) => !cpuInfo.processorIds.includes(cpuId))) {
    fail("A pinned study CPU is absent from Linux CPU information.");
  }
  const onlineCpuIds = parseLinuxCpuList(String(deps.readText(`${SYS_CPU_ROOT}/online`)).trim());
  if (cpuIds.some((cpuId) => !onlineCpuIds.includes(cpuId))) {
    fail("A pinned study CPU is offline.");
  }
  const affinityCpuList = readAffinity(deps.readText);
  if (affinityCpuList !== formatLinuxCpuList(cpuIds)) {
    fail("The gate process affinity does not match the pinned study CPUs.");
  }
  const provenance = {
    protocol: LINUX_DATA_WRANGLER_STUDY_PROVENANCE_PROTOCOL,
    platform: "linux",
    architecture: boundedString(deps.architecture(), "Linux architecture"),
    kernelRelease: boundedString(deps.kernelRelease(), "Linux kernel release"),
    cpu: {
      vendorId: cpuInfo.vendorId,
      modelName: cpuInfo.modelName,
      logicalCpuCount: cpuInfo.logicalCpuCount,
      onlineCpuList: formatLinuxCpuList(onlineCpuIds),
      pinnedCpuIds: [...cpuIds]
    },
    affinity: { cpuList: affinityCpuList },
    power: {
      externalSupplies: readExternalPower(deps.readDirectory, deps.readText),
      governors: readGovernors(cpuIds, deps.readText),
      thermalThrottleCounters: discoverThermalCounters(cpuIds, deps.readDirectory)
    },
    display: displayProvenance(display, deps.environment)
  };
  assertPathFree(provenance);
  return provenance;
}

function assertPathFree(value) {
  if (Array.isArray(value)) {
    value.forEach(assertPathFree);
    return;
  }
  if (isRecord(value)) {
    Object.values(value).forEach(assertPathFree);
    return;
  }
  if (typeof value === "string" && (value.startsWith("/") || /(?:^|\s)file:\/\//u.test(value))) {
    fail("Linux study provenance must not contain filesystem paths.");
  }
}

function parseCounter(text, label) {
  const value = String(text).trim();
  if (!/^\d+$/u.test(value)) {
    fail(`${label} is invalid.`);
  }
  return BigInt(value);
}

function readCpuCounters(cpuIds, readText) {
  const wanted = new Set(cpuIds.map((cpuId) => `cpu${cpuId}`));
  const counters = new Map();
  for (const line of readText(PROC_STAT).split("\n")) {
    const fields = line.trim().split(/\s+/u);
    if (!wanted.has(fields[0])) {
      continue;
    }
    if (counters.has(fields[0]) || fields.length < 9 || fields.slice(1, 9).some((field) => !/^\d+$/u.test(field))) {
      fail("Linux per-CPU counters are malformed or duplicated.");
    }
    const values = fields.slice(1, 9).map(BigInt);
    const idle = values[3] + values[4];
    const total = values.reduce((sum, value) => sum + value, 0n);
    counters.set(fields[0], { idle, total });
  }
  if (counters.size !== wanted.size) {
    fail("Linux per-CPU counters do not contain every pinned cpuN line.");
  }
  return cpuIds.map((cpuId) => ({ cpuId, ...counters.get(`cpu${cpuId}`) }));
}

function cpuPercent(before, after) {
  let busyDelta = 0n;
  let totalDelta = 0n;
  for (let index = 0; index < before.length; index += 1) {
    if (before[index].cpuId !== after[index].cpuId) {
      fail("Pinned CPU ordering changed during a gate window.");
    }
    const total = after[index].total - before[index].total;
    const idle = after[index].idle - before[index].idle;
    if (total <= 0n || idle < 0n || idle > total) {
      fail("Linux per-CPU counters reset or did not advance during a gate interval.");
    }
    totalDelta += total;
    busyDelta += total - idle;
  }
  return (Number(busyDelta) / Number(totalDelta)) * 100;
}

function pressureValue(text, row, field) {
  const line = text.split("\n").find((candidate) => candidate.startsWith(`${row} `));
  if (line === undefined) {
    fail(`Linux ${row} pressure information is unavailable.`);
  }
  const match = new RegExp(`(?:^|\\s)${field}=([0-9]+(?:\\.[0-9]+)?)`, "u").exec(line);
  if (match === null) {
    fail(`Linux ${row} pressure ${field} is unavailable.`);
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0) {
    fail(`Linux ${row} pressure ${field} is invalid.`);
  }
  return value;
}

function vmstatCounters(readText) {
  const values = new Map();
  for (const line of readText(PROC_VMSTAT).split("\n")) {
    const match = /^(pswpin|pswpout)\s+(\d+)$/u.exec(line.trim());
    if (match !== null) {
      values.set(match[1], BigInt(match[2]));
    }
  }
  if (values.size !== 2) {
    fail("Linux swap counters are unavailable.");
  }
  return { pagesIn: values.get("pswpin"), pagesOut: values.get("pswpout") };
}

function readThermalCounters(counterDefinitions, readText) {
  return counterDefinitions.map((counter) => ({
    ...counter,
    value: parseCounter(readText(thermalPath(counter)), `Linux ${counter.id} thermal counter`)
  }));
}

function captureSnapshot(expectedProvenance, deps) {
  return {
    capturedAtMs: deps.clock(),
    cpuCounters: readCpuCounters(expectedProvenance.cpu.pinnedCpuIds, deps.readText),
    cpuSomeAvg10Percent: pressureValue(deps.readText(PROC_PRESSURE_CPU), "some", "avg10"),
    memoryFullAvg10Percent: pressureValue(deps.readText(PROC_PRESSURE_MEMORY), "full", "avg10"),
    swap: vmstatCounters(deps.readText),
    thermal: readThermalCounters(expectedProvenance.power.thermalThrottleCounters, deps.readText),
    externalSupplies: readExternalPower(deps.readDirectory, deps.readText, { requireOnline: false }),
    governors: readGovernors(expectedProvenance.cpu.pinnedCpuIds, deps.readText),
    affinityCpuList: readAffinity(deps.readText)
  };
}

function counterDelta(before, after, label) {
  const delta = after - before;
  if (delta < 0n || delta > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail(`${label} reset or exceeded the safe integer range.`);
  }
  return Number(delta);
}

function thermalDeltas(before, after) {
  return before.map((counter, index) => {
    const completed = after[index];
    if (counter.id !== completed?.id) {
      fail("Linux thermal-counter ordering changed during a gate window.");
    }
    return {
      id: counter.id,
      delta: counterDelta(counter.value, completed.value, `Linux ${counter.id} thermal counter`)
    };
  });
}

function aggregateCounterDeltas(snapshots) {
  if (snapshots.some((snapshot) => snapshot === null)) {
    return null;
  }
  const swap = { pagesIn: 0, pagesOut: 0 };
  const thermal = snapshots[0].thermal.map((counter) => ({ id: counter.id, delta: 0 }));
  for (let index = 1; index < snapshots.length; index += 1) {
    const before = snapshots[index - 1];
    const after = snapshots[index];
    swap.pagesIn += counterDelta(before.swap.pagesIn, after.swap.pagesIn, "Linux swap-in counter");
    swap.pagesOut += counterDelta(before.swap.pagesOut, after.swap.pagesOut, "Linux swap-out counter");
    const intervalThermal = thermalDeltas(before.thermal, after.thermal);
    for (let counterIndex = 0; counterIndex < thermal.length; counterIndex += 1) {
      thermal[counterIndex].delta += intervalThermal[counterIndex].delta;
      if (!Number.isSafeInteger(thermal[counterIndex].delta)) {
        fail("Linux thermal-throttle delta exceeded the safe integer range.");
      }
    }
  }
  if (!Number.isSafeInteger(swap.pagesIn) || !Number.isSafeInteger(swap.pagesOut)) {
    fail("Linux swap delta exceeded the safe integer range.");
  }
  return { swap, thermal };
}

function stateMatches(snapshot, expectedProvenance) {
  return {
    acPower: sameValue(snapshot.externalSupplies, expectedProvenance.power.externalSupplies),
    governors: sameValue(snapshot.governors, expectedProvenance.power.governors),
    affinity: snapshot.affinityCpuList === expectedProvenance.affinity.cpuList
  };
}

function unavailableInterval(index, elapsedMs, durationMs) {
  return {
    index,
    elapsedMs,
    durationMs,
    nonIdleCpuPercent: null,
    cpuSomeAvg10Percent: null,
    memoryFullAvg10Percent: null,
    acPowerMatched: false,
    governorsMatched: false,
    affinityMatched: false,
    available: false
  };
}

function sortFailures(failures) {
  return [...failures].sort(
    (left, right) =>
      LINUX_DATA_WRANGLER_STUDY_GATE_FAILURE_CODES.indexOf(left) -
      LINUX_DATA_WRANGLER_STUDY_GATE_FAILURE_CODES.indexOf(right)
  );
}

export async function captureLinuxDataWranglerStudyGateWindow(
  { expectedProvenance, attempt = 1, provenanceMatched = true },
  dependencyOverrides = {}
) {
  const pinnedProvenance = structuredClone(expectedProvenance);
  validateExpectedProvenance(pinnedProvenance);
  nonNegativeInteger(attempt, "Linux study gate attempt");
  if (attempt < 1) {
    fail("Linux study gate attempt must be at least one.");
  }
  const deps = dependencies(dependencyOverrides);
  const thresholds = LINUX_DATA_WRANGLER_STUDY_GATE_THRESHOLDS;
  const startedAtMs = deps.clock();
  const snapshots = [];
  const intervals = [];
  const failures = new Set(provenanceMatched ? [] : ["provenance-drift"]);
  try {
    snapshots.push(captureSnapshot(pinnedProvenance, deps));
  } catch {
    snapshots.push(null);
    failures.add("sampling-unavailable");
  }
  for (let index = 1; index <= thresholds.windowMs / thresholds.intervalMs; index += 1) {
    const target = startedAtMs + index * thresholds.intervalMs;
    await deps.wait(Math.max(0, target - deps.clock()));
    let snapshot;
    try {
      snapshot = captureSnapshot(pinnedProvenance, deps);
    } catch {
      snapshot = null;
      failures.add("sampling-unavailable");
    }
    snapshots.push(snapshot);
    const before = snapshots[index - 1];
    const capturedAtMs = snapshot?.capturedAtMs ?? deps.clock();
    const previousAtMs = before?.capturedAtMs ?? startedAtMs + (index - 1) * thresholds.intervalMs;
    const elapsedMs = Math.max(0, capturedAtMs - startedAtMs);
    const durationMs = Math.max(0, capturedAtMs - previousAtMs);
    if (snapshot === null || before === null) {
      intervals.push(unavailableInterval(index, elapsedMs, durationMs));
      continue;
    }
    try {
      const states = stateMatches(snapshot, pinnedProvenance);
      intervals.push({
        index,
        elapsedMs,
        durationMs,
        nonIdleCpuPercent: cpuPercent(before.cpuCounters, snapshot.cpuCounters),
        cpuSomeAvg10Percent: snapshot.cpuSomeAvg10Percent,
        memoryFullAvg10Percent: snapshot.memoryFullAvg10Percent,
        acPowerMatched: states.acPower,
        governorsMatched: states.governors,
        affinityMatched: states.affinity,
        available: true
      });
    } catch {
      failures.add("sampling-unavailable");
      intervals.push(unavailableInterval(index, elapsedMs, durationMs));
    }
  }

  const available = intervals.filter((interval) => interval.available);
  let swap = null;
  let thermal = null;
  try {
    const deltas = aggregateCounterDeltas(snapshots);
    swap = deltas?.swap ?? null;
    thermal = deltas?.thermal ?? null;
  } catch {
    failures.add("sampling-unavailable");
  }
  const meanCpuPercent =
    available.length === intervals.length
      ? available.reduce((sum, interval) => sum + interval.nonIdleCpuPercent, 0) / available.length
      : null;
  const maximumCpuPercent =
    available.length === intervals.length ? Math.max(...available.map((interval) => interval.nonIdleCpuPercent)) : null;
  const pressureSnapshots = snapshots.filter((snapshot) => snapshot !== null);
  const maximumCpuSomeAvg10Percent =
    pressureSnapshots.length === snapshots.length
      ? Math.max(...pressureSnapshots.map((snapshot) => snapshot.cpuSomeAvg10Percent))
      : null;
  const maximumMemoryFullAvg10Percent =
    pressureSnapshots.length === snapshots.length
      ? Math.max(...pressureSnapshots.map((snapshot) => snapshot.memoryFullAvg10Percent))
      : null;
  const completedAtMs = deps.clock();
  const durationMs = Math.max(0, completedAtMs - startedAtMs);
  const acPowerMatched = intervals.every((interval) => interval.available && interval.acPowerMatched);
  const governorsMatched = intervals.every((interval) => interval.available && interval.governorsMatched);
  const affinityMatched = intervals.every((interval) => interval.available && interval.affinityMatched);

  if (
    intervals.some(
      (interval) =>
        interval.durationMs < thresholds.intervalMs - thresholds.maximumSampleLatenessMs ||
        interval.durationMs > thresholds.intervalMs + thresholds.maximumSampleLatenessMs
    ) ||
    durationMs < thresholds.windowMs ||
    durationMs > thresholds.windowMs + thresholds.maximumSampleLatenessMs
  ) {
    failures.add("sample-timing");
  }
  if (meanCpuPercent !== null && meanCpuPercent > thresholds.maximumMeanNonIdleCpuPercent) failures.add("cpu-mean");
  if (maximumCpuPercent !== null && maximumCpuPercent > thresholds.maximumOneSecondNonIdleCpuPercent)
    failures.add("cpu-window");
  if (maximumCpuSomeAvg10Percent !== null && maximumCpuSomeAvg10Percent > thresholds.maximumCpuSomeAvg10Percent)
    failures.add("cpu-pressure");
  if (
    maximumMemoryFullAvg10Percent !== null &&
    maximumMemoryFullAvg10Percent > thresholds.maximumMemoryFullAvg10Percent
  )
    failures.add("memory-pressure");
  if (swap !== null && swap.pagesIn + swap.pagesOut > thresholds.maximumSwapPageDelta) failures.add("swap-activity");
  if (thermal !== null && thermal.some((counter) => counter.delta > thresholds.maximumThermalThrottleDelta))
    failures.add("thermal-throttle");
  if (intervals.some((interval) => interval.available && !interval.acPowerMatched)) failures.add("ac-power-drift");
  if (intervals.some((interval) => interval.available && !interval.governorsMatched)) failures.add("governor-drift");
  if (intervals.some((interval) => interval.available && !interval.affinityMatched)) failures.add("affinity-drift");

  const failureCodes = sortFailures(failures);
  return {
    attempt,
    startedAtOffsetMs: 0,
    durationMs,
    passed: failureCodes.length === 0,
    failureCodes,
    summary: {
      cpuIds: [...pinnedProvenance.cpu.pinnedCpuIds],
      meanNonIdleCpuPercent: meanCpuPercent,
      maximumOneSecondNonIdleCpuPercent: maximumCpuPercent,
      maximumCpuSomeAvg10Percent,
      maximumMemoryFullAvg10Percent,
      swapPageDelta: swap,
      thermalThrottleDeltas: thermal,
      acPowerMatched,
      governorsMatched,
      affinityMatched
    },
    intervals
  };
}

function validateExpectedProvenance(provenance) {
  if (!isRecord(provenance) || provenance.protocol !== LINUX_DATA_WRANGLER_STUDY_PROVENANCE_PROTOCOL) {
    fail("Linux study gate expected provenance is invalid.");
  }
  validateCpuIds(provenance.cpu?.pinnedCpuIds);
  if (
    !Array.isArray(provenance.power?.thermalThrottleCounters) ||
    provenance.power.thermalThrottleCounters.length === 0
  ) {
    fail("Linux study gate expected thermal counters are invalid.");
  }
  assertPathFree(provenance);
  return provenance;
}

function provenanceCaptureOptions(expectedProvenance) {
  const { hostEnvironment: _hostEnvironment, ...display } = expectedProvenance.display;
  return { cpuIds: expectedProvenance.cpu.pinnedCpuIds, display };
}

export async function runLinuxDataWranglerStudyGate(
  { expectedProvenance, maximumWaitMs = 300_000 },
  dependencyOverrides = {}
) {
  const pinnedProvenance = structuredClone(expectedProvenance);
  validateExpectedProvenance(pinnedProvenance);
  if (
    !Number.isSafeInteger(maximumWaitMs) ||
    maximumWaitMs < LINUX_DATA_WRANGLER_STUDY_GATE_THRESHOLDS.windowMs ||
    maximumWaitMs > 300_000
  ) {
    fail("Linux study gate maximum wait must be between 10 seconds and five minutes.");
  }
  const deps = dependencies(dependencyOverrides);
  const attempts = [];
  const runStartedAtMs = deps.clock();
  const deadlineMs = runStartedAtMs + maximumWaitMs;
  const completeWindowBudgetMs =
    LINUX_DATA_WRANGLER_STUDY_GATE_THRESHOLDS.windowMs +
    LINUX_DATA_WRANGLER_STUDY_GATE_THRESHOLDS.maximumSampleLatenessMs;
  let terminalFailure = null;
  for (let attempt = 1; ; attempt += 1) {
    if (deps.clock() + completeWindowBudgetMs > deadlineMs) {
      terminalFailure = "deadline-no-complete-window";
      break;
    }
    let observedProvenance;
    try {
      observedProvenance = captureLinuxDataWranglerStudyProvenance(provenanceCaptureOptions(pinnedProvenance), deps);
    } catch {
      observedProvenance = null;
    }
    if (deps.clock() + completeWindowBudgetMs > deadlineMs) {
      terminalFailure = "deadline-no-complete-window";
      break;
    }
    const windowStartedAtMs = deps.clock();
    const window = await captureLinuxDataWranglerStudyGateWindow(
      {
        expectedProvenance: pinnedProvenance,
        attempt,
        provenanceMatched: observedProvenance !== null && sameValue(observedProvenance, pinnedProvenance)
      },
      deps
    );
    window.startedAtOffsetMs = Math.max(0, windowStartedAtMs - runStartedAtMs);
    const deadlineExceeded = deps.clock() > deadlineMs;
    if (deadlineExceeded) {
      window.passed = false;
      window.failureCodes = sortFailures(new Set([...window.failureCodes, "sample-timing"]));
      terminalFailure = "deadline-no-complete-window";
    }
    attempts.push(window);
    if (deadlineExceeded) {
      break;
    }
    if (window.passed) {
      break;
    }
  }
  const accepted = attempts.find((attempt) => attempt.passed);
  const result = {
    protocol: LINUX_DATA_WRANGLER_STUDY_GATE_PROTOCOL,
    selectionPolicy: LINUX_DATA_WRANGLER_STUDY_GATE_SELECTION_POLICY,
    thresholds: { ...LINUX_DATA_WRANGLER_STUDY_GATE_THRESHOLDS },
    provenance: pinnedProvenance,
    maximumWaitMs,
    waitMs: Math.max(0, deps.clock() - runStartedAtMs),
    acceptedAttempt: accepted?.attempt ?? null,
    passed: accepted !== undefined,
    terminalFailure: accepted === undefined ? terminalFailure : null,
    attempts
  };
  assertPathFree(result);
  return result;
}
