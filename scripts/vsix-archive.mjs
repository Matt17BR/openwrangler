import fs from "node:fs";
import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { fromBuffer as openZipBuffer } from "yauzl";
import { parseStrictJson } from "./strict-json.mjs";
import { inspectVsixEntries, requiredVsixEntriesForRelease, VENDORED_JS_YAML_ENTRY } from "./vsix-contents.mjs";

export const MAX_VSIX_BYTES = 128 * 1024 * 1024;
export const MAX_VSIX_ENTRIES = 4096;
export const MAX_VSIX_ENTRY_NAME_BYTES = 1024;
export const MAX_VSIX_ENTRY_BYTES = 32 * 1024 * 1024;
export const MAX_VSIX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
export const VENDORED_JS_YAML_BYTES = 122_488;
export const VENDORED_JS_YAML_SHA256 = "f1499c20ab232a283f6f9f85aeecc99dceab175e8dd4005bd3d764848f3e5965";

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function unchangedFileSnapshot(before, after) {
  return (
    sameFileIdentity(before, after) &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

function namedPathMatchesDescriptor(pathIdentity, descriptorIdentity) {
  return (
    pathIdentity.isFile() &&
    pathIdentity.nlink === 1n &&
    descriptorIdentity.isFile() &&
    descriptorIdentity.nlink === 1n &&
    sameFileIdentity(pathIdentity, descriptorIdentity)
  );
}

export function readBoundedVsixFileSnapshot(vsixPath, { requireOwner = false } = {}) {
  if (typeof requireOwner !== "boolean") {
    throw new TypeError("VSIX snapshot ownership policy must be boolean.");
  }
  const absolutePath = resolve(vsixPath);
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  let descriptor;
  try {
    try {
      descriptor = fs.openSync(absolutePath, fs.constants.O_RDONLY | noFollow);
    } catch (error) {
      throw new Error(
        error?.code === "ELOOP"
          ? "VSIX candidate must be one regular, unlinked file."
          : `VSIX candidate cannot be inspected: ${basename(absolutePath)}.`,
        { cause: error }
      );
    }

    const before = fs.fstatSync(descriptor, { bigint: true });
    let namedBefore;
    try {
      namedBefore = fs.lstatSync(absolutePath, { bigint: true });
    } catch (error) {
      throw new Error("VSIX candidate path changed before its descriptor was validated.", { cause: error });
    }
    if (
      !namedPathMatchesDescriptor(namedBefore, before) ||
      (requireOwner && typeof process.getuid === "function" && before.uid !== BigInt(process.getuid()))
    ) {
      throw new Error("VSIX candidate must be one regular, unlinked file with the required ownership.");
    }
    if (before.size <= 0n || before.size > BigInt(MAX_VSIX_BYTES)) {
      throw new Error(`VSIX candidate must be between 1 and ${MAX_VSIX_BYTES} bytes.`);
    }

    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    let namedAfter;
    try {
      namedAfter = fs.lstatSync(absolutePath, { bigint: true });
    } catch (error) {
      throw new Error("VSIX candidate path changed while its descriptor snapshot was read.", { cause: error });
    }
    if (
      bytes.length !== Number(before.size) ||
      !unchangedFileSnapshot(before, after) ||
      !namedPathMatchesDescriptor(namedAfter, after)
    ) {
      throw new Error("VSIX candidate changed while its descriptor snapshot was read.");
    }

    return Object.freeze({
      bytes,
      identity: Object.freeze({
        ctimeNs: after.ctimeNs,
        dev: after.dev,
        ino: after.ino,
        mtimeNs: after.mtimeNs,
        size: after.size
      })
    });
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
}

const UNIX_CREATOR = 3;
const UNIX_FILE_TYPE = 0o170000;
const UNIX_REGULAR_FILE = 0o100000;
const UNIX_DIRECTORY = 0o040000;
const SUPPORTED_ZIP_FLAGS = 0x0808;
const REQUIRED_CAPTURE_LIMITS = new Map([
  ["[Content_Types].xml", 1024 * 1024],
  ["extension.vsixmanifest", 1024 * 1024],
  ["extension/package.json", 1024 * 1024],
  ["extension/readme.md", 2 * 1024 * 1024],
  ["extension/changelog.md", 2 * 1024 * 1024],
  ["extension/LICENSE.txt", 1024 * 1024],
  ["extension/THIRD_PARTY_NOTICES.md", 2 * 1024 * 1024],
  ["extension/dist/extension/webviewPanel.js", 8 * 1024 * 1024],
  [VENDORED_JS_YAML_ENTRY, VENDORED_JS_YAML_BYTES],
  ["extension/media/webview.css", 8 * 1024 * 1024],
  ["extension/media/notebookRenderer.js", 8 * 1024 * 1024],
  ["extension/python/openwrangler_runtime/version.py", 64 * 1024]
]);
const PACKAGED_COMMONJS_ENTRY = /^extension\/dist\/(?:extension|shared)\/.+\.js$/u;
const PACKAGED_COMMONJS_MAX_ENTRY_BYTES = 4 * 1024 * 1024;

const crcTable = new Uint32Array(256);
for (let index = 0; index < crcTable.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  crcTable[index] = value >>> 0;
}

function updateCrc32(crc, chunk) {
  let value = crc;
  for (const byte of chunk) {
    value = (crcTable[(value ^ byte) & 0xff] ^ (value >>> 8)) >>> 0;
  }
  return value;
}

function openArchive(bytes) {
  return new Promise((resolveArchive, rejectArchive) => {
    openZipBuffer(
      bytes,
      {
        autoClose: true,
        decodeStrings: true,
        lazyEntries: true,
        strictFileNames: true,
        validateEntrySizes: true
      },
      (error, archive) => {
        if (error) {
          rejectArchive(error);
        } else if (archive === undefined) {
          rejectArchive(new Error("VSIX bytes did not open as a ZIP archive."));
        } else {
          resolveArchive(archive);
        }
      }
    );
  });
}

function inspectEntryMetadata(entry) {
  if (Buffer.byteLength(entry.fileName, "utf8") > MAX_VSIX_ENTRY_NAME_BYTES) {
    throw new Error(`VSIX entry name exceeds ${MAX_VSIX_ENTRY_NAME_BYTES} UTF-8 bytes.`);
  }
  if ((entry.generalPurposeBitFlag & ~SUPPORTED_ZIP_FLAGS) !== 0) {
    throw new Error(`VSIX entry ${entry.fileName} uses unsupported or encrypted ZIP flags.`);
  }
  if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
    throw new Error(`VSIX entry ${entry.fileName} uses unsupported compression method ${entry.compressionMethod}.`);
  }
  if (
    !Number.isSafeInteger(entry.compressedSize) ||
    !Number.isSafeInteger(entry.uncompressedSize) ||
    entry.compressedSize < 0 ||
    entry.uncompressedSize < 0 ||
    entry.uncompressedSize > MAX_VSIX_ENTRY_BYTES
  ) {
    throw new Error(`VSIX entry ${entry.fileName} exceeds its per-entry size limit.`);
  }

  const creator = (entry.versionMadeBy >>> 8) & 0xff;
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const type = mode & UNIX_FILE_TYPE;
  const isDirectory = entry.fileName.endsWith("/");
  if (
    creator !== UNIX_CREATOR ||
    (isDirectory ? type !== UNIX_DIRECTORY : type !== UNIX_REGULAR_FILE) ||
    (isDirectory && (entry.compressedSize !== 0 || entry.uncompressedSize !== 0))
  ) {
    throw new Error(`VSIX entry ${entry.fileName} must be a regular file or matching directory entry.`);
  }
}

function readEntry(archive, entry, captureLimit) {
  return new Promise((resolveEntry, rejectEntry) => {
    archive.openReadStream(entry, (openError, stream) => {
      if (openError !== null) {
        rejectEntry(openError);
        return;
      }
      if (stream === undefined) {
        rejectEntry(new Error(`VSIX entry ${entry.fileName} could not be opened.`));
        return;
      }

      const chunks = [];
      let actualSize = 0;
      let crc = 0xffffffff;
      const sha256 = createHash("sha256");
      stream.on("data", (chunk) => {
        actualSize += chunk.length;
        crc = updateCrc32(crc, chunk);
        sha256.update(chunk);
        if (captureLimit !== undefined) {
          if (actualSize > captureLimit) {
            stream.destroy(new Error(`VSIX entry ${entry.fileName} exceeds its capture limit.`));
          } else {
            chunks.push(chunk);
          }
        }
      });
      stream.once("error", rejectEntry);
      stream.once("end", () => {
        const actualCrc = (crc ^ 0xffffffff) >>> 0;
        if (actualSize !== entry.uncompressedSize) {
          rejectEntry(new Error(`VSIX entry ${entry.fileName} did not produce its declared size.`));
          return;
        }
        if (actualCrc !== entry.crc32) {
          rejectEntry(new Error(`VSIX entry ${entry.fileName} failed CRC-32 validation.`));
          return;
        }
        resolveEntry({
          bytes: captureLimit === undefined ? undefined : Buffer.concat(chunks, actualSize),
          size: actualSize,
          sha256: sha256.digest("hex")
        });
      });
    });
  });
}

function normalizeManifestAsset(value) {
  if (typeof value !== "string" || value.length === 0 || value.startsWith("$(")) {
    return undefined;
  }
  const withoutPrefix = value.startsWith("./") ? value.slice(2) : value;
  if (
    withoutPrefix.length === 0 ||
    withoutPrefix.startsWith("/") ||
    withoutPrefix.includes("\\") ||
    withoutPrefix.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`Packaged package.json contains invalid asset path ${JSON.stringify(value)}.`);
  }
  return `extension/${withoutPrefix}`;
}

function referencedManifestAssets(packageJson) {
  const references = [];
  const add = (value) => {
    const normalized = normalizeManifestAsset(value);
    if (normalized !== undefined) {
      references.push(normalized);
    }
  };

  add(packageJson.main);
  add(packageJson.browser);
  add(packageJson.icon);
  for (const containers of Object.values(packageJson.contributes?.viewsContainers ?? {})) {
    if (Array.isArray(containers)) {
      for (const container of containers) {
        add(container?.icon);
      }
    }
  }
  for (const renderer of packageJson.contributes?.notebookRenderer ?? []) {
    add(renderer?.entrypoint);
  }
  for (const notebook of packageJson.contributes?.notebooks ?? []) {
    add(notebook?.icon);
  }
  for (const command of packageJson.contributes?.commands ?? []) {
    if (typeof command?.icon === "string") {
      add(command.icon);
    } else {
      add(command?.icon?.light);
      add(command?.icon?.dark);
    }
  }
  for (const walkthrough of packageJson.contributes?.walkthroughs ?? []) {
    for (const step of walkthrough?.steps ?? []) {
      add(step?.media?.image);
      add(step?.media?.markdown);
    }
  }
  return [...new Set(references)];
}

function decodeUtf8(contents, name) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(contents);
  } catch (error) {
    throw new Error(`VSIX entry ${name} must be valid UTF-8.`, { cause: error });
  }
}

export async function inspectVsixArchive(bytes, { requireRFrameContract = true, requireVendoredJsYaml = true } = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_VSIX_BYTES) {
    throw new Error(`VSIX input must be one non-empty Buffer no larger than ${MAX_VSIX_BYTES} bytes.`);
  }
  const requiredEntries = requiredVsixEntriesForRelease({ requireRFrameContract, requireVendoredJsYaml });
  const archive = await openArchive(bytes);
  const entries = [];
  const entryKinds = new Map();
  const entrySizes = new Map();
  const entryDigests = new Map();
  const contents = new Map();
  const packagedCommonJsModules = new Map();
  let totalCompressedBytes = 0;
  let totalUncompressedBytes = 0;

  await new Promise((resolveInspection, rejectInspection) => {
    let settled = false;
    const reject = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        archive.close();
      } catch {
        // The first archive validation failure remains authoritative.
      }
      rejectInspection(error);
    };

    archive.once("error", reject);
    archive.on("entry", async (entry) => {
      try {
        if (entries.length >= MAX_VSIX_ENTRIES) {
          throw new Error(`VSIX archive exceeds ${MAX_VSIX_ENTRIES} entries.`);
        }
        inspectEntryMetadata(entry);
        totalCompressedBytes += entry.compressedSize;
        totalUncompressedBytes += entry.uncompressedSize;
        if (totalCompressedBytes > MAX_VSIX_BYTES || totalUncompressedBytes > MAX_VSIX_UNCOMPRESSED_BYTES) {
          throw new Error("VSIX archive exceeds its aggregate size budget.");
        }

        entries.push(entry.fileName);
        entryKinds.set(entry.fileName, entry.fileName.endsWith("/") ? "directory" : "file");
        const isPackagedCommonJs = PACKAGED_COMMONJS_ENTRY.test(entry.fileName);
        const captureLimit =
          REQUIRED_CAPTURE_LIMITS.get(entry.fileName) ??
          (isPackagedCommonJs ? PACKAGED_COMMONJS_MAX_ENTRY_BYTES : undefined);
        const result = await readEntry(archive, entry, captureLimit);
        entrySizes.set(entry.fileName, result.size);
        entryDigests.set(entry.fileName, result.sha256);
        if (result.bytes !== undefined) {
          contents.set(entry.fileName, result.bytes);
          if (isPackagedCommonJs) {
            packagedCommonJsModules.set(
              entry.fileName.slice("extension/dist/".length),
              decodeUtf8(result.bytes, entry.fileName)
            );
          }
        }
        if (!settled) {
          archive.readEntry();
        }
      } catch (error) {
        reject(error);
      }
    });
    archive.once("end", () => {
      if (settled) {
        return;
      }
      settled = true;
      resolveInspection();
    });
    archive.readEntry();
  });

  const inventory = inspectVsixEntries(entries, { requireRFrameContract, requireVendoredJsYaml });
  if (inventory.forbidden.length > 0 || inventory.missing.length > 0 || inventory.duplicates.length > 0) {
    throw new Error(
      [
        "VSIX archive does not satisfy the production inventory.",
        inventory.forbidden.length > 0 ? `Forbidden: ${inventory.forbidden.join(", ")}` : "",
        inventory.missing.length > 0 ? `Missing: ${inventory.missing.join(", ")}` : "",
        inventory.duplicates.length > 0 ? `Colliding archive paths: ${inventory.duplicates.join(", ")}` : ""
      ]
        .filter(Boolean)
        .join(" ")
    );
  }
  for (const required of requiredEntries) {
    if (entryKinds.get(required) !== "file") {
      throw new Error(`VSIX required entry ${required} must be a regular file.`);
    }
    if (entrySizes.get(required) === 0) {
      throw new Error(`VSIX required entry ${required} must be non-empty.`);
    }
  }
  const vendoredJsYamlContents = contents.get(VENDORED_JS_YAML_ENTRY);
  if (
    (requireVendoredJsYaml || vendoredJsYamlContents !== undefined) &&
    (vendoredJsYamlContents === undefined ||
      entrySizes.get(VENDORED_JS_YAML_ENTRY) !== VENDORED_JS_YAML_BYTES ||
      entryDigests.get(VENDORED_JS_YAML_ENTRY) !== VENDORED_JS_YAML_SHA256)
  ) {
    throw new Error("VSIX vendored js-yaml runtime must match its exact reviewed size and SHA-256 receipt.");
  }

  const packageBytes = contents.get("extension/package.json");
  if (packageBytes === undefined) {
    throw new Error("VSIX package manifest was not captured.");
  }
  const packageJson = parseStrictJson(decodeUtf8(packageBytes, "extension/package.json"));
  if (typeof packageJson !== "object" || packageJson === null || Array.isArray(packageJson)) {
    throw new Error("Packaged package.json must contain a JSON object.");
  }
  for (const asset of referencedManifestAssets(packageJson)) {
    if (entryKinds.get(asset) !== "file") {
      throw new Error(`Packaged package.json references missing regular asset ${asset}.`);
    }
  }

  const text = (name) => {
    const value = contents.get(name);
    if (value === undefined) {
      throw new Error(`VSIX entry ${name} was not captured.`);
    }
    return decodeUtf8(value, name);
  };
  return Object.freeze({
    archiveEntries: Object.freeze([...entries]),
    entryDigests: Object.freeze([...entryDigests].map(([entry, sha256]) => Object.freeze([entry, sha256]))),
    entrySizes: Object.freeze([...entrySizes].map(([entry, size]) => Object.freeze([entry, size]))),
    entryCount: entries.length,
    packagedPackageJson: text("extension/package.json"),
    packagedCommonJsModules: Object.freeze(
      [...packagedCommonJsModules].map(([path, source]) => Object.freeze([path, source]))
    ),
    packagedPythonVersionFile: text("extension/python/openwrangler_runtime/version.py"),
    packagedReadme: text("extension/readme.md"),
    packagedChangelog: text("extension/changelog.md"),
    packagedLicense: text("extension/LICENSE.txt"),
    packagedThirdPartyNotices: text("extension/THIRD_PARTY_NOTICES.md"),
    vsixManifest: text("extension.vsixmanifest"),
    webviewCss: text("extension/media/webview.css"),
    webviewPanel: text("extension/dist/extension/webviewPanel.js"),
    notebookRenderer: text("extension/media/notebookRenderer.js"),
    contentTypes: text("[Content_Types].xml")
  });
}
