import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(MODULE_DIRECTORY, "..");
const DEFAULT_MANIFEST_PATH = resolve(MODULE_DIRECTORY, "xvfb-packages.json");
const DEFAULT_CACHE_ROOT = resolve(REPOSITORY_ROOT, "tmp", "tooling", "xvfb");
const DPKG_DEB = "/usr/bin/dpkg-deb";
const DPKG_QUERY = "/usr/bin/dpkg-query";
const DOWNLOAD_TIMEOUT_MS = 60_000;
const DOWNLOAD_ROUNDS = 2;
const DOWNLOAD_ROUND_DELAY_MS = 1_000;
const DOWNLOAD_ORIGINS = Object.freeze(["archive.ubuntu.com", "security.ubuntu.com", "snapshot.ubuntu.com"]);
const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_TRANSPORT_CODES = new Set([
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET"
]);
const HASH_BUFFER_BYTES = 64 * 1024;
const MANIFEST_KEYS = new Set(["schemaVersion", "packages"]);
const PACKAGE_KEYS = new Set([
  "cacheKey",
  "distribution",
  "distributionVersion",
  "nodeArchitecture",
  "packageArchitecture",
  "packageVersion",
  "snapshot",
  "urls",
  "size",
  "sha256",
  "executableSize",
  "executableSha256",
  "requiredPackages",
  "exactPackageVersions",
  "license",
  "source"
]);
const SAFE_PACKAGE_NAME = /^[a-z0-9][a-z0-9+.-]{0,127}$/u;
const SAFE_CACHE_KEY = /^[a-z0-9][a-z0-9.-]{0,159}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SNAPSHOT = /^\d{8}T\d{6}Z$/u;

export function parseOsRelease(text) {
  if (typeof text !== "string") throw new TypeError("OS release contents must be text.");
  const values = new Map();
  for (const line of text.split(/\r?\n/u)) {
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (!match) continue;
    let value = match[2];
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\(["\\$`])/gu, "$1");
    }
    values.set(match[1], value);
  }
  const distribution = values.get("ID")?.toLowerCase();
  const distributionVersion = values.get("VERSION_ID");
  if (!distribution || !/^[a-z0-9._-]+$/u.test(distribution)) {
    throw new Error("The Linux distribution ID is missing or malformed.");
  }
  if (!distributionVersion || !/^[0-9]+(?:\.[0-9]+)*$/u.test(distributionVersion)) {
    throw new Error("The Linux distribution version is missing or malformed.");
  }
  return { distribution, distributionVersion };
}

export function loadXvfbManifest(path = DEFAULT_MANIFEST_PATH) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  assertExactKeys(raw, MANIFEST_KEYS, "Xvfb package manifest");
  if (raw.schemaVersion !== 2) throw new Error("The Xvfb package manifest version is unsupported.");
  if (!isPlainObject(raw.packages) || Object.keys(raw.packages).length === 0) {
    throw new Error("The Xvfb package manifest must contain at least one package.");
  }
  const packages = {};
  for (const [key, value] of Object.entries(raw.packages)) {
    packages[key] = validatePackageRecord(key, value);
  }
  return { schemaVersion: 2, packages };
}

export async function prepareRepositoryLocalXvfb({
  platform = process.platform,
  architecture = process.arch,
  osReleaseText = platform === "linux" ? readFileSync("/etc/os-release", "utf8") : "",
  manifest = loadXvfbManifest(),
  cacheRoot = DEFAULT_CACHE_ROOT,
  queryPackage = queryInstalledDebianPackage,
  downloadPackage = downloadPinnedPackage,
  extractPackage = extractDebianPackage
} = {}) {
  if (platform !== "linux") throw new Error("Repository-local Xvfb preparation is supported only on Linux.");
  const { distribution, distributionVersion } = parseOsRelease(osReleaseText);
  const manifestKey = `${distribution}:${distributionVersion}:${architecture}`;
  const packageRecord = manifest.packages?.[manifestKey];
  if (!packageRecord) {
    throw new Error(`No pinned Xvfb package is available for ${manifestKey}.`);
  }
  const record = validatePackageRecord(manifestKey, packageRecord);
  await verifyHostDependencies(record, queryPackage);

  const absoluteCacheRoot = resolve(cacheRoot);
  ensurePrivateCacheRoot(absoluteCacheRoot);
  const packagePath = await ensurePinnedPackage(absoluteCacheRoot, record, downloadPackage);

  const installationRoot = join(absoluteCacheRoot, record.cacheKey);
  const executablePath = join(installationRoot, "usr", "bin", "Xvfb");
  if (existsSync(executablePath)) {
    validatePinnedFile(executablePath, {
      size: record.executableSize,
      sha256: record.executableSha256,
      executable: true,
      elfMachine: 62
    });
    return executablePath;
  }
  if (existsSync(installationRoot)) {
    throw new Error("The cached Xvfb installation is incomplete or has an unexpected layout.");
  }

  const stagingRoot = join(absoluteCacheRoot, `.extract-${record.cacheKey}-${randomUUID()}`);
  mkdirSync(stagingRoot, { mode: 0o700 });
  const stagingReceipt = directoryReceipt(stagingRoot);
  let published = false;
  try {
    await extractPackage(packagePath, stagingRoot);
    const stagedExecutable = join(stagingRoot, "usr", "bin", "Xvfb");
    validatePinnedFile(stagedExecutable, {
      size: record.executableSize,
      sha256: record.executableSha256,
      executable: true,
      elfMachine: 62
    });
    try {
      renameSync(stagingRoot, installationRoot);
      published = true;
    } catch (error) {
      if (!isDestinationExistsError(error) || !existsSync(executablePath)) throw error;
      validatePinnedFile(executablePath, {
        size: record.executableSize,
        sha256: record.executableSha256,
        executable: true,
        elfMachine: 62
      });
    }
  } finally {
    if (!published && existsSync(stagingRoot)) removeOwnedDirectory(stagingRoot, stagingReceipt);
  }
  validatePinnedFile(executablePath, {
    size: record.executableSize,
    sha256: record.executableSha256,
    executable: true,
    elfMachine: 62
  });
  return executablePath;
}

async function ensurePinnedPackage(cacheRoot, record, downloadPackage) {
  const packageDirectory = join(cacheRoot, `${record.cacheKey}.package`);
  const packagePath = join(packageDirectory, "xvfb.deb");
  if (existsSync(packagePath)) {
    validatePinnedFile(packagePath, { size: record.size, sha256: record.sha256 });
    return packagePath;
  }
  if (existsSync(packageDirectory)) {
    throw new Error("The cached Xvfb package is incomplete or has an unexpected layout.");
  }
  const stagingRoot = join(cacheRoot, `.package-${record.cacheKey}-${randomUUID()}`);
  mkdirSync(stagingRoot, { mode: 0o700 });
  const stagingReceipt = directoryReceipt(stagingRoot);
  const temporaryPath = join(stagingRoot, "xvfb.deb");
  let published = false;
  try {
    await downloadPackage({
      urls: record.urls,
      destination: temporaryPath,
      size: record.size,
      sha256: record.sha256
    });
    validatePinnedFile(temporaryPath, { size: record.size, sha256: record.sha256 });
    try {
      renameSync(stagingRoot, packageDirectory);
      published = true;
    } catch (error) {
      if (!isDestinationExistsError(error) || !existsSync(packagePath)) throw error;
      validatePinnedFile(packagePath, { size: record.size, sha256: record.sha256 });
    }
  } finally {
    if (!published && existsSync(stagingRoot)) removeOwnedDirectory(stagingRoot, stagingReceipt);
  }
  validatePinnedFile(packagePath, { size: record.size, sha256: record.sha256 });
  return packagePath;
}

export async function downloadPinnedPackage({
  urls,
  destination,
  size,
  sha256,
  fetchImpl = globalThis.fetch,
  waitBetweenRounds = waitForDownloadRound
}) {
  if (typeof fetchImpl !== "function") throw new Error("A Fetch implementation is required to download Xvfb.");
  if (typeof waitBetweenRounds !== "function") throw new Error("An Xvfb download round waiter is required.");
  validateDownloadUrls(urls);
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error("The pinned Xvfb package size is invalid.");
  if (!SHA256.test(sha256)) throw new Error("The pinned Xvfb package digest is invalid.");
  if (!isAbsolute(destination)) throw new Error("The Xvfb download destination must be absolute.");

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("The Xvfb package download timed out.")),
    DOWNLOAD_TIMEOUT_MS
  );
  let lastTransientError;
  try {
    for (let round = 0; round < DOWNLOAD_ROUNDS; round += 1) {
      for (const url of urls) {
        if (controller.signal.aborted) throw abortReason(controller.signal);
        try {
          await downloadPinnedPackageAttempt({
            url,
            destination,
            size,
            sha256,
            fetchImpl,
            signal: controller.signal
          });
          return;
        } catch (error) {
          if (controller.signal.aborted) throw abortReason(controller.signal);
          if (!(error instanceof RetryableXvfbDownloadError)) throw error;
          lastTransientError = error;
        }
      }
      if (round + 1 < DOWNLOAD_ROUNDS) {
        await waitBetweenRounds(DOWNLOAD_ROUND_DELAY_MS, controller.signal);
        if (controller.signal.aborted) throw abortReason(controller.signal);
      }
    }
    throw new Error(
      `The pinned Xvfb package origins remained transiently unavailable after ${DOWNLOAD_ROUNDS} rounds: ${lastTransientError?.message ?? "unknown transient failure"}`
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function downloadPinnedPackageAttempt({ url, destination, size, sha256, fetchImpl, signal }) {
  const fd = openSync(
    destination,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  );
  const receipt = fileReceiptFromStat(fstatSync(fd, { bigint: true }));
  let completed = false;
  let response;
  let reader;
  let responseBodyCompleted = false;
  try {
    try {
      response = await fetchImpl(url, {
        method: "GET",
        redirect: "error",
        signal,
        headers: { "user-agent": "Open-Wrangler-Xvfb-Bootstrap/1" }
      });
    } catch (error) {
      const transportCode = retryableTransportCode(error);
      if (transportCode !== undefined && !signal.aborted) {
        throw new RetryableXvfbDownloadError(`transport ${transportCode}`);
      }
      throw error;
    }
    if (signal.aborted) throw abortReason(signal);
    if (response.url !== url) {
      throw new Error("The Xvfb package download returned an unexpected final URL.");
    }
    if (!response.ok || response.status !== 200) {
      if (!RETRYABLE_HTTP_STATUSES.has(response.status)) {
        throw new Error(`The Xvfb package download returned HTTP ${response.status}.`);
      }
      throw new RetryableXvfbDownloadError(`HTTP ${response.status}`);
    }
    const contentEncoding = response.headers.get("content-encoding");
    if (contentEncoding && contentEncoding !== "identity") {
      throw new Error("The Xvfb package download returned an encoded response.");
    }
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null && Number(contentLength) !== size) {
      throw new Error("The Xvfb package download length did not match its pinned size.");
    }
    if (!response.body) throw new Error("The Xvfb package download returned no body.");
    reader = response.body.getReader();
    const digest = createHash("sha256");
    let bytes = 0;
    while (true) {
      let result;
      try {
        result = await reader.read();
      } catch (error) {
        const transportCode = retryableTransportCode(error);
        if (transportCode !== undefined && !signal.aborted) {
          throw new RetryableXvfbDownloadError(`transport ${transportCode}`);
        }
        throw error;
      }
      if (signal.aborted) throw abortReason(signal);
      const { done, value } = result;
      if (done) responseBodyCompleted = true;
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error("The Xvfb package download returned an invalid chunk.");
      bytes += value.byteLength;
      if (bytes > size) {
        throw new Error("The Xvfb package download exceeded its pinned size.");
      }
      digest.update(value);
      writeComplete(fd, value);
    }
    if (bytes !== size || digest.digest("hex") !== sha256) {
      throw new Error("The Xvfb package download did not match its pinned digest.");
    }
    fsyncSync(fd);
    completed = true;
  } finally {
    if (!completed && !responseBodyCompleted && response?.body) {
      await releaseResponseBody(response, reader);
    }
    closeSync(fd);
    if (!completed) removeOwnedFile(destination, receipt);
  }
}

class RetryableXvfbDownloadError extends Error {}

async function releaseResponseBody(response, reader) {
  try {
    if (reader) await reader.cancel();
    else await response.body.cancel();
  } catch {
    // Preserve the already classified failure while still releasing a locked reader below.
  } finally {
    if (reader) {
      try {
        reader.releaseLock();
      } catch {
        // An errored stream may have already released its lock.
      }
    }
  }
}

function retryableTransportCode(error) {
  const visited = new Set();
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object" && !visited.has(current); depth += 1) {
    visited.add(current);
    if (typeof current.code === "string" && RETRYABLE_TRANSPORT_CODES.has(current.code)) {
      return current.code;
    }
    current = current.cause;
  }
  return undefined;
}

function waitForDownloadRound(delayMs, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal.aborted) {
      rejectPromise(abortReason(signal));
      return;
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolvePromise();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timeout);
      rejectPromise(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function abortReason(signal) {
  return signal.reason instanceof Error ? signal.reason : new Error("The Xvfb package download was aborted.");
}

async function verifyHostDependencies(record, queryPackage) {
  for (const packageName of record.requiredPackages) {
    const installed = await queryPackage(packageName);
    if (!installed || installed.status !== "ii" || typeof installed.version !== "string" || !installed.version) {
      throw new Error(`The host dependency ${packageName} required by the pinned Xvfb build is not installed.`);
    }
    const expectedVersion = record.exactPackageVersions[packageName];
    if (expectedVersion !== undefined && installed.version !== expectedVersion) {
      throw new Error(
        `The host dependency ${packageName} is ${installed.version}; the pinned Xvfb build requires ${expectedVersion}.`
      );
    }
  }
}

export function queryInstalledDebianPackage(packageName) {
  if (!SAFE_PACKAGE_NAME.test(packageName)) throw new Error("The Xvfb host dependency name is malformed.");
  if (!existsSync(DPKG_QUERY)) throw new Error("Repository-local Xvfb preparation requires /usr/bin/dpkg-query.");
  let output;
  try {
    output = execFileSync(DPKG_QUERY, ["-W", "-f=${db:Status-Abbrev}\\t${Version}", packageName], {
      encoding: "utf8",
      maxBuffer: 16 * 1024,
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch {
    return undefined;
  }
  const match = /^(ii)\s*\t([^\0\r\n]+)$/u.exec(output.trimEnd());
  return match ? { status: match[1], version: match[2] } : undefined;
}

export function extractDebianPackage(packagePath, destination) {
  if (!existsSync(DPKG_DEB)) throw new Error("Repository-local Xvfb preparation requires /usr/bin/dpkg-deb.");
  execFileSync(DPKG_DEB, ["--extract", packagePath, destination], {
    maxBuffer: 64 * 1024,
    stdio: ["ignore", "ignore", "pipe"]
  });
}

function validatePackageRecord(key, value) {
  if (!isPlainObject(value)) throw new Error(`The Xvfb package record ${key} must be an object.`);
  assertExactKeys(value, PACKAGE_KEYS, `Xvfb package record ${key}`);
  for (const field of [
    "cacheKey",
    "distribution",
    "distributionVersion",
    "nodeArchitecture",
    "packageArchitecture",
    "packageVersion",
    "snapshot",
    "sha256",
    "executableSha256",
    "license",
    "source"
  ]) {
    if (typeof value[field] !== "string" || !value[field]) {
      throw new Error(`The Xvfb package record ${key} has an invalid ${field}.`);
    }
  }
  if (!SAFE_CACHE_KEY.test(value.cacheKey)) throw new Error(`The Xvfb package record ${key} has an unsafe cache key.`);
  if (!/^[a-z0-9._-]+$/u.test(value.distribution)) {
    throw new Error(`The Xvfb package record ${key} has an invalid distribution.`);
  }
  if (!/^[0-9]+(?:\.[0-9]+)*$/u.test(value.distributionVersion)) {
    throw new Error(`The Xvfb package record ${key} has an invalid distribution version.`);
  }
  if (!/^[a-z0-9_-]+$/u.test(value.nodeArchitecture) || !/^[a-z0-9_-]+$/u.test(value.packageArchitecture)) {
    throw new Error(`The Xvfb package record ${key} has an invalid architecture.`);
  }
  if (key !== `${value.distribution}:${value.distributionVersion}:${value.nodeArchitecture}`) {
    throw new Error(`The Xvfb package record ${key} does not match its host tuple.`);
  }
  if (!SNAPSHOT.test(value.snapshot)) throw new Error(`The Xvfb package record ${key} has an invalid snapshot.`);
  validateDownloadUrls(value.urls, {
    snapshot: value.snapshot,
    packageVersion: value.packageVersion,
    packageArchitecture: value.packageArchitecture
  });
  if (!Number.isSafeInteger(value.size) || value.size <= 0 || value.size > 4 * 1024 * 1024) {
    throw new Error(`The Xvfb package record ${key} has an invalid package size.`);
  }
  if (
    !Number.isSafeInteger(value.executableSize) ||
    value.executableSize <= 0 ||
    value.executableSize > 8 * 1024 * 1024
  ) {
    throw new Error(`The Xvfb package record ${key} has an invalid executable size.`);
  }
  if (!SHA256.test(value.sha256) || !SHA256.test(value.executableSha256)) {
    throw new Error(`The Xvfb package record ${key} has an invalid SHA-256 digest.`);
  }
  if (
    !Array.isArray(value.requiredPackages) ||
    value.requiredPackages.length === 0 ||
    new Set(value.requiredPackages).size !== value.requiredPackages.length ||
    value.requiredPackages.some(
      (packageName) => typeof packageName !== "string" || !SAFE_PACKAGE_NAME.test(packageName)
    )
  ) {
    throw new Error(`The Xvfb package record ${key} has invalid host dependencies.`);
  }
  if (!isPlainObject(value.exactPackageVersions)) {
    throw new Error(`The Xvfb package record ${key} has invalid exact dependency versions.`);
  }
  for (const [packageName, version] of Object.entries(value.exactPackageVersions)) {
    if (
      !value.requiredPackages.includes(packageName) ||
      typeof version !== "string" ||
      !version ||
      /[\0\r\n]/u.test(version)
    ) {
      throw new Error(`The Xvfb package record ${key} has an invalid exact dependency version.`);
    }
  }
  return Object.freeze({
    ...value,
    urls: Object.freeze([...value.urls]),
    requiredPackages: Object.freeze([...value.requiredPackages]),
    exactPackageVersions: Object.freeze({ ...value.exactPackageVersions })
  });
}

function validateDownloadUrls(values, expected = {}) {
  if (!Array.isArray(values) || values.length !== DOWNLOAD_ORIGINS.length || new Set(values).size !== values.length) {
    throw new Error("The pinned Xvfb package URLs must contain the complete ordered Canonical origin set.");
  }
  const parsed = values.map((value, index) => parseDownloadUrl(value, DOWNLOAD_ORIGINS[index]));
  const archivePath = parsed[0].pathname;
  if (parsed[1].pathname !== archivePath) {
    throw new Error("The pinned Xvfb archive and security URLs must use the same exact package path.");
  }
  const snapshotMatch =
    /^\/ubuntu\/(\d{8}T\d{6}Z)(\/pool\/universe\/x\/xorg-server\/xvfb_[a-zA-Z0-9.+~-]+_amd64\.deb)$/u.exec(
      parsed[2].pathname
    );
  if (!snapshotMatch || `/ubuntu${snapshotMatch[2]}` !== archivePath) {
    throw new Error("The pinned Xvfb snapshot URL must use the timestamped form of the exact package path.");
  }
  if (expected.snapshot !== undefined && snapshotMatch[1] !== expected.snapshot) {
    throw new Error("The pinned Xvfb snapshot URL does not match the package snapshot.");
  }
  if (expected.packageVersion !== undefined || expected.packageArchitecture !== undefined) {
    const version = expected.packageVersion?.replace(/^\d+:/u, "");
    const fileName = `xvfb_${version}_${expected.packageArchitecture}.deb`;
    if (!archivePath.endsWith(`/${fileName}`)) {
      throw new Error("The pinned Xvfb URLs do not match the exact package version and architecture.");
    }
  }
}

function parseDownloadUrl(value, expectedOrigin) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("A pinned Xvfb package URL is invalid.");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== expectedOrigin ||
    url.href !== value ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("The pinned Xvfb package URLs must use the ordered official Canonical HTTPS origins.");
  }
  if (
    expectedOrigin !== "snapshot.ubuntu.com" &&
    !/^\/ubuntu\/pool\/universe\/x\/xorg-server\/xvfb_[a-zA-Z0-9.+~-]+_amd64\.deb$/u.test(url.pathname)
  ) {
    throw new Error("A pinned Xvfb package URL has an unexpected archive path.");
  }
  return url;
}

function ensurePrivateCacheRoot(cacheRoot) {
  const existed = existsSync(cacheRoot);
  mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
  if (!existed) chmodSync(cacheRoot, 0o700);
  const metadata = lstatSync(cacheRoot, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077n) !== 0n) {
    throw new Error("The Xvfb tooling cache must be a private, non-symlink directory.");
  }
  if (realpathSync(cacheRoot) !== cacheRoot) {
    throw new Error("The Xvfb tooling cache path may not traverse symbolic links.");
  }
}

function validatePinnedFile(path, { size, sha256, executable = false, elfMachine } = {}) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    assertPinnedFileMetadata(path, before, { size, executable });
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
    const prefix = Buffer.alloc(64);
    let prefixBytes = 0;
    let bytes = 0;
    while (true) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      if (bytes + read > size) throw new Error(`The pinned file ${path} grew while it was read.`);
      if (prefixBytes < prefix.length) {
        const copied = Math.min(read, prefix.length - prefixBytes);
        buffer.copy(prefix, prefixBytes, 0, copied);
        prefixBytes += copied;
      }
      digest.update(buffer.subarray(0, read));
      bytes += read;
    }
    const after = fstatSync(fd, { bigint: true });
    if (!sameFileSnapshot(before, after) || bytes !== size || digest.digest("hex") !== sha256) {
      throw new Error(`The pinned file ${path} failed identity or digest validation.`);
    }
    if (elfMachine !== undefined) validateElf(prefix.subarray(0, prefixBytes), elfMachine);
    const atPath = lstatSync(path, { bigint: true });
    if (atPath.dev !== after.dev || atPath.ino !== after.ino || atPath.isSymbolicLink()) {
      throw new Error(`The pinned file ${path} was replaced during validation.`);
    }
  } finally {
    closeSync(fd);
  }
}

function assertPinnedFileMetadata(path, metadata, { size, executable }) {
  if (!metadata.isFile() || metadata.nlink !== 1n || metadata.size !== BigInt(size)) {
    throw new Error(`The pinned file ${path} is not a single-link regular file of the expected size.`);
  }
  if (executable && (metadata.mode & 0o111n) === 0n) {
    throw new Error(`The pinned file ${path} is not executable.`);
  }
}

function validateElf(prefix, machine) {
  if (
    prefix.length < 20 ||
    prefix[0] !== 0x7f ||
    prefix.toString("ascii", 1, 4) !== "ELF" ||
    prefix[4] !== 2 ||
    prefix[5] !== 1 ||
    prefix.readUInt16LE(18) !== machine
  ) {
    throw new Error("The pinned Xvfb executable is not the expected 64-bit little-endian ELF.");
  }
}

function sameFileSnapshot(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function fileReceiptFromStat(metadata) {
  return Object.freeze({ dev: metadata.dev, ino: metadata.ino });
}

function directoryReceipt(path) {
  const metadata = lstatSync(path, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("The Xvfb extraction staging root is not a directory.");
  }
  return fileReceiptFromStat(metadata);
}

function removeOwnedFile(path, receipt) {
  let metadata;
  try {
    metadata = lstatSync(path, { bigint: true });
  } catch {
    return;
  }
  if (metadata.dev !== receipt.dev || metadata.ino !== receipt.ino || !metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("The Xvfb download temporary file was replaced before cleanup.");
  }
  unlinkSync(path);
}

function removeOwnedDirectory(path, receipt) {
  const metadata = lstatSync(path, { bigint: true });
  if (
    metadata.dev !== receipt.dev ||
    metadata.ino !== receipt.ino ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink()
  ) {
    throw new Error("The Xvfb extraction staging root was replaced before cleanup.");
  }
  rmSync(path, { recursive: true });
}

function writeComplete(fd, value) {
  let offset = 0;
  while (offset < value.byteLength) {
    const written = writeSync(fd, value, offset, value.byteLength - offset);
    if (written <= 0) throw new Error("The Xvfb package download could not be written completely.");
    offset += written;
  }
}

function isDestinationExistsError(error) {
  return error && typeof error === "object" && (error.code === "EEXIST" || error.code === "ENOTEMPTY");
}

function assertExactKeys(value, expected, description) {
  if (!isPlainObject(value)) throw new Error(`${description} must be an object.`);
  const actual = Object.keys(value);
  const unknown = actual.filter((key) => !expected.has(key));
  const missing = [...expected].filter((key) => !Object.hasOwn(value, key));
  if (unknown.length || missing.length) {
    throw new Error(`${description} has unknown or missing fields.`);
  }
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function isMainModule() {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const argument = process.argv[2] ?? "--print-path";
  if (argument !== "--print-path" || process.argv.length > 3) {
    console.error("Usage: node scripts/prepare-xvfb.mjs --print-path");
    process.exitCode = 2;
  } else {
    try {
      console.log(await prepareRepositoryLocalXvfb());
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
