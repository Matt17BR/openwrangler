import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { MAX_VSIX_BYTES } from "./vsix-archive.mjs";

const CHECKSUM_MAX_BYTES = 512;
const PROVENANCE_MAX_BYTES = 4 * 1024;
const activeSets = new WeakSet();

export const CANONICAL_RELEASE_ASSET_SPECS = Object.freeze([
  Object.freeze({
    contentType: "application/octet-stream",
    maximumBytes: MAX_VSIX_BYTES,
    name: "openwrangler.vsix"
  }),
  Object.freeze({
    contentType: "application/json",
    maximumBytes: PROVENANCE_MAX_BYTES,
    name: "openwrangler.vsix.provenance.json"
  }),
  Object.freeze({
    contentType: "text/plain; charset=utf-8",
    maximumBytes: CHECKSUM_MAX_BYTES,
    name: "openwrangler.vsix.sha256"
  })
]);

function fileReceipt(metadata, maximumBytes, label) {
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1n ||
    metadata.size <= 0n ||
    metadata.size > BigInt(maximumBytes) ||
    (typeof process.getuid === "function" && metadata.uid !== BigInt(process.getuid()))
  ) {
    throw new Error(`${label} must be one bounded current-user-owned single-link regular file.`);
  }
  return Object.freeze({
    birthtimeNs: metadata.birthtimeNs,
    ctimeNs: metadata.ctimeNs,
    dev: metadata.dev,
    gid: metadata.gid,
    ino: metadata.ino,
    mode: metadata.mode,
    mtimeNs: metadata.mtimeNs,
    nlink: metadata.nlink,
    size: metadata.size,
    uid: metadata.uid
  });
}

function sameReceipt(left, right) {
  return (
    left.birthtimeNs === right.birthtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.dev === right.dev &&
    left.gid === right.gid &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.uid === right.uid
  );
}

function canonicalDirectory(directory) {
  if (typeof directory !== "string" || directory.length === 0) {
    throw new TypeError("Canonical release assets require one artifact directory.");
  }
  const requested = resolve(directory);
  const metadata = lstatSync(requested, { bigint: true });
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    realpathSync.native(requested) !== requested ||
    (typeof process.getuid === "function" && metadata.uid !== BigInt(process.getuid()))
  ) {
    throw new Error("The canonical release artifact directory must be canonical, owned, and non-symlinked.");
  }
  const expected = CANONICAL_RELEASE_ASSET_SPECS.map(({ name }) => name).sort();
  const entries = readdirSync(requested).sort();
  if (entries.length !== expected.length || entries.some((entry, index) => entry !== expected[index])) {
    throw new Error("The canonical release artifact directory must contain exactly the canonical three files.");
  }
  return requested;
}

function openPinnedAsset(directory, spec) {
  const path = join(directory, spec.name);
  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0) | (constants.O_CLOEXEC ?? 0)
    );
    const opened = fileReceipt(fstatSync(descriptor, { bigint: true }), spec.maximumBytes, spec.name);
    const named = fileReceipt(lstatSync(path, { bigint: true }), spec.maximumBytes, spec.name);
    if (realpathSync.native(path) !== path || !sameReceipt(opened, named)) {
      throw new Error(`${spec.name} changed before its descriptor was pinned.`);
    }
    return { descriptor, opened, path, spec };
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the file-integrity failure that prevented this descriptor from being pinned.
      }
    }
    throw new Error(`${spec.name} could not be pinned as its exact canonical file.`, { cause: error });
  }
}

function readPinnedAsset(entry) {
  const bytes = Buffer.alloc(Number(entry.opened.size));
  let offset = 0;
  while (offset < bytes.length) {
    const count = readSync(entry.descriptor, bytes, offset, bytes.length - offset, null);
    if (!Number.isSafeInteger(count) || count <= 0) {
      throw new Error(`${entry.spec.name} ended before its pinned byte size.`);
    }
    offset += count;
  }
  return bytes;
}

function assertEntryUnchanged(entry) {
  try {
    const descriptor = fileReceipt(
      fstatSync(entry.descriptor, { bigint: true }),
      entry.spec.maximumBytes,
      entry.spec.name
    );
    const named = fileReceipt(lstatSync(entry.path, { bigint: true }), entry.spec.maximumBytes, entry.spec.name);
    if (
      realpathSync.native(entry.path) !== entry.path ||
      !sameReceipt(entry.opened, descriptor) ||
      !sameReceipt(entry.opened, named)
    ) {
      throw new Error("The pinned descriptor and named path no longer identify the same file.");
    }
  } catch (error) {
    throw new Error(`${entry.spec.name} changed while the canonical release set was pinned.`, { cause: error });
  }
}

export function openPinnedCanonicalReleaseAssets(directory, hooks = {}) {
  if (
    hooks === null ||
    typeof hooks !== "object" ||
    (hooks.afterPinnedForTest !== undefined && typeof hooks.afterPinnedForTest !== "function")
  ) {
    throw new TypeError("Canonical release asset hooks are malformed.");
  }
  const canonical = canonicalDirectory(directory);
  const entries = [];
  let closed = false;
  let pinned;
  try {
    for (const spec of CANONICAL_RELEASE_ASSET_SPECS) entries.push(openPinnedAsset(canonical, spec));
    hooks.afterPinnedForTest?.(canonical);
    for (const entry of entries) assertEntryUnchanged(entry);
    const assets = Object.freeze(
      entries.map((entry) => {
        const bytes = readPinnedAsset(entry);
        return Object.freeze({
          bytes,
          contentType: entry.spec.contentType,
          name: entry.spec.name,
          sha256: createHash("sha256").update(bytes).digest("hex")
        });
      })
    );
    const expectedEntries = CANONICAL_RELEASE_ASSET_SPECS.map(({ name }) => name).sort();
    pinned = Object.freeze({
      assertUnchanged() {
        if (closed) throw new Error("The canonical release asset set is already closed.");
        const currentEntries = readdirSync(canonical).sort();
        if (
          currentEntries.length !== expectedEntries.length ||
          currentEntries.some((entry, index) => entry !== expectedEntries[index])
        ) {
          throw new Error("The canonical release artifact inventory changed while it was pinned.");
        }
        for (const entry of entries) assertEntryUnchanged(entry);
        for (const asset of assets) {
          if (createHash("sha256").update(asset.bytes).digest("hex") !== asset.sha256) {
            throw new Error(`${asset.name} bytes changed after semantic verification.`);
          }
        }
      },
      assets,
      close() {
        if (closed) return;
        closed = true;
        let firstError;
        for (const entry of [...entries].reverse()) {
          try {
            closeSync(entry.descriptor);
          } catch (error) {
            firstError ??= error;
          }
        }
        activeSets.delete(pinned);
        if (firstError !== undefined) throw firstError;
      },
      directory: canonical
    });
    activeSets.add(pinned);
    pinned.assertUnchanged();
    return pinned;
  } catch (error) {
    if (pinned !== undefined) activeSets.delete(pinned);
    for (const entry of [...entries].reverse()) {
      try {
        closeSync(entry.descriptor);
      } catch {
        // Preserve the integrity failure that prevented the set from opening.
      }
    }
    throw error;
  }
}

export function requirePinnedCanonicalReleaseAssets(pinned, directory) {
  const canonical = canonicalDirectory(directory);
  if (!activeSets.has(pinned) || pinned.directory !== canonical) {
    throw new Error("Semantic release verification requires the active pinned canonical artifact set.");
  }
  pinned.assertUnchanged();
  return pinned.assets;
}

export async function withPinnedCanonicalReleaseAssets(directory, operation, hooks = {}) {
  if (typeof operation !== "function") {
    throw new TypeError("Canonical release asset pinning requires one operation.");
  }
  const pinned = openPinnedCanonicalReleaseAssets(directory, hooks);
  let result;
  let operationError;
  try {
    result = await operation(pinned);
  } catch (error) {
    operationError = error;
  }
  let closeError;
  try {
    pinned.close();
  } catch (error) {
    closeError = error;
  }
  if (operationError !== undefined) throw operationError;
  if (closeError !== undefined) throw closeError;
  return result;
}
