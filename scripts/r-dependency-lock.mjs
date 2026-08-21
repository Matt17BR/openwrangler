import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync
} from "node:fs";
import { request } from "node:https";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { parseStrictJson } from "./strict-json.mjs";

export const LOCK_PROTOCOL = "openwrangler-native-r-dependency-lock-v2";
export const LOCK_RESOLVER_VERSION = "2";
export const LOCK_PURPOSE = "native-r-contract";
export const LOCK_ROOTS = Object.freeze({
  runtime: Object.freeze(["jsonlite", "tibble", "readr", "dplyr", "data.table", "bit64", "rlang", "nanoparquet"]),
  fixtures: Object.freeze(["collapse"])
});
export const NATIVE_R_CANDIDATE_PACKAGE_SPECS = Object.freeze(
  [...LOCK_ROOTS.runtime, ...LOCK_ROOTS.fixtures].map((name) => `any::${name}`)
);
export const NATIVE_R_CANDIDATE_CACHE_VERSION = `native-r-contract-v${LOCK_RESOLVER_VERSION}`;
export const SNAPSHOT_DATE = "2026-08-14";
export const SNAPSHOT_HOST = "packagemanager.posit.co";
export const LOCK_LIMITS = Object.freeze({
  archiveBytes: 64 * 1024 * 1024,
  aggregateArchiveBytes: 512 * 1024 * 1024,
  installedFileBytes: 128 * 1024 * 1024,
  installedTreeBytes: 1024 * 1024 * 1024,
  installedTreeEntries: 100_000,
  packages: 64,
  textBytes: 512 * 1024
});

const BASE_AND_RECOMMENDED_R = new Set([
  "R",
  "base",
  "boot",
  "class",
  "cluster",
  "codetools",
  "compiler",
  "datasets",
  "foreign",
  "graphics",
  "grDevices",
  "grid",
  "KernSmooth",
  "lattice",
  "MASS",
  "Matrix",
  "methods",
  "mgcv",
  "nlme",
  "nnet",
  "parallel",
  "rpart",
  "spatial",
  "splines",
  "stats",
  "stats4",
  "survival",
  "tcltk",
  "tools",
  "utils"
]);
const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9.]*$/u;
const VERSION = /^[0-9][A-Za-z0-9.+-]*$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const R_MINOR = /^4\.[45]$/u;
const SAFE_SYSTEM_PACKAGE = /^[a-z0-9][a-z0-9+.-]*$/u;
const SAFE_TEXT = /^[^\0\r\n]+$/u;
const ROOT_KEYS = Object.freeze(["runtime", "fixtures"]);
const LOCK_KEYS = Object.freeze([
  "protocol",
  "purpose",
  "qualification",
  "resolver",
  "roots",
  "packages",
  "systemRequirements"
]);
const QUALIFICATION_KEYS = Object.freeze([
  "rMinor",
  "generatedWithRVersion",
  "os",
  "distribution",
  "distributionVersion",
  "architecture",
  "rPlatform"
]);
const RESOLVER_KEYS = Object.freeze(["name", "exactVersion", "repositorySnapshotUrl", "snapshotDate"]);
const PACKAGE_KEYS = Object.freeze([
  "name",
  "version",
  "direct",
  "needsCompilation",
  "license",
  "dependencies",
  "source"
]);
const DEPENDENCY_KEYS = Object.freeze(["depends", "imports", "linkingTo"]);
const SOURCE_KEYS = Object.freeze(["kind", "repositorySnapshotUrl", "url", "bytes", "sha256"]);

function exactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} keys must be exactly ${expected.join(", ")} in canonical order.`);
  }
}

function requireText(value, label, maximumBytes = 4096) {
  if (typeof value !== "string" || !SAFE_TEXT.test(value) || Buffer.byteLength(value) > maximumBytes) {
    throw new Error(`${label} must be bounded single-line text.`);
  }
  return value;
}

function requireSortedUnique(values, label, predicate = () => true) {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array.`);
  const sorted = [...values].sort();
  if (values.some((value, index) => value !== sorted[index]) || new Set(values).size !== values.length) {
    throw new Error(`${label} must be sorted and unique.`);
  }
  if (values.some((value) => typeof value !== "string" || !predicate(value))) {
    throw new Error(`${label} contains an invalid value.`);
  }
}

export function canonicalLockBytes(lock) {
  return `${JSON.stringify(lock, null, 2)}\n`;
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function repositoryUrl(rMinor) {
  return `https://${SNAPSHOT_HOST}/cran/${SNAPSHOT_DATE}/bin/linux/noble-x86_64/${rMinor}/src/contrib`;
}

function validateSnapshotUrl(value, rMinor, { archive = false, name, version } = {}) {
  const text = requireText(value, "snapshot URL", 2048);
  const url = new URL(text);
  if (
    url.protocol !== "https:" ||
    url.hostname !== SNAPSHOT_HOST ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.port !== ""
  ) {
    throw new Error(`Snapshot URL is not an exact allowed HTTPS URL: ${text}`);
  }
  const base = repositoryUrl(rMinor);
  const expected = archive ? `${base}/${name}_${version}.tar.gz` : base;
  if (text !== expected || text.includes("/latest/")) {
    throw new Error(`Snapshot URL is not bound to the exact dated R ${rMinor} repository.`);
  }
  return text;
}

function validateQualification(value) {
  exactKeys(value, QUALIFICATION_KEYS, "qualification");
  if (!R_MINOR.test(value.rMinor)) throw new Error("qualification.rMinor must be 4.4 or 4.5.");
  if (!new RegExp(`^${value.rMinor.replace(".", "\\.")}\\.[0-9]+$`, "u").test(value.generatedWithRVersion)) {
    throw new Error("qualification.generatedWithRVersion must be a full patch in the selected R minor.");
  }
  if (
    value.os !== "linux" ||
    value.distribution !== "ubuntu" ||
    value.distributionVersion !== "24.04" ||
    value.architecture !== "x86_64" ||
    value.rPlatform !== "x86_64-pc-linux-gnu"
  ) {
    throw new Error("qualification must select Ubuntu 24.04 x86_64 and its exact R platform.");
  }
}

function validateResolver(value, rMinor) {
  exactKeys(value, RESOLVER_KEYS, "resolver");
  if (value.name !== "openwrangler-r-dependency-lock" || value.exactVersion !== LOCK_RESOLVER_VERSION) {
    throw new Error(`resolver must select the repository-owned version ${LOCK_RESOLVER_VERSION} resolver.`);
  }
  if (value.snapshotDate !== SNAPSHOT_DATE) throw new Error("resolver snapshot date is not the approved date.");
  validateSnapshotUrl(value.repositorySnapshotUrl, rMinor);
}

function validateRootCategories(value) {
  exactKeys(value, ROOT_KEYS, "roots");
  for (const category of ROOT_KEYS) {
    if (!Array.isArray(value[category])) throw new Error(`roots.${category} must be an array.`);
    if (value[category].some((name) => typeof name !== "string" || !PACKAGE_NAME.test(name))) {
      throw new Error(`roots.${category} contains an invalid package name.`);
    }
    if (new Set(value[category]).size !== value[category].length) {
      throw new Error(`roots.${category} must not contain duplicate packages.`);
    }
  }
  if (value.runtime.some((name) => value.fixtures.includes(name))) {
    throw new Error("Runtime and fixture roots must be disjoint.");
  }
  if (JSON.stringify(value) !== JSON.stringify(LOCK_ROOTS)) {
    throw new Error("R dependency roots must be the exact ordered runtime and fixture roots.");
  }
  return [...value.runtime, ...value.fixtures];
}

function validateDependencies(value, packageNames, packageName) {
  exactKeys(value, DEPENDENCY_KEYS, `${packageName}.dependencies`);
  for (const key of DEPENDENCY_KEYS) {
    requireSortedUnique(value[key], `${packageName}.dependencies.${key}`, (name) => PACKAGE_NAME.test(name));
    for (const dependency of value[key]) {
      if (!packageNames.has(dependency) && !BASE_AND_RECOMMENDED_R.has(dependency)) {
        throw new Error(`${packageName} has an unlocked hard dependency on ${dependency}.`);
      }
    }
  }
}

function topologicalPackages(packages) {
  const byName = new Map(packages.map((entry) => [entry.name, entry]));
  const visiting = new Set();
  const visited = new Set();
  const order = [];
  function visit(name) {
    if (visited.has(name) || BASE_AND_RECOMMENDED_R.has(name)) return;
    if (visiting.has(name)) throw new Error(`R dependency lock contains a cycle at ${name}.`);
    const entry = byName.get(name);
    if (!entry) throw new Error(`R dependency lock is missing ${name}.`);
    visiting.add(name);
    for (const dependency of DEPENDENCY_KEYS.flatMap((key) => entry.dependencies[key])) visit(dependency);
    visiting.delete(name);
    visited.add(name);
    order.push(entry);
  }
  for (const entry of packages) visit(entry.name);
  return order;
}

export function validateLock(lock, { expectedPath } = {}) {
  exactKeys(lock, LOCK_KEYS, "lock");
  if (lock.protocol !== LOCK_PROTOCOL || lock.purpose !== LOCK_PURPOSE) {
    throw new Error("R dependency lock protocol or purpose is invalid.");
  }
  validateQualification(lock.qualification);
  validateResolver(lock.resolver, lock.qualification.rMinor);
  const rootNames = validateRootCategories(lock.roots);
  if (
    !Array.isArray(lock.packages) ||
    lock.packages.length < rootNames.length ||
    lock.packages.length > LOCK_LIMITS.packages
  ) {
    throw new Error("R dependency package count is outside the bounded contract.");
  }
  const names = lock.packages.map((entry) => entry?.name);
  requireSortedUnique(names, "package names", (name) => PACKAGE_NAME.test(name));
  const packageNames = new Set(names);
  const archiveUrls = new Set();
  let aggregateBytes = 0;
  for (const entry of lock.packages) {
    exactKeys(entry, PACKAGE_KEYS, `package ${entry.name}`);
    if (!PACKAGE_NAME.test(entry.name) || !VERSION.test(entry.version)) throw new Error("Package identity is invalid.");
    if (typeof entry.direct !== "boolean" || entry.direct !== lock.roots.runtime.includes(entry.name)) {
      throw new Error(`${entry.name}.direct is inconsistent with the runtime roots.`);
    }
    if (typeof entry.needsCompilation !== "boolean") throw new Error(`${entry.name}.needsCompilation must be boolean.`);
    requireText(entry.license, `${entry.name}.license`, 1024);
    validateDependencies(entry.dependencies, packageNames, entry.name);
    exactKeys(entry.source, SOURCE_KEYS, `${entry.name}.source`);
    if (entry.source.kind !== "binary") throw new Error(`${entry.name}.source.kind must be binary.`);
    validateSnapshotUrl(entry.source.repositorySnapshotUrl, lock.qualification.rMinor);
    validateSnapshotUrl(entry.source.url, lock.qualification.rMinor, {
      archive: true,
      name: entry.name,
      version: entry.version
    });
    if (archiveUrls.has(entry.source.url)) throw new Error("R dependency archive URLs must be unique.");
    archiveUrls.add(entry.source.url);
    if (
      !Number.isSafeInteger(entry.source.bytes) ||
      entry.source.bytes <= 0 ||
      entry.source.bytes > LOCK_LIMITS.archiveBytes
    ) {
      throw new Error(`${entry.name}.source.bytes is outside the bounded contract.`);
    }
    aggregateBytes += entry.source.bytes;
    if (!SHA256.test(entry.source.sha256)) throw new Error(`${entry.name}.source.sha256 is invalid.`);
  }
  if (aggregateBytes > LOCK_LIMITS.aggregateArchiveBytes)
    throw new Error("R archives exceed the aggregate byte bound.");
  exactKeys(lock.systemRequirements, ["packages"], "systemRequirements");
  requireSortedUnique(lock.systemRequirements.packages, "systemRequirements.packages", (name) =>
    SAFE_SYSTEM_PACKAGE.test(name)
  );
  const reachable = new Set();
  const byName = new Map(lock.packages.map((entry) => [entry.name, entry]));
  const visitReachable = (name) => {
    if (reachable.has(name) || BASE_AND_RECOMMENDED_R.has(name)) return;
    reachable.add(name);
    const entry = byName.get(name);
    if (!entry) throw new Error(`R dependency lock is missing ${name}.`);
    for (const dependency of DEPENDENCY_KEYS.flatMap((key) => entry.dependencies[key])) visitReachable(dependency);
  };
  for (const root of rootNames) visitReachable(root);
  if (reachable.size !== lock.packages.length) throw new Error("R dependency lock contains an unreachable package.");
  topologicalPackages(lock.packages);
  if (expectedPath !== undefined) {
    const expectedName = `ubuntu-24.04-x86_64-r-${lock.qualification.rMinor}.lock.json`;
    if (basename(expectedPath) !== expectedName) throw new Error(`Lock filename must be ${expectedName}.`);
  }
  return Object.freeze({ aggregateBytes, packageCount: lock.packages.length });
}

export function readLock(path) {
  const bytes = readFileSync(path);
  if (bytes.length === 0 || bytes.length > LOCK_LIMITS.textBytes) throw new Error("R dependency lock size is invalid.");
  const lock = parseStrictJson(bytes.toString("utf8"), { maxBytes: LOCK_LIMITS.textBytes });
  validateLock(lock, { expectedPath: path });
  if (canonicalLockBytes(lock) !== bytes.toString("utf8")) throw new Error("R dependency lock is not canonical JSON.");
  return Object.freeze({ lock, bytes, digest: sha256(bytes) });
}

function parseDcf(text) {
  const entries = new Map();
  for (const block of text.trim().split(/\n\n+/u)) {
    const entry = {};
    let key;
    for (const line of block.split("\n")) {
      if (/^\s/u.test(line)) {
        if (key === undefined) throw new Error("Malformed PACKAGES continuation line.");
        entry[key] += ` ${line.trim()}`;
        continue;
      }
      const separator = line.indexOf(":");
      if (separator <= 0) throw new Error("Malformed PACKAGES field.");
      key = line.slice(0, separator);
      entry[key] = line.slice(separator + 1).trim();
    }
    if (!PACKAGE_NAME.test(entry.Package ?? "")) throw new Error("PACKAGES contains an invalid package name.");
    if (entries.has(entry.Package)) {
      if (BASE_AND_RECOMMENDED_R.has(entry.Package)) continue;
      throw new Error("PACKAGES contains a duplicate non-system package name.");
    }
    entries.set(entry.Package, entry);
  }
  return entries;
}

function dependencyNames(value = "") {
  return [
    ...new Set(
      value
        .split(",")
        .map((item) => /^([A-Za-z][A-Za-z0-9.]*)/u.exec(item.trim())?.[1])
        .filter(Boolean)
    )
  ]
    .filter((name) => !BASE_AND_RECOMMENDED_R.has(name))
    .sort();
}

function fetchBytes(
  url,
  { maximumBytes, expectedBytes, requireContentLength = true, redirected = false, originalHeaders } = {}
) {
  return new Promise((resolvePromise, reject) => {
    const operation = request(
      url,
      { headers: { "User-Agent": "openwrangler-r-lock-v1" }, method: "GET" },
      (response) => {
        if (response.statusCode === 307 && !redirected && response.headers.location !== undefined) {
          const source = new URL(url);
          const target = new URL(response.headers.location);
          const validTarget =
            source.protocol === "https:" &&
            source.hostname === SNAPSHOT_HOST &&
            target.protocol === "https:" &&
            target.hostname === "rspm-sync.rstudio.com" &&
            target.username === "" &&
            target.password === "" &&
            target.port === "" &&
            target.search === "" &&
            target.hash === "" &&
            /^\/bin\/4\.[45]-noble\/[0-9a-f]{64}\.tar\.gz$/u.test(target.pathname);
          response.resume();
          if (!validTarget) {
            reject(new Error(`Exact archive redirect left the approved content-addressed host: ${url}.`));
            return;
          }
          fetchBytes(target.href, {
            maximumBytes,
            expectedBytes,
            requireContentLength,
            redirected: true,
            originalHeaders: response.headers
          }).then(resolvePromise, reject);
          return;
        }
        if (response.statusCode !== 200 || response.headers.location !== undefined) {
          response.resume();
          reject(
            new Error(`Exact archive request failed without redirect: ${url} (${response.statusCode ?? "missing"}).`)
          );
          return;
        }
        const declaredLength = Number(response.headers["content-length"]);
        if (
          (expectedBytes !== undefined && declaredLength !== expectedBytes) ||
          (requireContentLength && (!Number.isSafeInteger(declaredLength) || declaredLength <= 0)) ||
          (Number.isSafeInteger(declaredLength) && declaredLength > maximumBytes)
        ) {
          response.resume();
          reject(new Error(`Exact archive response length is invalid: ${url}.`));
          return;
        }
        const chunks = [];
        let total = 0;
        response.on("data", (chunk) => {
          total += chunk.length;
          if (total > maximumBytes || (expectedBytes !== undefined && total > expectedBytes)) {
            response.destroy(new Error(`Exact archive exceeded its byte bound: ${url}.`));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          const bytes = Buffer.concat(chunks);
          if (
            (Number.isSafeInteger(declaredLength) && bytes.length !== declaredLength) ||
            (expectedBytes !== undefined && bytes.length !== expectedBytes)
          ) {
            reject(new Error(`Exact archive response was truncated: ${url}.`));
            return;
          }
          resolvePromise(Object.freeze({ bytes, headers: originalHeaders ?? response.headers }));
        });
        response.on("error", reject);
      }
    );
    operation.setTimeout(60_000, () => operation.destroy(new Error(`Exact archive request timed out: ${url}.`)));
    operation.on("error", reject);
    operation.end();
  });
}

export async function generateLock({ rMinor, generatedWithRVersion }) {
  if (!R_MINOR.test(rMinor)) throw new Error("Generator R minor must be 4.4 or 4.5.");
  const repositorySnapshotUrl = repositoryUrl(rMinor);
  const packagesResponse = await fetchBytes(`${repositorySnapshotUrl}/PACKAGES.gz`, {
    maximumBytes: 16 * 1024 * 1024,
    requireContentLength: false
  });
  const metadata = parseDcf(gunzipSync(packagesResponse.bytes).toString("utf8"));
  const selected = new Map();
  const queue = [...LOCK_ROOTS.runtime, ...LOCK_ROOTS.fixtures];
  while (queue.length > 0) {
    const name = queue.shift();
    if (selected.has(name)) continue;
    const entry = metadata.get(name);
    if (!entry) throw new Error(`Dated R repository is missing ${name}.`);
    selected.set(name, entry);
    for (const dependency of [
      ...dependencyNames(entry.Depends),
      ...dependencyNames(entry.Imports),
      ...dependencyNames(entry.LinkingTo)
    ]) {
      if (!selected.has(dependency)) queue.push(dependency);
    }
  }
  const packages = [];
  for (const name of [...selected.keys()].sort()) {
    const entry = selected.get(name);
    const url = `${repositorySnapshotUrl}/${name}_${entry.Version}.tar.gz`;
    const response = await fetchBytes(url, { maximumBytes: LOCK_LIMITS.archiveBytes });
    if (
      response.headers["x-package-type"] !== "binary" ||
      response.headers["x-package-binary-tag"] !== `${rMinor}-noble`
    ) {
      throw new Error(`Dated repository did not return the exact R ${rMinor} noble binary for ${name}.`);
    }
    packages.push({
      name,
      version: entry.Version,
      direct: LOCK_ROOTS.runtime.includes(name),
      needsCompilation: entry.NeedsCompilation === "yes",
      license: requireText(entry.License, `${name}.License`, 1024),
      dependencies: {
        depends: dependencyNames(entry.Depends),
        imports: dependencyNames(entry.Imports),
        linkingTo: dependencyNames(entry.LinkingTo)
      },
      source: {
        kind: "binary",
        repositorySnapshotUrl,
        url,
        bytes: response.bytes.length,
        sha256: sha256(response.bytes)
      }
    });
  }
  const lock = {
    protocol: LOCK_PROTOCOL,
    purpose: LOCK_PURPOSE,
    qualification: {
      rMinor,
      generatedWithRVersion,
      os: "linux",
      distribution: "ubuntu",
      distributionVersion: "24.04",
      architecture: "x86_64",
      rPlatform: "x86_64-pc-linux-gnu"
    },
    resolver: {
      name: "openwrangler-r-dependency-lock",
      exactVersion: LOCK_RESOLVER_VERSION,
      repositorySnapshotUrl,
      snapshotDate: SNAPSHOT_DATE
    },
    roots: {
      runtime: [...LOCK_ROOTS.runtime],
      fixtures: [...LOCK_ROOTS.fixtures]
    },
    packages,
    systemRequirements: { packages: ["libx11-dev"] }
  };
  validateLock(lock);
  return lock;
}

function actualR(rscript) {
  const command = resolve(rscript);
  const expression = [
    'version <- paste(R.version$major, R.version$minor, sep=".")',
    'cat(version, R.version$platform, Sys.info()[["sysname"]], Sys.info()[["machine"]], sep="\\t")'
  ].join(";");
  const result = spawnSync(command, ["--vanilla", "-e", expression], {
    encoding: "utf8",
    env: { ...process.env, R_DEFAULT_PACKAGES: "base" },
    maxBuffer: 16 * 1024,
    timeout: 30_000
  });
  if (result.error || result.status !== 0 || result.signal !== null)
    throw new Error("Could not inspect the exact R runtime.");
  const fields = result.stdout.split("\t");
  if (fields.length !== 4 || fields.some((field) => !SAFE_TEXT.test(field)))
    throw new Error("R runtime receipt is malformed.");
  return Object.freeze({ command, version: fields[0], platform: fields[1], os: fields[2], architecture: fields[3] });
}

function validateRuntime(lock, runtime) {
  if (
    !runtime.version.startsWith(`${lock.qualification.rMinor}.`) ||
    runtime.platform !== lock.qualification.rPlatform ||
    runtime.os !== "Linux" ||
    !["x86_64", "amd64"].includes(runtime.architecture)
  ) {
    throw new Error("Actual R runtime does not match the selected lock qualification.");
  }
}

function requireOwnedEmptyPath(path, label) {
  const absolute = resolve(path);
  if (!isAbsolute(absolute) || absolute === resolve(sep) || absolute === resolve(process.cwd())) {
    throw new Error(`${label} path is unsafe.`);
  }
  try {
    const stat = lstatSync(absolute);
    if (!stat.isDirectory() || stat.isSymbolicLink() || readdirSync(absolute).length !== 0) {
      throw new Error(`${label} must be an empty regular directory.`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    mkdirSync(absolute, { recursive: false, mode: 0o700 });
  }
  chmodSync(absolute, 0o700);
  return realpathSync(absolute);
}

function ensureContained(root, path, label) {
  const remainder = relative(root, path);
  if (remainder === "" || remainder === ".." || remainder.startsWith(`..${sep}`) || isAbsolute(remainder)) {
    throw new Error(`${label} escapes its private root.`);
  }
}

const OWNED_FILE_OPERATIONS = Object.freeze({
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync
});

function identitySnapshot(stat) {
  return Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    nlink: stat.nlink,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs
  });
}

function sameIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function requireContainedParent(root, absolute, label, operations) {
  if (root === undefined) return undefined;
  const canonicalRoot = resolve(root);
  ensureContained(canonicalRoot, absolute, label);
  const parent = dirname(absolute);
  const canonicalParent = operations.realpathSync(parent);
  const parentStat = operations.lstatSync(parent);
  const remainder = relative(canonicalRoot, canonicalParent);
  if (
    !parentStat.isDirectory() ||
    parentStat.isSymbolicLink() ||
    canonicalParent !== parent ||
    remainder === ".." ||
    remainder.startsWith(`..${sep}`) ||
    isAbsolute(remainder)
  ) {
    throw new Error(`${label} parent escapes its private root.`);
  }
  return identitySnapshot(parentStat);
}

export function readOwnedRegularFile(
  path,
  label,
  {
    expectedBytes,
    expectedSha256,
    minimumBytes = 1,
    maximumBytes = 64 * 1024,
    root,
    operations = OWNED_FILE_OPERATIONS
  } = {}
) {
  const absolute = resolve(path);
  if (!Number.isSafeInteger(minimumBytes) || minimumBytes < 0 || !Number.isSafeInteger(maximumBytes)) {
    throw new Error(`${label} byte bounds are invalid.`);
  }
  const descriptor = operations.openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let bytes;
  let descriptorSnapshot;
  try {
    const descriptorBefore = operations.fstatSync(descriptor);
    if (
      !descriptorBefore.isFile() ||
      descriptorBefore.nlink !== 1 ||
      !Number.isSafeInteger(descriptorBefore.size) ||
      descriptorBefore.size < minimumBytes ||
      descriptorBefore.size > maximumBytes ||
      (expectedBytes !== undefined && descriptorBefore.size !== expectedBytes)
    ) {
      throw new Error(`${label} descriptor is not a bounded singly linked regular file.`);
    }
    descriptorSnapshot = identitySnapshot(descriptorBefore);
    const namedBefore = operations.lstatSync(absolute);
    const namedSnapshotBefore = identitySnapshot(namedBefore);
    const parentBefore = requireContainedParent(root, absolute, label, operations);
    if (
      !namedBefore.isFile() ||
      namedBefore.isSymbolicLink() ||
      !sameIdentity(namedSnapshotBefore, descriptorSnapshot)
    ) {
      throw new Error(`${label} descriptor does not match its named path.`);
    }
    bytes = operations.readFileSync(descriptor);
    const descriptorAfter = operations.fstatSync(descriptor);
    const namedAfter = operations.lstatSync(absolute);
    const parentAfter = requireContainedParent(root, absolute, label, operations);
    if (
      !sameIdentity(identitySnapshot(descriptorAfter), descriptorSnapshot) ||
      !namedAfter.isFile() ||
      namedAfter.isSymbolicLink() ||
      !sameIdentity(identitySnapshot(namedAfter), descriptorSnapshot) ||
      (parentBefore !== undefined && (parentAfter === undefined || !sameIdentity(parentAfter, parentBefore)))
    ) {
      throw new Error(`${label} identity changed during its descriptor read.`);
    }
  } finally {
    operations.closeSync(descriptor);
  }
  if (bytes.length !== descriptorSnapshot.size || (expectedSha256 !== undefined && sha256(bytes) !== expectedSha256)) {
    throw new Error(`${label} identity or digest is invalid.`);
  }
  return Object.freeze({ bytes, snapshot: descriptorSnapshot });
}

function installedPackageRows(rscript, library, names) {
  const encodedNames = names.map((name) => JSON.stringify(name)).join(",");
  const expression = [
    `lib <- ${JSON.stringify(library)}`,
    `.libPaths(c(lib, .Library))`,
    `expected <- c(${encodedNames})`,
    `actual <- sort(list.files(lib, all.files=FALSE, no..=TRUE))`,
    `if (!identical(actual, sort(expected))) stop("private library package set mismatch")`,
    `for (name in sort(expected)) { d <- utils::packageDescription(name, lib.loc=lib); if (is.null(d)) stop("missing DESCRIPTION"); ns <- loadNamespace(name, lib.loc=lib); path <- normalizePath(getNamespaceInfo(ns, "path"), winslash="/", mustWork=TRUE); cat(name, d$Version, d$Built, path, sep="\\t"); cat("\\n") }`
  ].join(";");
  const result = spawnSync(rscript, ["--vanilla", "-e", expression], {
    encoding: "utf8",
    env: { ...process.env, R_DEFAULT_PACKAGES: "base", R_LIBS: library, R_LIBS_USER: library },
    maxBuffer: 1024 * 1024,
    timeout: 120_000
  });
  if (result.error || result.status !== 0 || result.signal !== null) {
    throw new Error(`Installed R package verification failed: ${(result.stderr ?? "").slice(0, 4096)}`);
  }
  return result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, version, built, path] = line.split("\t");
      return { name, version, built, path };
    });
}

export function treeDigest(root, { operations = OWNED_FILE_OPERATIONS } = {}) {
  const rows = [];
  let entries = 0;
  let totalBytes = 0;
  const walk = (directory, item) => {
    const descriptor = operations.openSync(
      directory,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0)
    );
    let directorySnapshot;
    let names;
    try {
      const descriptorBefore = operations.fstatSync(descriptor);
      const canonical = operations.realpathSync(directory);
      const namedBefore = operations.lstatSync(directory);
      directorySnapshot = identitySnapshot(descriptorBefore);
      if (
        !descriptorBefore.isDirectory() ||
        !namedBefore.isDirectory() ||
        namedBefore.isSymbolicLink() ||
        canonical !== resolve(directory) ||
        !sameIdentity(identitySnapshot(namedBefore), directorySnapshot)
      ) {
        throw new Error("Installed R library directory identity is invalid.");
      }
      if (item !== undefined) rows.push(`${item}\0directory\0${directorySnapshot.mode & 0o777}\0`);
      names = operations
        .readdirSync(directory, { withFileTypes: true })
        .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
      for (const entry of names) {
        entries += 1;
        if (entries > LOCK_LIMITS.installedTreeEntries) throw new Error("Installed R library entry bound exceeded.");
        const name = entry.name;
        const path = join(directory, name);
        const childItem = relative(root, path).split(sep).join("/");
        if (entry.isSymbolicLink()) throw new Error(`Installed R library contains a symlink: ${childItem}.`);
        if (entry.isDirectory()) {
          walk(path, childItem);
        } else if (entry.isFile()) {
          const verified = readOwnedRegularFile(path, `${childItem} installed R file`, {
            minimumBytes: 0,
            maximumBytes: LOCK_LIMITS.installedFileBytes,
            root,
            operations
          });
          totalBytes += verified.snapshot.size;
          if (totalBytes > LOCK_LIMITS.installedTreeBytes) {
            throw new Error("Installed R library byte bound exceeded.");
          }
          rows.push(
            `${childItem}\0file\0${verified.snapshot.mode & 0o777}\0${verified.snapshot.size}\0${sha256(verified.bytes)}`
          );
        } else {
          throw new Error(`Installed R library contains an unsupported path type: ${childItem}.`);
        }
      }
      const descriptorAfter = operations.fstatSync(descriptor);
      const canonicalAfter = operations.realpathSync(directory);
      const namedAfter = operations.lstatSync(directory);
      if (
        !namedAfter.isDirectory() ||
        namedAfter.isSymbolicLink() ||
        !sameIdentity(identitySnapshot(descriptorAfter), directorySnapshot) ||
        !sameIdentity(identitySnapshot(namedAfter), directorySnapshot) ||
        canonicalAfter !== resolve(directory)
      ) {
        throw new Error("Installed R library directory identity changed during traversal.");
      }
    } finally {
      operations.closeSync(descriptor);
    }
    return directorySnapshot;
  };
  walk(root, undefined);
  return sha256(`${rows.join("\n")}\n`);
}

function archiveSet(lock) {
  const rows = lock.packages.map(({ name, version, source }) => ({
    name,
    version,
    bytes: source.bytes,
    sha256: source.sha256
  }));
  return Object.freeze({
    count: rows.length,
    bytes: rows.reduce((sum, entry) => sum + entry.bytes, 0),
    digest: sha256(canonicalLockBytes(rows))
  });
}

function archiveFilename(entry) {
  return `${entry.name}_${entry.version}.tar.gz`;
}

function requireOwnedDirectory(path, label) {
  const absolute = resolve(path);
  if (!isAbsolute(absolute) || absolute === resolve(sep) || absolute === resolve(process.cwd())) {
    throw new Error(`${label} path is unsafe.`);
  }
  const stat = lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular directory.`);
  const canonical = realpathSync(absolute);
  if (canonical !== absolute) throw new Error(`${label} path contains a symlink.`);
  return canonical;
}

export function verifyArchiveCache({ lockRecord, archives }) {
  const archiveRoot = requireOwnedDirectory(archives, "R archive cache");
  const expectedNames = lockRecord.lock.packages.map(archiveFilename).sort();
  const actualNames = readdirSync(archiveRoot).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error("R archive cache inventory does not exactly match the canonical lock.");
  }
  const paths = new Map();
  for (const entry of lockRecord.lock.packages) {
    const path = join(archiveRoot, archiveFilename(entry));
    readOwnedRegularFile(path, `${entry.name} cached archive`, {
      expectedBytes: entry.source.bytes,
      expectedSha256: entry.source.sha256,
      maximumBytes: LOCK_LIMITS.archiveBytes,
      root: archiveRoot
    });
    paths.set(entry.name, path);
  }
  return Object.freeze({ archiveRoot, paths });
}

async function populateArchiveCache({ lockRecord, archives, fetchArchive }) {
  const archiveRoot = requireOwnedEmptyPath(archives, "R archive cache");
  for (const entry of lockRecord.lock.packages) {
    const response = await fetchArchive(entry.source.url, {
      maximumBytes: LOCK_LIMITS.archiveBytes,
      expectedBytes: entry.source.bytes
    });
    if (sha256(response.bytes) !== entry.source.sha256) throw new Error(`R archive digest mismatch for ${entry.name}.`);
    const path = join(archiveRoot, archiveFilename(entry));
    const descriptor = openSync(path, "wx", 0o600);
    try {
      writeFileSync(descriptor, response.bytes);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }
  return verifyArchiveCache({ lockRecord, archives: archiveRoot });
}

function installRArchive({ rscript, library, path, entry }) {
  readOwnedRegularFile(path, `${entry.name} install archive`, {
    expectedBytes: entry.source.bytes,
    expectedSha256: entry.source.sha256,
    maximumBytes: LOCK_LIMITS.archiveBytes,
    root: dirname(path)
  });
  const rCommand = realpathSync(join(dirname(rscript), process.platform === "win32" ? "R.exe" : "R"));
  const result = spawnSync(rCommand, ["CMD", "INSTALL", "--library", library, "--no-docs", "--no-help", path], {
    encoding: "utf8",
    env: { ...process.env, R_DEFAULT_PACKAGES: "base", R_LIBS: library, R_LIBS_USER: library },
    maxBuffer: 4 * 1024 * 1024,
    timeout: 180_000
  });
  if (result.error || result.status !== 0 || result.signal !== null) {
    throw new Error(
      `Local-only R install failed for ${entry.name}: ${`${result.stdout ?? ""}${result.stderr ?? ""}`.slice(0, 4096)}`
    );
  }
}

function verifyInstalled({ lockRecord, rscript, library }) {
  const { lock, digest: lockDigest } = lockRecord;
  const runtime = actualR(rscript);
  validateRuntime(lock, runtime);
  const requestedLibrary = resolve(library);
  const libraryStat = lstatSync(requestedLibrary);
  if (!libraryStat.isDirectory() || libraryStat.isSymbolicLink())
    throw new Error("Private R library is not an owned directory.");
  const libraryRoot = realpathSync(requestedLibrary);
  if (libraryRoot !== requestedLibrary) throw new Error("Private R library path contains a symlink.");
  const expected = new Map(lock.packages.map((entry) => [entry.name, entry]));
  const rows = installedPackageRows(runtime.command, libraryRoot, [...expected.keys()]);
  if (rows.length !== expected.size) throw new Error("Installed R package receipt count is invalid.");
  for (const row of rows) {
    const entry = expected.get(row.name);
    if (!entry || row.version !== entry.version) throw new Error(`Installed R package mismatch: ${row.name}.`);
    const actualPath = realpathSync(row.path);
    ensureContained(libraryRoot, actualPath, `${row.name} namespace`);
    if (!row.built.includes(`R ${lock.qualification.rMinor}.`)) {
      throw new Error(`${row.name} binary was not built for R ${lock.qualification.rMinor}.`);
    }
  }
  const packageSetDigest = sha256(
    canonicalLockBytes(rows.map(({ name, version, built }) => ({ name, version, built })))
  );
  const installedTreeDigest = treeDigest(libraryRoot);
  const archives = archiveSet(lock);
  const receipt = {
    protocol: "openwrangler-native-r-installed-library-v1",
    lockSha256: lockDigest,
    rVersion: runtime.version,
    rPlatform: runtime.platform,
    packageCount: rows.length,
    packageSetSha256: packageSetDigest,
    treeSha256: installedTreeDigest,
    archiveCount: archives.count,
    archiveBytes: archives.bytes,
    archiveSetSha256: archives.digest
  };
  const bytes = canonicalLockBytes(receipt);
  return Object.freeze({ receipt, bytes, runtime });
}

export async function installFromArchiveCache({
  lockRecord,
  rscript,
  library,
  archives,
  receipt,
  cacheHit,
  fetchArchive = fetchBytes,
  installArchive = installRArchive,
  verifyLibrary = verifyInstalled
}) {
  const verifiedCache = cacheHit
    ? verifyArchiveCache({ lockRecord, archives })
    : await populateArchiveCache({ lockRecord, archives, fetchArchive });
  const libraryRoot = requireOwnedEmptyPath(library, "R library");
  for (const entry of topologicalPackages(lockRecord.lock.packages)) {
    const path = verifiedCache.paths.get(entry.name);
    readOwnedRegularFile(path, `${entry.name} pre-install archive`, {
      expectedBytes: entry.source.bytes,
      expectedSha256: entry.source.sha256,
      maximumBytes: LOCK_LIMITS.archiveBytes,
      root: verifiedCache.archiveRoot
    });
    installArchive({ rscript, library: libraryRoot, path, entry });
  }
  const verified = verifyLibrary({ lockRecord, rscript, library: libraryRoot });
  const receiptDescriptor = openSync(receipt, "wx", 0o600);
  try {
    writeFileSync(receiptDescriptor, verified.bytes);
    fsyncSync(receiptDescriptor);
  } finally {
    closeSync(receiptDescriptor);
  }
  const writtenReceipt = readOwnedRegularFile(receipt, "Installed R library receipt", {
    root: dirname(resolve(receipt))
  }).bytes.toString("utf8");
  if (writtenReceipt !== verified.bytes) throw new Error("Installed R library receipt publication failed.");
  return verified;
}

function appendOutputs(values) {
  const output = process.env.GITHUB_OUTPUT;
  if (output === undefined) return;
  const lines = Object.entries(values)
    .map(([key, value]) => `${key}=${String(value)}\n`)
    .join("");
  const descriptor = openSync(output, "a");
  try {
    writeFileSync(descriptor, lines);
  } finally {
    closeSync(descriptor);
  }
}

function parseOptions(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!/^--[a-z-]+$/u.test(key ?? "") || value === undefined || options.has(key)) {
      throw new Error("R lock CLI options must be unique --name value pairs.");
    }
    options.set(key, value);
  }
  return options;
}

function option(options, name) {
  const value = options.get(`--${name}`);
  if (value === undefined) throw new Error(`Missing --${name}.`);
  return value;
}

async function main(args) {
  const [command, ...rest] = args;
  if (command === "check") {
    if (rest.length === 0) throw new Error("check requires at least one lock path.");
    for (const path of rest) readLock(path);
    process.stdout.write(`Verified ${rest.length} canonical R dependency lock(s).\n`);
    return;
  }
  const options = parseOptions(rest);
  if (command === "generate") {
    const output = option(options, "output");
    const lock = await generateLock({
      rMinor: option(options, "r-minor"),
      generatedWithRVersion: option(options, "r-version")
    });
    const bytes = canonicalLockBytes(lock);
    if (options.get("--check") === "true") {
      if (readFileSync(output, "utf8") !== bytes) throw new Error(`Generated lock differs from ${output}.`);
    } else {
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, bytes, { encoding: "utf8", flag: "wx", mode: 0o600 });
    }
    process.stdout.write(`${options.get("--check") === "true" ? "Reproduced" : "Generated"} ${output}.\n`);
    return;
  }
  const lockPath = option(options, "lock");
  const rscript = option(options, "rscript");
  const library = option(options, "library");
  const receipt = option(options, "receipt");
  const archives = option(options, "archives");
  const lockRecord = readLock(lockPath);
  if (command === "prepare") {
    const runtime = actualR(rscript);
    validateRuntime(lockRecord.lock, runtime);
    const installerDigest = sha256(
      Buffer.concat([
        readFileSync(new URL(import.meta.url)),
        Buffer.from([0]),
        readFileSync(new URL("./strict-json.mjs", import.meta.url))
      ])
    );
    const key = [
      "openwrangler-r-contract-v2",
      requireText(process.env.ImageOS, "ImageOS"),
      requireText(process.env.ImageVersion, "ImageVersion"),
      requireText(process.env.RUNNER_ARCH, "RUNNER_ARCH"),
      runtime.version,
      runtime.platform,
      lockRecord.digest,
      installerDigest
    ].join("-");
    appendOutputs({
      "lock-sha256": lockRecord.digest,
      "installer-sha256": installerDigest,
      "r-version": runtime.version,
      "r-platform": runtime.platform,
      "cache-key": key,
      library: resolve(library),
      archives: resolve(archives),
      receipt: resolve(receipt)
    });
    process.stdout.write(
      `${JSON.stringify({
        phase: "prepare",
        lockSha256: lockRecord.digest,
        installerSha256: installerDigest,
        rVersion: runtime.version,
        rPlatform: runtime.platform,
        imageOS: process.env.ImageOS,
        imageVersion: process.env.ImageVersion,
        runnerArch: process.env.RUNNER_ARCH,
        cacheKey: key
      })}\n`
    );
    return;
  }
  if (command === "install") {
    const startedAt = Date.now();
    const cacheHit = option(options, "cache-hit");
    if (cacheHit !== "true" && cacheHit !== "false") throw new Error("--cache-hit must be true or false.");
    const runtime = actualR(rscript);
    validateRuntime(lockRecord.lock, runtime);
    const verified = await installFromArchiveCache({
      lockRecord,
      rscript: runtime.command,
      library,
      archives,
      receipt,
      cacheHit: cacheHit === "true"
    });
    appendOutputs({
      "cache-hit": cacheHit,
      "package-count": verified.receipt.packageCount,
      "package-set-sha256": verified.receipt.packageSetSha256,
      "tree-sha256": verified.receipt.treeSha256,
      "receipt-sha256": sha256(verified.bytes),
      "archive-count": verified.receipt.archiveCount,
      "archive-bytes": verified.receipt.archiveBytes,
      "archive-set-sha256": verified.receipt.archiveSetSha256
    });
    process.stdout.write(
      `${JSON.stringify({
        phase: "install",
        cacheHit,
        packageCount: verified.receipt.packageCount,
        packageSetSha256: verified.receipt.packageSetSha256,
        treeSha256: verified.receipt.treeSha256,
        receiptSha256: sha256(verified.bytes),
        archiveCount: verified.receipt.archiveCount,
        archiveBytes: verified.receipt.archiveBytes,
        archiveSetSha256: verified.receipt.archiveSetSha256,
        elapsedMs: Date.now() - startedAt
      })}\n`
    );
    return;
  }
  throw new Error("Usage: r-dependency-lock.mjs check|generate|prepare|install ...");
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invoked === import.meta.url) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "R dependency lock failed."}\n`);
    process.exitCode = 1;
  }
}
