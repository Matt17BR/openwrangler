import { createHash } from "node:crypto";
import { fromBuffer as openZipBuffer } from "yauzl";
import { ZipFile } from "yazl";
import {
  inspectVsixArchive,
  MAX_VSIX_BYTES,
  MAX_VSIX_ENTRIES,
  MAX_VSIX_ENTRY_BYTES,
  MAX_VSIX_UNCOMPRESSED_BYTES
} from "./vsix-archive.mjs";

export const REPRODUCIBLE_VSIX_PROTOCOL = "openwrangler-reproducible-vsix-v1";

const UNIX_CREATOR = 3;
const UNIX_FILE_TYPE = 0o170000;
const UNIX_REGULAR_FILE = 0o100000;
const CANONICAL_REGULAR_MODE = 0o100644;
const CANONICAL_VERSION_MADE_BY = (UNIX_CREATOR << 8) | 63;
const CANONICAL_VERSION_NEEDED = 20;
const CANONICAL_ZIP_FLAGS = 0x0800;
const DATA_DESCRIPTOR_FLAG = 0x0008;
const SUPPORTED_ZIP_FLAGS = CANONICAL_ZIP_FLAGS | DATA_DESCRIPTOR_FLAG;
const STORE_COMPRESSION = 0;
const DEFLATE_COMPRESSION = 8;
const DOS_EPOCH_DATE = 0x0021;
const DOS_EPOCH_TIME = 0;
const ZIP_LOCAL_HEADER_BYTES = 30;
const ZIP_CENTRAL_HEADER_BYTES = 46;
const ZIP_END_BYTES = 22;

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

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function bytewiseUtf8Compare(left, right) {
  return Buffer.compare(Buffer.from(left.name, "utf8"), Buffer.from(right.name, "utf8"));
}

function fixedDosEpoch() {
  // ZIP stores a timezone-free DOS wall-clock value. A local constructor makes
  // yazl emit the same 1980-01-01 00:00 fields in every process timezone.
  return new Date(1980, 0, 1, 0, 0, 0, 0);
}

function openArchive(bytes) {
  return new Promise((resolveArchive, rejectArchive) => {
    openZipBuffer(
      bytes,
      {
        decodeStrings: true,
        lazyEntries: true,
        strictFileNames: true,
        validateEntrySizes: true
      },
      (error, archive) => {
        if (error !== null) {
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

function assertArchiveCommentAbsent(archive) {
  if (typeof archive.comment !== "string" || archive.comment.length !== 0) {
    throw new Error("VSIX archives with ZIP comments are not supported for reproducible canonicalization.");
  }
}

function assertCentralEntryMetadata(entry, canonical) {
  if (entry.extraFieldRaw.length !== 0 || entry.fileCommentRaw.length !== 0) {
    throw new Error(`VSIX entry ${entry.fileName} uses unsupported ZIP comments or extra fields.`);
  }
  if ((entry.generalPurposeBitFlag & ~SUPPORTED_ZIP_FLAGS) !== 0) {
    throw new Error(`VSIX entry ${entry.fileName} uses unsupported or encrypted ZIP flags.`);
  }
  if (entry.compressionMethod !== STORE_COMPRESSION && entry.compressionMethod !== DEFLATE_COMPRESSION) {
    throw new Error(`VSIX entry ${entry.fileName} uses unsupported compression method ${entry.compressionMethod}.`);
  }

  const creator = (entry.versionMadeBy >>> 8) & 0xff;
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const type = mode & UNIX_FILE_TYPE;
  if (entry.fileName.endsWith("/")) {
    throw new Error(
      `VSIX entry ${entry.fileName} is an unsupported directory entry; reproducible VSIXes are files-only.`
    );
  }
  if (creator !== UNIX_CREATOR || type !== UNIX_REGULAR_FILE) {
    throw new Error(`VSIX entry ${entry.fileName} must be a regular file.`);
  }

  if (!canonical) return "file";
  if (
    entry.versionMadeBy !== CANONICAL_VERSION_MADE_BY ||
    entry.versionNeededToExtract !== CANONICAL_VERSION_NEEDED ||
    entry.generalPurposeBitFlag !== CANONICAL_ZIP_FLAGS ||
    entry.compressionMethod !== STORE_COMPRESSION ||
    entry.lastModFileDate !== DOS_EPOCH_DATE ||
    entry.lastModFileTime !== DOS_EPOCH_TIME ||
    entry.internalFileAttributes !== 0 ||
    entry.externalFileAttributes !== (CANONICAL_REGULAR_MODE << 16) >>> 0 ||
    !entry.fileNameRaw.equals(Buffer.from(entry.fileName, "utf8"))
  ) {
    throw new Error(`Canonical VSIX entry ${entry.fileName} has noncanonical ZIP metadata.`);
  }
  return "file";
}

function coherentDescriptorField(localValue, centralValue) {
  return localValue === 0 || localValue === centralValue;
}

async function assertLocalEntryMetadata(archive, entry, canonical) {
  const local = await archive.readLocalFileHeaderPromise(entry);
  if (local.extraField.length !== 0) {
    throw new Error(`VSIX entry ${entry.fileName} uses unsupported local ZIP extra fields.`);
  }
  if (
    !local.fileName.equals(entry.fileNameRaw) ||
    local.generalPurposeBitFlag !== entry.generalPurposeBitFlag ||
    local.compressionMethod !== entry.compressionMethod ||
    local.lastModFileDate !== entry.lastModFileDate ||
    local.lastModFileTime !== entry.lastModFileTime
  ) {
    throw new Error(`VSIX entry ${entry.fileName} has inconsistent local and central ZIP metadata.`);
  }

  const usesDescriptor = (entry.generalPurposeBitFlag & DATA_DESCRIPTOR_FLAG) !== 0;
  const valuesMatch = usesDescriptor
    ? coherentDescriptorField(local.crc32, entry.crc32) &&
      coherentDescriptorField(local.compressedSize, entry.compressedSize) &&
      coherentDescriptorField(local.uncompressedSize, entry.uncompressedSize)
    : local.crc32 === entry.crc32 &&
      local.compressedSize === entry.compressedSize &&
      local.uncompressedSize === entry.uncompressedSize;
  if (!valuesMatch) {
    throw new Error(`VSIX entry ${entry.fileName} has inconsistent local size or CRC metadata.`);
  }
  if (
    canonical &&
    (local.versionNeededToExtract !== CANONICAL_VERSION_NEEDED ||
      local.generalPurposeBitFlag !== CANONICAL_ZIP_FLAGS ||
      local.compressionMethod !== STORE_COMPRESSION ||
      local.lastModFileDate !== DOS_EPOCH_DATE ||
      local.lastModFileTime !== DOS_EPOCH_TIME)
  ) {
    throw new Error(`Canonical VSIX entry ${entry.fileName} has noncanonical local ZIP metadata.`);
  }
}

async function readEntryBytes(archive, entry) {
  const stream = await archive.openReadStreamPromise(entry);
  const chunks = [];
  const digest = createHash("sha256");
  let crc = 0xffffffff;
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > MAX_VSIX_ENTRY_BYTES) {
      throw new Error(`VSIX entry ${entry.fileName} exceeds its per-entry size limit.`);
    }
    chunks.push(chunk);
    digest.update(chunk);
    crc = updateCrc32(crc, chunk);
  }
  if (size !== entry.uncompressedSize) {
    throw new Error(`VSIX entry ${entry.fileName} did not produce its declared size.`);
  }
  if ((crc ^ 0xffffffff) >>> 0 !== entry.crc32) {
    throw new Error(`VSIX entry ${entry.fileName} failed CRC-32 validation.`);
  }
  return Object.freeze({
    bytes: Buffer.concat(chunks, size),
    sha256: digest.digest("hex"),
    size
  });
}

async function readArchiveInventory(bytes, { canonical = false } = {}) {
  const archive = await openArchive(bytes);
  const entries = [];
  let totalUncompressedBytes = 0;
  let settled = false;
  try {
    assertArchiveCommentAbsent(archive);
    await new Promise((resolveInventory, rejectInventory) => {
      const reject = (error) => {
        if (settled) return;
        settled = true;
        rejectInventory(error);
      };
      archive.once("error", reject);
      archive.on("entry", async (entry) => {
        try {
          if (entries.length >= MAX_VSIX_ENTRIES) {
            throw new Error(`VSIX archive exceeds ${MAX_VSIX_ENTRIES} entries.`);
          }
          const kind = assertCentralEntryMetadata(entry, canonical);
          await assertLocalEntryMetadata(archive, entry, canonical);
          const contents = await readEntryBytes(archive, entry);
          totalUncompressedBytes += contents.size;
          if (totalUncompressedBytes > MAX_VSIX_UNCOMPRESSED_BYTES) {
            throw new Error("VSIX archive exceeds its aggregate size budget.");
          }
          entries.push(
            Object.freeze({
              bytes: contents.bytes,
              kind,
              name: entry.fileName,
              sha256: contents.sha256,
              size: contents.size
            })
          );
          if (!settled) archive.readEntry();
        } catch (error) {
          reject(error);
        }
      });
      archive.once("end", () => {
        if (settled) return;
        settled = true;
        resolveInventory();
      });
      archive.readEntry();
    });
  } finally {
    archive.close();
  }
  return Object.freeze({ entries: Object.freeze(entries), totalUncompressedBytes });
}

function assertInspectionMatchesInventory(inspection, inventory) {
  if (inspection.entryCount !== inventory.entries.length) {
    throw new Error("VSIX archive entry count changed between validation and canonicalization.");
  }
  const sizes = new Map(inspection.entrySizes);
  const digests = new Map(inspection.entryDigests);
  for (const [index, entry] of inventory.entries.entries()) {
    if (
      inspection.archiveEntries[index] !== entry.name ||
      sizes.get(entry.name) !== entry.size ||
      digests.get(entry.name) !== entry.sha256
    ) {
      throw new Error(`VSIX entry ${entry.name} changed between validation and canonicalization.`);
    }
  }
}

function canonicalArchiveSize(entries) {
  let localBytes = 0;
  let centralBytes = 0;
  for (const entry of entries) {
    const nameBytes = Buffer.byteLength(entry.name, "utf8");
    localBytes += ZIP_LOCAL_HEADER_BYTES + nameBytes + entry.size;
    centralBytes += ZIP_CENTRAL_HEADER_BYTES + nameBytes;
  }
  return localBytes + centralBytes + ZIP_END_BYTES;
}

function assertCanonicalOutputBound(entries) {
  const predictedBytes = canonicalArchiveSize(entries);
  if (!Number.isSafeInteger(predictedBytes) || predictedBytes <= 0 || predictedBytes > MAX_VSIX_BYTES) {
    throw new Error(`Canonical VSIX output must be between 1 and ${MAX_VSIX_BYTES} bytes.`);
  }
  return predictedBytes;
}

function writeCanonicalArchive(entries, predictedBytes) {
  return new Promise((resolveBytes, rejectBytes) => {
    const zip = new ZipFile();
    const chunks = [];
    let size = 0;
    let settled = false;
    const reject = (error) => {
      if (settled) return;
      settled = true;
      rejectBytes(error);
    };
    zip.outputStream.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_VSIX_BYTES) {
        reject(new Error(`Canonical VSIX output must be no larger than ${MAX_VSIX_BYTES} bytes.`));
        zip.outputStream.destroy();
        return;
      }
      chunks.push(chunk);
    });
    zip.outputStream.once("error", reject);
    zip.outputStream.once("end", () => {
      if (settled) return;
      settled = true;
      if (size !== predictedBytes) {
        rejectBytes(new Error("Canonical VSIX output size did not match its deterministic bound."));
        return;
      }
      resolveBytes(Buffer.concat(chunks, size));
    });

    const mtime = fixedDosEpoch();
    for (const entry of entries) {
      zip.addBuffer(entry.bytes, entry.name, {
        compress: false,
        forceDosTimestamp: true,
        mode: CANONICAL_REGULAR_MODE,
        mtime
      });
    }
    zip.end();
  });
}

function assertEquivalentInventories(source, canonical) {
  if (
    source.entries.length !== canonical.entries.length ||
    source.totalUncompressedBytes !== canonical.totalUncompressedBytes
  ) {
    throw new Error("Canonical VSIX output changed the archive inventory.");
  }
  for (let index = 0; index < source.entries.length; index += 1) {
    const left = source.entries[index];
    const right = canonical.entries[index];
    if (
      left.name !== right.name ||
      left.kind !== right.kind ||
      left.size !== right.size ||
      left.sha256 !== right.sha256 ||
      !left.bytes.equals(right.bytes)
    ) {
      throw new Error(`Canonical VSIX output changed entry ${left.name}.`);
    }
  }
}

function inventorySha256(entries) {
  const digest = createHash("sha256");
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const header = Buffer.alloc(13);
    header.writeUInt8(entry.kind === "directory" ? 1 : 0, 0);
    header.writeUInt32BE(name.length, 1);
    header.writeBigUInt64BE(BigInt(entry.size), 5);
    digest.update(header);
    digest.update(name);
    digest.update(Buffer.from(entry.sha256, "hex"));
  }
  return digest.digest("hex");
}

function inspectedEntriesForOutputBound(inspection) {
  const sizes = new Map(inspection.entrySizes);
  return inspection.archiveEntries
    .map((name) => Object.freeze({ kind: "file", name, size: sizes.get(name) }))
    .sort(bytewiseUtf8Compare);
}

export async function canonicalizeVsixArchive(inputBytes) {
  if (!Buffer.isBuffer(inputBytes) || inputBytes.length === 0 || inputBytes.length > MAX_VSIX_BYTES) {
    throw new Error(`Reproducible VSIX input must be one non-empty Buffer no larger than ${MAX_VSIX_BYTES} bytes.`);
  }

  // Capture before the first await so later caller mutation cannot alter the
  // archive that is validated, read, or receipted.
  const sourceBytes = Buffer.from(inputBytes);
  const sourceSha256 = sha256(sourceBytes);
  const inspection = await inspectVsixArchive(sourceBytes);
  const boundedEntries = inspectedEntriesForOutputBound(inspection);
  const predictedBytes = assertCanonicalOutputBound(boundedEntries);
  const source = await readArchiveInventory(sourceBytes);
  assertInspectionMatchesInventory(inspection, source);

  const sortedSource = Object.freeze([...source.entries].sort(bytewiseUtf8Compare));
  const sortedSourceInventory = Object.freeze({
    entries: sortedSource,
    totalUncompressedBytes: source.totalUncompressedBytes
  });
  const canonicalBytes = await writeCanonicalArchive(sortedSource, predictedBytes);
  const canonicalInspection = await inspectVsixArchive(canonicalBytes);
  const canonical = await readArchiveInventory(canonicalBytes, { canonical: true });
  assertInspectionMatchesInventory(canonicalInspection, canonical);
  assertEquivalentInventories(sortedSourceInventory, canonical);

  const canonicalSha256 = sha256(canonicalBytes);
  const receipt = Object.freeze({
    canonicalBytes: canonicalBytes.length,
    canonicalSha256,
    entryCount: canonical.entries.length,
    inventorySha256: inventorySha256(canonical.entries),
    protocol: REPRODUCIBLE_VSIX_PROTOCOL,
    sourceBytes: sourceBytes.length,
    sourceSha256,
    uncompressedBytes: canonical.totalUncompressedBytes
  });
  return Object.freeze({ bytes: canonicalBytes, receipt });
}

export async function assertReproducibleVsixArchive(inputBytes) {
  if (!Buffer.isBuffer(inputBytes) || inputBytes.length === 0 || inputBytes.length > MAX_VSIX_BYTES) {
    throw new Error(`Reproducible VSIX input must be one non-empty Buffer no larger than ${MAX_VSIX_BYTES} bytes.`);
  }
  const snapshot = Buffer.from(inputBytes);
  const canonical = await canonicalizeVsixArchive(snapshot);
  if (!canonical.bytes.equals(snapshot)) {
    throw new Error("VSIX archive is not in exact reproducible canonical form.");
  }
  return canonical.receipt;
}
