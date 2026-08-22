import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

import { parseStrictJson } from "./strict-json.mjs";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");

export const REMOTE_R_PACKAGE_LOCK_PATH = resolve(REPOSITORY_ROOT, "scripts", "remote-jupyter", "r-packages.lock.json");
export const REMOTE_R_PACKAGE_LOCK_PROTOCOL = "openwrangler-remote-r-package-lock-v1";
export const REMOTE_R_PACKAGE_LOCK_R_VERSION = "4.5.2";
export const REMOTE_R_PACKAGE_LOCK_MAX_BYTES = 512 * 1024;
export const REMOTE_R_PACKAGE_ARCHIVE_MAX_BYTES = 32 * 1024 * 1024;
export const REMOTE_R_PACKAGE_AGGREGATE_MAX_BYTES = 128 * 1024 * 1024;
export const REMOTE_R_PACKAGE_MAX_COUNT = 128;
export const REMOTE_R_PACKAGE_MAX_DEPENDENCIES = 64;
const DEFAULT_FETCH_DEADLINES = Object.freeze({
  requestHeaderMs: 30_000,
  bodyProgressMs: 30_000,
  aggregateMs: 15 * 60_000
});
const MAX_FETCH_DEADLINE_MS = 30 * 60_000;

export const REMOTE_R_PACKAGE_REPOSITORIES = Object.freeze([
  Object.freeze({
    id: "primary",
    snapshotDate: "2026-03-10",
    url: "https://p3m.dev/cran/__linux__/noble/2026-03-10/src/contrib"
  }),
  Object.freeze({
    id: "supplemental",
    snapshotDate: "2026-06-01",
    url: "https://p3m.dev/cran/__linux__/noble/2026-06-01/src/contrib"
  })
]);

export const REMOTE_R_PACKAGE_ROOTS = Object.freeze({
  runtime: Object.freeze([
    Object.freeze({ name: "IRkernel", repository: "primary" }),
    Object.freeze({ name: "jsonlite", repository: "primary" }),
    Object.freeze({ name: "rlang", repository: "primary" }),
    Object.freeze({ name: "tibble", repository: "primary" }),
    Object.freeze({ name: "data.table", repository: "primary" }),
    Object.freeze({ name: "nanoparquet", repository: "supplemental" })
  ]),
  fixtures: Object.freeze([Object.freeze({ name: "collapse", repository: "supplemental" })])
});

const EXPECTED_ROOT_VERSIONS = Object.freeze({
  IRkernel: "1.3.2",
  jsonlite: "2.0.0",
  rlang: "1.1.7",
  tibble: "3.3.1",
  "data.table": "1.18.2.1",
  collapse: "2.1.7",
  nanoparquet: "0.5.1"
});
const BASE_R_PACKAGES = new Set([
  "R",
  "boot",
  "base",
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
const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9.]{0,63}$/u;
const PACKAGE_VERSION = /^[0-9][0-9A-Za-z.+-]{0,63}$/u;
const LOWER_SHA256 = /^[0-9a-f]{64}$/u;

function contractFailure(message) {
  return new Error(`Remote R package lock contract failed: ${message}`);
}

function fail(message) {
  throw contractFailure(message);
}

function normalizeFetchDeadlines(value) {
  if (value === undefined) return DEFAULT_FETCH_DEADLINES;
  const keys = Object.keys(value ?? {}).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["aggregateMs", "bodyProgressMs", "requestHeaderMs"])) {
    throw new TypeError("Remote R lock generation requires exact fetch deadline fields.");
  }
  for (const key of keys) {
    if (!Number.isSafeInteger(value[key]) || value[key] <= 0 || value[key] > MAX_FETCH_DEADLINE_MS) {
      throw new TypeError("Remote R lock generation fetch deadlines are outside their fixed bound.");
    }
  }
  return Object.freeze({
    requestHeaderMs: value.requestHeaderMs,
    bodyProgressMs: value.bodyProgressMs,
    aggregateMs: value.aggregateMs
  });
}

function linkedAbortController(parentSignal) {
  const controller = new AbortController();
  const forward = () => controller.abort(parentSignal.reason);
  if (parentSignal.aborted) forward();
  else parentSignal.addEventListener("abort", forward, { once: true });
  return {
    controller,
    detach() {
      parentSignal.removeEventListener("abort", forward);
    }
  };
}

function settleBeforeDeadline(operation, signal, timeoutMs, controller, deadlineLabel) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let timer;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () =>
      finish(
        rejectPromise,
        signal.reason instanceof Error ? signal.reason : contractFailure(`${deadlineLabel} was aborted.`)
      );
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      const error = contractFailure(`${deadlineLabel} deadline expired.`);
      controller.abort(error);
      finish(rejectPromise, error);
    }, timeoutMs);
    Promise.resolve(operation).then(
      (value) => finish(resolvePromise, value),
      (error) => finish(rejectPromise, error)
    );
  });
}

function enforceAggregateDeadline(deadline, controller) {
  if (performance.now() < deadline) return;
  const error = contractFailure("remote R lock fetch aggregate deadline expired.");
  controller.abort(error);
  throw error;
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function exactKeys(value, expected, label) {
  if (!isPlainObject(value) || JSON.stringify(Object.keys(value)) !== JSON.stringify(expected)) {
    fail(`${label} must have the exact canonical fields ${expected.join(", ")}.`);
  }
}

function validateRootList(value, expected, label) {
  if (!Array.isArray(value) || value.length !== expected.length) {
    fail(`${label} must contain the complete ordered root inventory.`);
  }
  value.forEach((root, index) => {
    exactKeys(root, ["name", "repository"], `${label}[${index}]`);
    if (root.name !== expected[index].name || root.repository !== expected[index].repository) {
      fail(`${label} must preserve the canonical root order and repository ownership.`);
    }
  });
}

function walkReachability(rootNames, packagesByName) {
  const reached = new Set();
  const visit = (name) => {
    if (reached.has(name)) return;
    const entry = packagesByName.get(name);
    if (!entry) fail(`root or dependency ${name} is missing.`);
    reached.add(name);
    for (const dependency of entry.dependencies) visit(dependency);
  };
  for (const name of rootNames) visit(name);
  return reached;
}

export function remoteRPackageLockDigest(text) {
  if (typeof text !== "string") fail("lock bytes must be UTF-8 text.");
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function canonicalRemoteRPackageLockText(lock) {
  const lines = JSON.stringify(lock, null, 2).split("\n");
  const canonical = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.endsWith('"dependencies": [')) {
      canonical.push(line);
      continue;
    }
    const indent = line.slice(0, line.indexOf('"dependencies"'));
    const values = [];
    let cursor = index + 1;
    while (cursor < lines.length && lines[cursor] !== `${indent}],`) {
      const value = /^\s+"([^"\\]+)"[,]?$/u.exec(lines[cursor])?.[1];
      if (value === undefined) fail("dependencies could not be serialized canonically.");
      values.push(value);
      cursor += 1;
    }
    if (cursor >= lines.length) fail("dependencies could not be serialized canonically.");
    const inlineValues = `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
    const inline = `${indent}"dependencies": ${inlineValues},`;
    if (inline.length <= 120) {
      canonical.push(inline);
      index = cursor;
    } else {
      canonical.push(line);
    }
  }
  return `${canonical.join("\n")}\n`;
}

export function validateRemoteRPackageLock(text) {
  if (
    typeof text !== "string" ||
    Buffer.byteLength(text, "utf8") === 0 ||
    Buffer.byteLength(text, "utf8") > REMOTE_R_PACKAGE_LOCK_MAX_BYTES ||
    !text.endsWith("\n") ||
    text.includes("\r") ||
    text.includes("\0")
  ) {
    fail("lock bytes must be bounded canonical LF-terminated UTF-8 text.");
  }

  let lock;
  try {
    lock = parseStrictJson(text);
  } catch {
    fail("lock must be strict JSON without duplicate keys.");
  }
  exactKeys(lock, ["protocol", "target", "repositories", "roots", "packages"], "lock");
  if (lock.protocol !== REMOTE_R_PACKAGE_LOCK_PROTOCOL) fail("protocol is not supported.");

  exactKeys(lock.target, ["rVersion", "os", "distribution", "codename", "architecture"], "target");
  if (
    lock.target.rVersion !== REMOTE_R_PACKAGE_LOCK_R_VERSION ||
    lock.target.os !== "linux" ||
    lock.target.distribution !== "ubuntu" ||
    lock.target.codename !== "noble" ||
    lock.target.architecture !== "x86_64"
  ) {
    fail("target must be exact R 4.5.2 on Ubuntu noble x86_64.");
  }

  if (!Array.isArray(lock.repositories) || lock.repositories.length !== REMOTE_R_PACKAGE_REPOSITORIES.length) {
    fail("repository inventory must be complete.");
  }
  lock.repositories.forEach((repository, index) => {
    exactKeys(repository, ["id", "snapshotDate", "url"], `repositories[${index}]`);
    const expected = REMOTE_R_PACKAGE_REPOSITORIES[index];
    if (
      repository.id !== expected.id ||
      repository.snapshotDate !== expected.snapshotDate ||
      repository.url !== expected.url
    ) {
      fail("repository inventory must retain the exact dated canonical URLs.");
    }
  });

  exactKeys(lock.roots, ["runtime", "fixtures"], "roots");
  validateRootList(lock.roots.runtime, REMOTE_R_PACKAGE_ROOTS.runtime, "roots.runtime");
  validateRootList(lock.roots.fixtures, REMOTE_R_PACKAGE_ROOTS.fixtures, "roots.fixtures");

  if (
    !Array.isArray(lock.packages) ||
    lock.packages.length === 0 ||
    lock.packages.length > REMOTE_R_PACKAGE_MAX_COUNT
  ) {
    fail("package inventory is empty or outside its fixed bound.");
  }
  const repositories = new Map(lock.repositories.map((repository) => [repository.id, repository]));
  const packagesByName = new Map();
  let aggregateBytes = 0;
  lock.packages.forEach((entry, index) => {
    exactKeys(
      entry,
      [
        "name",
        "version",
        "category",
        "direct",
        "repository",
        "sourceUrl",
        "url",
        "bytes",
        "sha256",
        "dependencies",
        "installOrder"
      ],
      `packages[${index}]`
    );
    if (!PACKAGE_NAME.test(entry.name) || !PACKAGE_VERSION.test(entry.version)) {
      fail(`package ${index} has an unsafe name or version.`);
    }
    if (packagesByName.has(entry.name)) fail(`package ${entry.name} is duplicated.`);
    if (!repositories.has(entry.repository)) fail(`package ${entry.name} names an unknown repository.`);
    if (!["runtime", "fixture"].includes(entry.category) || typeof entry.direct !== "boolean") {
      fail(`package ${entry.name} has invalid category metadata.`);
    }
    const expectedSourceUrl = `${repositories.get(entry.repository).url}/${entry.name}_${entry.version}.tar.gz`;
    if (entry.sourceUrl !== expectedSourceUrl) {
      fail(`package ${entry.name} source URL is not derived from its repository and pin.`);
    }
    if (
      entry.url !== expectedSourceUrl &&
      !/^https:\/\/rspm-sync\.rstudio\.com\/v4\/1\/packages\/[0-9a-f]{64}\.tar\.gz$/u.test(entry.url)
    ) {
      fail(`package ${entry.name} archive URL is not one admitted immutable P3M target.`);
    }
    if (
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes <= 0 ||
      entry.bytes > REMOTE_R_PACKAGE_ARCHIVE_MAX_BYTES ||
      !LOWER_SHA256.test(entry.sha256)
    ) {
      fail(`package ${entry.name} has invalid archive bounds or digest.`);
    }
    aggregateBytes += entry.bytes;
    if (!Number.isSafeInteger(aggregateBytes) || aggregateBytes > REMOTE_R_PACKAGE_AGGREGATE_MAX_BYTES) {
      fail("aggregate archive bytes exceed the fixed bound.");
    }
    if (
      !Array.isArray(entry.dependencies) ||
      entry.dependencies.length > REMOTE_R_PACKAGE_MAX_DEPENDENCIES ||
      entry.dependencies.some((dependency) => !PACKAGE_NAME.test(dependency)) ||
      new Set(entry.dependencies).size !== entry.dependencies.length ||
      entry.dependencies.some(
        (dependency, dependencyIndex) => dependencyIndex > 0 && entry.dependencies[dependencyIndex - 1] >= dependency
      )
    ) {
      fail(`package ${entry.name} dependencies must be bounded, unique, and sorted.`);
    }
    if (entry.installOrder !== index + 1) fail("install order must be exact and contiguous.");
    packagesByName.set(entry.name, entry);
  });

  for (const entry of lock.packages) {
    for (const dependency of entry.dependencies) {
      const dependencyEntry = packagesByName.get(dependency);
      if (!dependencyEntry) fail(`package ${entry.name} has missing dependency ${dependency}.`);
      if (dependencyEntry.installOrder >= entry.installOrder) {
        fail(`package ${entry.name} is not ordered after dependency ${dependency}.`);
      }
    }
  }

  const runtimeRoots = lock.roots.runtime.map(({ name }) => name);
  const fixtureRoots = lock.roots.fixtures.map(({ name }) => name);
  const runtimeReachable = walkReachability(runtimeRoots, packagesByName);
  const fixtureReachable = walkReachability(fixtureRoots, packagesByName);
  const allReachable = new Set([...runtimeReachable, ...fixtureReachable]);
  if (allReachable.size !== lock.packages.length) fail("package inventory contains an unreachable package.");
  const runtimeRootSet = new Set(runtimeRoots);
  for (const entry of lock.packages) {
    const expectedCategory = runtimeReachable.has(entry.name) ? "runtime" : "fixture";
    if (entry.category !== expectedCategory) fail(`package ${entry.name} has incorrect category reachability.`);
    if (entry.direct !== runtimeRootSet.has(entry.name)) {
      fail(`package ${entry.name} has incorrect runtime-direct classification.`);
    }
  }
  for (const [name, expectedVersion] of Object.entries(EXPECTED_ROOT_VERSIONS)) {
    if (packagesByName.get(name)?.version !== expectedVersion) fail(`root ${name} version drifted.`);
  }
  const expectedRepositories = new Map();
  const claimRepository = (name, repository) => {
    if (expectedRepositories.has(name)) return;
    expectedRepositories.set(name, repository);
    for (const dependency of packagesByName.get(name).dependencies) claimRepository(dependency, repository);
  };
  for (const root of [...lock.roots.runtime, ...lock.roots.fixtures]) {
    claimRepository(root.name, root.repository);
  }
  for (const entry of lock.packages) {
    if (entry.repository !== expectedRepositories.get(entry.name)) {
      fail(`package ${entry.name} crossed its canonical repository ownership.`);
    }
  }

  const canonical = canonicalRemoteRPackageLockText(lock);
  if (text !== canonical) fail("lock JSON is not canonical.");
  return Object.freeze({
    lock,
    digest: remoteRPackageLockDigest(text),
    packageCount: lock.packages.length,
    aggregateBytes
  });
}

export async function readRemoteRPackageLockFile(path = REMOTE_R_PACKAGE_LOCK_PATH) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size <= 0n ||
      before.size > BigInt(REMOTE_R_PACKAGE_LOCK_MAX_BYTES)
    ) {
      fail("lock path must be one bounded unaliased regular file.");
    }
    const identity = [
      before.dev,
      before.ino,
      before.mode,
      before.nlink,
      before.uid,
      before.gid,
      before.size,
      before.mtimeNs,
      before.ctimeNs
    ];
    const text = await handle.readFile("utf8");
    const after = await handle.stat({ bigint: true });
    const afterIdentity = [
      after.dev,
      after.ino,
      after.mode,
      after.nlink,
      after.uid,
      after.gid,
      after.size,
      after.mtimeNs,
      after.ctimeNs
    ];
    if (identity.some((value, index) => value !== afterIdentity[index])) {
      fail("lock identity changed while reading.");
    }
    return validateRemoteRPackageLock(text);
  } finally {
    await handle.close();
  }
}

function parseDcfPackages(text, repositoryId) {
  if (typeof text !== "string" || text.length === 0 || text.length > 32 * 1024 * 1024 || text.includes("\0")) {
    fail(`repository ${repositoryId} metadata is outside its fixed bound.`);
  }
  const packages = new Map();
  for (const paragraph of text.replaceAll("\r\n", "\n").split(/\n\n+/u)) {
    if (paragraph.trim() === "") continue;
    const fields = new Map();
    let current;
    for (const line of paragraph.split("\n")) {
      if (/^[ \t]/u.test(line) && current !== undefined) {
        fields.set(current, `${fields.get(current)} ${line.trim()}`);
        continue;
      }
      const match = /^([^:]+):[ \t]*(.*)$/u.exec(line);
      if (!match) fail(`repository ${repositoryId} metadata contains malformed DCF.`);
      current = match[1];
      fields.set(current, match[2]);
    }
    const name = fields.get("Package");
    const version = fields.get("Version");
    if (BASE_R_PACKAGES.has(name)) continue;
    if (fields.has("Path")) continue;
    if (!PACKAGE_NAME.test(name ?? "") || !PACKAGE_VERSION.test(version ?? "")) {
      fail(`repository ${repositoryId} metadata contains an invalid package.`);
    }
    const dependencies = new Set();
    for (const field of ["Depends", "Imports", "LinkingTo"]) {
      const value = fields.get(field);
      if (!value) continue;
      for (const specification of value.split(",")) {
        const dependency = /^\s*([A-Za-z][A-Za-z0-9.]*)/u.exec(specification)?.[1];
        if (!dependency) fail(`package ${name} contains an invalid dependency.`);
        if (!BASE_R_PACKAGES.has(dependency)) dependencies.add(dependency);
      }
    }
    if (dependencies.size > REMOTE_R_PACKAGE_MAX_DEPENDENCIES) fail(`package ${name} has too many dependencies.`);
    const candidate = { name, version, dependencies: [...dependencies].sort() };
    const existing = packages.get(name);
    if (existing) {
      if (
        existing.version !== candidate.version ||
        JSON.stringify(existing.dependencies) !== JSON.stringify(candidate.dependencies)
      ) {
        fail(`repository ${repositoryId} metadata contains ambiguous duplicate package ${name}.`);
      }
      continue;
    }
    packages.set(name, candidate);
  }
  return packages;
}

async function fetchBounded(
  url,
  maximumBytes,
  fetchImpl,
  {
    expectedBytes,
    allowArchiveRedirect = false,
    hashOnly = false,
    signal,
    aggregateDeadline,
    requestHeaderTimeoutMs,
    bodyProgressTimeoutMs
  } = {}
) {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "p3m.dev" ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    fail("network generation accepts only canonical P3M HTTPS URLs.");
  }
  if (!(signal instanceof AbortSignal)) throw new TypeError("Remote R lock generation requires an AbortSignal.");
  if (!Number.isFinite(aggregateDeadline)) {
    throw new TypeError("Remote R lock generation requires one absolute aggregate deadline.");
  }
  const { controller, detach } = linkedAbortController(signal);
  try {
    enforceAggregateDeadline(aggregateDeadline, controller);
    const response = await settleBeforeDeadline(
      Promise.resolve().then(() =>
        fetchImpl(url, {
          method: "GET",
          redirect: allowArchiveRedirect ? "follow" : "error",
          headers: { accept: "*/*" },
          signal: controller.signal
        })
      ),
      controller.signal,
      requestHeaderTimeoutMs,
      controller,
      `download ${url} request-header`
    );
    const finalUrl = response?.url;
    const admittedFinalUrl =
      finalUrl === url ||
      (allowArchiveRedirect &&
        /^https:\/\/rspm-sync\.rstudio\.com\/v4\/1\/packages\/[0-9a-f]{64}\.tar\.gz$/u.test(finalUrl ?? ""));
    if (!response || response.status !== 200 || !admittedFinalUrl || !response.body) {
      fail(`download ${url} did not return one exact immutable response.`);
    }
    const declared = response.headers?.get?.("content-length");
    if (declared !== null && declared !== undefined) {
      const parsedLength = Number(declared);
      if (!Number.isSafeInteger(parsedLength) || parsedLength <= 0 || parsedLength > maximumBytes) {
        fail(`download ${url} declared an invalid size.`);
      }
      if (expectedBytes !== undefined && parsedLength !== expectedBytes) fail(`download ${url} size drifted.`);
    }
    const iterator = response.body[Symbol.asyncIterator]?.();
    if (!iterator || typeof iterator.next !== "function") fail(`download ${url} has no bounded async body.`);
    const chunks = [];
    const digest = hashOnly ? createHash("sha256") : undefined;
    let total = 0;
    for (;;) {
      enforceAggregateDeadline(aggregateDeadline, controller);
      const item = await settleBeforeDeadline(
        Promise.resolve().then(() => iterator.next()),
        controller.signal,
        bodyProgressTimeoutMs,
        controller,
        `download ${url} body-progress`
      );
      enforceAggregateDeadline(aggregateDeadline, controller);
      if (item.done) break;
      const bytes = Buffer.from(item.value);
      if (bytes.length === 0) fail(`download ${url} returned a zero-byte body chunk.`);
      total += bytes.length;
      if (total > maximumBytes || (expectedBytes !== undefined && total > expectedBytes)) {
        fail(`download ${url} exceeded its streaming bound.`);
      }
      if (hashOnly) digest.update(bytes);
      else chunks.push(bytes);
    }
    if (total === 0 || (expectedBytes !== undefined && total !== expectedBytes)) fail(`download ${url} size drifted.`);
    return {
      bytes: hashOnly ? undefined : Buffer.concat(chunks, total),
      byteLength: total,
      sha256: digest?.digest("hex"),
      finalUrl
    };
  } catch (error) {
    if (!controller.signal.aborted) controller.abort(error);
    throw error;
  } finally {
    detach();
  }
}

export async function generateRemoteRPackageLock({ fetchImpl = globalThis.fetch, deadlines } = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("Remote R lock generation requires a fetch implementation.");
  const fetchDeadlines = normalizeFetchDeadlines(deadlines);
  const aggregateController = new AbortController();
  const aggregateDeadline = performance.now() + fetchDeadlines.aggregateMs;
  const aggregateTimer = setTimeout(() => {
    aggregateController.abort(contractFailure("remote R lock fetch aggregate deadline expired."));
  }, fetchDeadlines.aggregateMs);
  const deadlineOptions = {
    signal: aggregateController.signal,
    aggregateDeadline,
    requestHeaderTimeoutMs: fetchDeadlines.requestHeaderMs,
    bodyProgressTimeoutMs: fetchDeadlines.bodyProgressMs
  };
  try {
    const metadataByRepository = new Map();
    for (const repository of REMOTE_R_PACKAGE_REPOSITORIES) {
      const { bytes: compressed } = await fetchBounded(
        `${repository.url}/PACKAGES.gz`,
        16 * 1024 * 1024,
        fetchImpl,
        deadlineOptions
      );
      let metadata;
      try {
        metadata = gunzipSync(compressed, { maxOutputLength: 32 * 1024 * 1024 }).toString("utf8");
      } catch {
        fail(`repository ${repository.id} metadata could not be decoded within bounds.`);
      }
      metadataByRepository.set(repository.id, parseDcfPackages(metadata, repository.id));
    }

    const selected = new Map();
    const select = (name, repositoryId) => {
      if (BASE_R_PACKAGES.has(name) || selected.has(name)) return;
      const metadata = metadataByRepository.get(repositoryId)?.get(name);
      if (!metadata) fail(`repository ${repositoryId} does not contain required package ${name}.`);
      selected.set(name, { ...metadata, repository: repositoryId });
      for (const dependency of metadata.dependencies) select(dependency, repositoryId);
    };
    for (const root of [...REMOTE_R_PACKAGE_ROOTS.runtime, ...REMOTE_R_PACKAGE_ROOTS.fixtures]) {
      select(root.name, root.repository);
    }
    if (selected.size === 0 || selected.size > REMOTE_R_PACKAGE_MAX_COUNT)
      fail("generated closure exceeds its package bound.");

    const ordered = [];
    const visiting = new Set();
    const visited = new Set();
    const visit = (name) => {
      if (visited.has(name)) return;
      if (visiting.has(name)) fail(`package dependency cycle includes ${name}.`);
      visiting.add(name);
      for (const dependency of selected.get(name).dependencies) visit(dependency);
      visiting.delete(name);
      visited.add(name);
      ordered.push(name);
    };
    for (const name of [...selected.keys()].sort()) visit(name);

    const dependencyOnly = new Map(
      [...selected].map(([name, entry]) => [
        name,
        { dependencies: entry.dependencies.filter((dependency) => selected.has(dependency)) }
      ])
    );
    const runtimeReachable = walkReachability(
      REMOTE_R_PACKAGE_ROOTS.runtime.map(({ name }) => name),
      dependencyOnly
    );
    const runtimeRoots = new Set(REMOTE_R_PACKAGE_ROOTS.runtime.map(({ name }) => name));
    const repositories = new Map(REMOTE_R_PACKAGE_REPOSITORIES.map((repository) => [repository.id, repository]));
    const packages = [];
    let aggregateBytes = 0;
    for (const [index, name] of ordered.entries()) {
      const entry = selected.get(name);
      const sourceUrl = `${repositories.get(entry.repository).url}/${name}_${entry.version}.tar.gz`;
      const {
        byteLength,
        sha256,
        finalUrl: url
      } = await fetchBounded(sourceUrl, REMOTE_R_PACKAGE_ARCHIVE_MAX_BYTES, fetchImpl, {
        ...deadlineOptions,
        allowArchiveRedirect: true,
        hashOnly: true
      });
      aggregateBytes += byteLength;
      if (aggregateBytes > REMOTE_R_PACKAGE_AGGREGATE_MAX_BYTES) fail("generated archives exceed the aggregate bound.");
      packages.push({
        name,
        version: entry.version,
        category: runtimeReachable.has(name) ? "runtime" : "fixture",
        direct: runtimeRoots.has(name),
        repository: entry.repository,
        sourceUrl,
        url,
        bytes: byteLength,
        sha256,
        dependencies: entry.dependencies.filter((dependency) => selected.has(dependency)),
        installOrder: index + 1
      });
    }
    const text = canonicalRemoteRPackageLockText({
      protocol: REMOTE_R_PACKAGE_LOCK_PROTOCOL,
      target: {
        rVersion: REMOTE_R_PACKAGE_LOCK_R_VERSION,
        os: "linux",
        distribution: "ubuntu",
        codename: "noble",
        architecture: "x86_64"
      },
      repositories: REMOTE_R_PACKAGE_REPOSITORIES,
      roots: REMOTE_R_PACKAGE_ROOTS,
      packages
    });
    validateRemoteRPackageLock(text);
    return text;
  } finally {
    clearTimeout(aggregateTimer);
  }
}

async function main() {
  const result = await readRemoteRPackageLockFile();
  process.stdout.write(
    `Remote R package lock is canonical: ${result.packageCount} packages, ${result.aggregateBytes} archive bytes, ${result.digest}.\n`
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
