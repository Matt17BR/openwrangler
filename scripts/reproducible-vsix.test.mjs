import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import { fromBuffer as openZipBuffer } from "yauzl";
import { ZipFile } from "yazl";
import { requiredVsixEntries, VENDORED_JS_YAML_ENTRY } from "./vsix-contents.mjs";
import { MAX_VENDORED_JS_YAML_BYTES, MAX_VSIX_BYTES, MAX_VSIX_ENTRY_BYTES } from "./vsix-archive.mjs";
import {
  assertReproducibleVsixArchive,
  canonicalizeVsixArchive,
  REPRODUCIBLE_VSIX_PROTOCOL
} from "./reproducible-vsix.mjs";

const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_END_SIGNATURE = 0x06054b50;
const ZIP_UTF8_FLAG = 0x0800;
const CANONICAL_FILE_MODE = 0o100644;
const FIXED_FIXTURE_CANONICAL_SHA256 = "f260ccdb7a34be526a71e6e5d2de0e79675eb7f1917ecac0e213ed8d05037bb4";
const vendoredJsYaml = Buffer.from("module.exports = Object.freeze({ load() {} });\n");

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function contentsFor(name) {
  if (name === VENDORED_JS_YAML_ENTRY) return vendoredJsYaml;
  if (name === "extension/package.json") return Buffer.from("{}\n");
  if (name === "[Content_Types].xml") return Buffer.from("<Types></Types>\n");
  if (name === "extension.vsixmanifest") return Buffer.from("<PackageManifest></PackageManifest>\n");
  return Buffer.from(`fixture:${name}\n`);
}

function productionEntries({ overrides = new Map() } = {}) {
  const entries = requiredVsixEntries.map((name) => ({
    bytes: overrides.get(name) ?? contentsFor(name),
    kind: "file",
    name
  }));
  return entries;
}

function createArchive(
  entries,
  {
    archiveComment,
    compress = true,
    directoryMode = 0o040700,
    fileComments = new Map(),
    fileMode = 0o100600,
    mtime = new Date(2024, 6, 5, 4, 3, 2),
    reverse = false
  } = {}
) {
  const zip = new ZipFile();
  const ordered = reverse ? [...entries].reverse() : [...entries];
  for (const entry of ordered) {
    const mode = typeof fileMode === "function" ? fileMode(entry) : fileMode;
    if (entry.kind === "directory") {
      zip.addEmptyDirectory(entry.name, {
        fileComment: fileComments.get(entry.name),
        forceDosTimestamp: true,
        mode: directoryMode,
        mtime
      });
    } else {
      zip.addBuffer(entry.bytes, entry.name, {
        compress: typeof compress === "function" ? compress(entry) : compress,
        fileComment: fileComments.get(entry.name),
        forceDosTimestamp: true,
        mode,
        mtime
      });
    }
  }
  return new Promise((resolveBytes, rejectBytes) => {
    const chunks = [];
    let size = 0;
    zip.outputStream.on("data", (chunk) => {
      chunks.push(chunk);
      size += chunk.length;
    });
    zip.outputStream.once("error", rejectBytes);
    zip.outputStream.once("end", () => resolveBytes(Buffer.concat(chunks, size)));
    zip.end(archiveComment === undefined ? undefined : { comment: archiveComment });
  });
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
        if (error !== null) rejectArchive(error);
        else resolveArchive(archive);
      }
    );
  });
}

async function archiveMetadata(bytes) {
  const archive = await openArchive(bytes);
  const entries = [];
  let settled = false;
  try {
    await new Promise((resolveEntries, rejectEntries) => {
      const reject = (error) => {
        if (settled) return;
        settled = true;
        rejectEntries(error);
      };
      archive.once("error", reject);
      archive.on("entry", async (entry) => {
        try {
          const local = await archive.readLocalFileHeaderPromise(entry);
          entries.push({
            centralExtraBytes: entry.extraFieldRaw.length,
            centralNameBytes: Buffer.from(entry.fileNameRaw),
            commentBytes: entry.fileCommentRaw.length,
            compressionMethod: entry.compressionMethod,
            externalFileAttributes: entry.externalFileAttributes,
            fileName: entry.fileName,
            flags: entry.generalPurposeBitFlag,
            internalFileAttributes: entry.internalFileAttributes,
            lastModFileDate: entry.lastModFileDate,
            lastModFileTime: entry.lastModFileTime,
            localCompressionMethod: local.compressionMethod,
            localExtraBytes: local.extraField.length,
            localFlags: local.generalPurposeBitFlag,
            localLastModFileDate: local.lastModFileDate,
            localLastModFileTime: local.lastModFileTime,
            localNameBytes: Buffer.from(local.fileName),
            versionMadeBy: entry.versionMadeBy,
            versionNeededToExtract: entry.versionNeededToExtract
          });
          if (!settled) archive.readEntry();
        } catch (error) {
          reject(error);
        }
      });
      archive.once("end", () => {
        if (settled) return;
        settled = true;
        resolveEntries();
      });
      archive.readEntry();
    });
    return { comment: archive.comment, entries };
  } finally {
    archive.close();
  }
}

function centralDirectory(bytes) {
  const endSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const endOffset = bytes.lastIndexOf(endSignature);
  assert.notEqual(endOffset, -1);
  assert.equal(bytes.readUInt32LE(endOffset), ZIP_END_SIGNATURE);
  const count = bytes.readUInt16LE(endOffset + 10);
  let offset = bytes.readUInt32LE(endOffset + 16);
  const records = [];
  for (let index = 0; index < count; index += 1) {
    assert.equal(bytes.readUInt32LE(offset), ZIP_CENTRAL_SIGNATURE);
    const nameBytes = bytes.readUInt16LE(offset + 28);
    const extraBytes = bytes.readUInt16LE(offset + 30);
    const commentBytes = bytes.readUInt16LE(offset + 32);
    const name = bytes.subarray(offset + 46, offset + 46 + nameBytes).toString("utf8");
    records.push({ commentBytes, extraBytes, name, nameBytes, offset });
    offset += 46 + nameBytes + extraBytes + commentBytes;
  }
  return { endOffset, records };
}

function patchEntry(bytes, name, patch) {
  const result = Buffer.from(bytes);
  const record = centralDirectory(result).records.find((candidate) => candidate.name === name);
  assert.notEqual(record, undefined);
  const localOffset = result.readUInt32LE(record.offset + 42);
  patch({ centralOffset: record.offset, localOffset, result });
  return result;
}

function addCentralExtraField(bytes, name) {
  const { endOffset, records } = centralDirectory(bytes);
  const record = records.find((candidate) => candidate.name === name);
  assert.notEqual(record, undefined);
  const extra = Buffer.from([0xfe, 0xca, 0x00, 0x00]);
  const insertion = record.offset + 46 + record.nameBytes + record.extraBytes;
  const result = Buffer.concat([bytes.subarray(0, insertion), extra, bytes.subarray(insertion)]);
  result.writeUInt16LE(record.extraBytes + extra.length, record.offset + 30);
  result.writeUInt32LE(bytes.readUInt32LE(endOffset + 12) + extra.length, endOffset + extra.length + 12);
  return result;
}

test("canonicalizes a validated VSIX to one strict deterministic ZIP and receipt", async () => {
  assert.ok(vendoredJsYaml.length > 0);
  assert.ok(vendoredJsYaml.length <= MAX_VENDORED_JS_YAML_BYTES);
  const input = await createArchive(productionEntries());
  const result = await canonicalizeVsixArchive(input);
  const metadata = await archiveMetadata(result.bytes);
  const expectedNames = productionEntries()
    .map(({ name }) => name)
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));

  assert.deepEqual(
    metadata.entries.map(({ fileName }) => fileName),
    expectedNames
  );
  assert.equal(metadata.comment, "");
  for (const entry of metadata.entries) {
    assert.equal(entry.versionMadeBy, 0x033f);
    assert.equal(entry.versionNeededToExtract, 20);
    assert.equal(entry.flags, ZIP_UTF8_FLAG);
    assert.equal(entry.compressionMethod, 0);
    assert.equal(entry.lastModFileDate, 0x0021);
    assert.equal(entry.lastModFileTime, 0);
    assert.equal(entry.internalFileAttributes, 0);
    assert.equal(entry.externalFileAttributes, (CANONICAL_FILE_MODE << 16) >>> 0);
    assert.equal(entry.centralExtraBytes, 0);
    assert.equal(entry.commentBytes, 0);
    assert.equal(entry.localFlags, ZIP_UTF8_FLAG);
    assert.equal(entry.localCompressionMethod, 0);
    assert.equal(entry.localLastModFileDate, 0x0021);
    assert.equal(entry.localLastModFileTime, 0);
    assert.equal(entry.localExtraBytes, 0);
    assert.deepEqual(entry.centralNameBytes, Buffer.from(entry.fileName, "utf8"));
    assert.deepEqual(entry.localNameBytes, entry.centralNameBytes);
  }

  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.receipt));
  assert.deepEqual(Object.keys(result.receipt).sort(), [
    "canonicalBytes",
    "canonicalSha256",
    "entryCount",
    "inventorySha256",
    "protocol",
    "sourceBytes",
    "sourceSha256",
    "uncompressedBytes"
  ]);
  assert.equal(result.receipt.protocol, REPRODUCIBLE_VSIX_PROTOCOL);
  assert.equal(result.receipt.sourceBytes, input.length);
  assert.equal(result.receipt.sourceSha256, digest(input));
  assert.equal(result.receipt.canonicalBytes, result.bytes.length);
  assert.equal(result.receipt.canonicalSha256, digest(result.bytes));
  assert.equal(result.receipt.canonicalSha256, FIXED_FIXTURE_CANONICAL_SHA256);
  assert.equal(result.receipt.entryCount, expectedNames.length);
  assert.match(result.receipt.inventorySha256, /^[0-9a-f]{64}$/u);
});

test("is byte-identical across ZIP order, timestamp, mode, and compression differences and is idempotent", async () => {
  const entries = productionEntries();
  const compressed = await createArchive(entries, {
    compress: true,
    fileMode: 0o100600,
    mtime: new Date(2020, 1, 2, 3, 4, 6)
  });
  const stored = await createArchive(entries, {
    compress: false,
    fileMode: 0o100755,
    mtime: new Date(2037, 8, 9, 10, 11, 12),
    reverse: true
  });
  assert.equal(compressed.equals(stored), false);

  const first = await canonicalizeVsixArchive(compressed);
  const second = await canonicalizeVsixArchive(stored);
  assert.deepEqual(first.bytes, second.bytes);
  assert.equal(first.receipt.canonicalSha256, second.receipt.canonicalSha256);
  assert.equal(first.receipt.inventorySha256, second.receipt.inventorySha256);

  const repeated = await canonicalizeVsixArchive(first.bytes);
  assert.deepEqual(repeated.bytes, first.bytes);
  assert.equal(repeated.receipt.sourceSha256, first.receipt.canonicalSha256);
  assert.equal(repeated.receipt.canonicalSha256, first.receipt.canonicalSha256);
  assert.equal(repeated.receipt.inventorySha256, first.receipt.inventorySha256);
});

test("is byte-identical across representative process timezones", async () => {
  const source = await createArchive(productionEntries());
  const canonicalizerUrl = new URL("./reproducible-vsix.mjs", import.meta.url).href;
  const program = [
    'import { readFileSync } from "node:fs";',
    "const { canonicalizeVsixArchive } = await import(process.argv[1]);",
    "const result = await canonicalizeVsixArchive(readFileSync(0));",
    "process.stdout.write(result.bytes);"
  ].join("\n");
  const outputs = new Map();

  for (const timezone of ["UTC", "Europe/Berlin", "America/Los_Angeles", "Asia/Kolkata"]) {
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", program, canonicalizerUrl], {
      encoding: null,
      env: { ...process.env, TZ: timezone },
      input: source,
      maxBuffer: MAX_VSIX_BYTES,
      timeout: 30_000,
      windowsHide: true
    });
    assert.ifError(child.error);
    assert.equal(child.signal, null, `${timezone}: ${child.stderr.toString("utf8")}`);
    assert.equal(child.status, 0, `${timezone}: ${child.stderr.toString("utf8")}`);
    outputs.set(timezone, child.stdout);
  }

  const expected = outputs.get("UTC");
  assert.equal(digest(expected), FIXED_FIXTURE_CANONICAL_SHA256);
  for (const [timezone, bytes] of outputs) {
    assert.deepEqual(bytes, expected, `${timezone} produced different canonical VSIX bytes`);
  }
});

test("asserts exact canonical bytes and returns their receipt", async () => {
  const source = await createArchive(productionEntries());
  await assert.rejects(assertReproducibleVsixArchive(source), /not in exact reproducible canonical form/u);

  const canonical = await canonicalizeVsixArchive(source);
  const receipt = await assertReproducibleVsixArchive(canonical.bytes);
  assert.ok(Object.isFrozen(receipt));
  assert.equal(receipt.protocol, REPRODUCIBLE_VSIX_PROTOCOL);
  assert.equal(receipt.sourceSha256, canonical.receipt.canonicalSha256);
  assert.equal(receipt.canonicalSha256, canonical.receipt.canonicalSha256);
  assert.equal(receipt.sourceBytes, canonical.bytes.length);
  assert.equal(receipt.canonicalBytes, canonical.bytes.length);
});

test("supports a bounded inventory whose central directory exceeds the legacy 16-bit size", async () => {
  const entries = productionEntries();
  for (let index = 0; index < 240; index += 1) {
    entries.push({
      bytes: Buffer.from(`${index}\n`),
      kind: "file",
      name: `extension/python/openwrangler_runtime/${String(index).padStart(3, "0")}-${"x".repeat(220)}.py`
    });
  }
  const source = await createArchive(entries, { compress: false });
  const canonical = await canonicalizeVsixArchive(source);
  assert.equal(canonical.receipt.entryCount, entries.length);
  const receipt = await assertReproducibleVsixArchive(canonical.bytes);
  assert.equal(receipt.sourceSha256, canonical.receipt.canonicalSha256);
  assert.equal(receipt.canonicalSha256, canonical.receipt.canonicalSha256);
  assert.equal(receipt.inventorySha256, canonical.receipt.inventorySha256);
});

test("binds entry bytes so distinct inventories cannot share canonical output", async () => {
  const first = await createArchive(
    productionEntries({ overrides: new Map([["extension/media/icon.png", Buffer.from("icon-a\n")]]) })
  );
  const second = await createArchive(
    productionEntries({ overrides: new Map([["extension/media/icon.png", Buffer.from("icon-b\n")]]) })
  );
  const firstCanonical = await canonicalizeVsixArchive(first);
  const secondCanonical = await canonicalizeVsixArchive(second);
  assert.equal(firstCanonical.bytes.equals(secondCanonical.bytes), false);
  assert.notEqual(firstCanonical.receipt.canonicalSha256, secondCanonical.receipt.canonicalSha256);
  assert.notEqual(firstCanonical.receipt.inventorySha256, secondCanonical.receipt.inventorySha256);
});

test("snapshots caller bytes before asynchronous validation", async () => {
  const input = await createArchive(productionEntries());
  const originalSha256 = digest(input);
  const pending = canonicalizeVsixArchive(input);
  input.fill(0);
  const result = await pending;
  assert.equal(result.receipt.sourceSha256, originalSha256);
  assert.notEqual(result.receipt.sourceSha256, digest(input));
});

test("rejects malformed, duplicate, and portable-colliding inventories", async () => {
  await assert.rejects(canonicalizeVsixArchive(Buffer.from("not a ZIP")), /ZIP archive|central directory/u);

  const duplicateEntries = productionEntries();
  duplicateEntries.push({ bytes: Buffer.from("duplicate\n"), kind: "file", name: "extension/media/icon.png" });
  await assert.rejects(
    canonicalizeVsixArchive(await createArchive(duplicateEntries)),
    /Colliding archive paths: extension\/media\/icon\.png/u
  );

  const collidingEntries = productionEntries();
  collidingEntries.push({ bytes: Buffer.from("collision\n"), kind: "file", name: "extension/README.md" });
  await assert.rejects(
    canonicalizeVsixArchive(await createArchive(collidingEntries)),
    /Colliding archive paths: extension\/README\.md/u
  );
});

test("rejects corrupted payload receipts and unsupported flags or entry types", async () => {
  const valid = await createArchive(productionEntries());
  const wrongCrc = patchEntry(valid, "extension/media/icon.png", ({ centralOffset, result }) => {
    result.writeUInt32LE((result.readUInt32LE(centralOffset + 16) ^ 0xffffffff) >>> 0, centralOffset + 16);
  });
  await assert.rejects(canonicalizeVsixArchive(wrongCrc), /failed CRC-32 validation/u);

  const encrypted = patchEntry(valid, "extension/media/icon.png", ({ centralOffset, localOffset, result }) => {
    result.writeUInt16LE(result.readUInt16LE(centralOffset + 8) | 0x0001, centralOffset + 8);
    result.writeUInt16LE(result.readUInt16LE(localOffset + 6) | 0x0001, localOffset + 6);
  });
  await assert.rejects(canonicalizeVsixArchive(encrypted), /unsupported or encrypted ZIP flags/u);

  const symlink = await createArchive(productionEntries(), {
    fileMode: (entry) => (entry.name === "extension/media/icon.png" ? 0o120777 : 0o100600)
  });
  await assert.rejects(canonicalizeVsixArchive(symlink), /regular file or matching directory entry/u);
});

test("fails closed on directory entries outside the package-source file inventory", async () => {
  const entries = productionEntries();
  entries.push({ bytes: Buffer.alloc(0), kind: "directory", name: "extension/" });
  await assert.rejects(
    canonicalizeVsixArchive(await createArchive(entries)),
    /unsupported directory entry; reproducible VSIXes are files-only/u
  );
});

test("fails closed on archive comments, entry comments, and extra fields", async () => {
  const entries = productionEntries();
  await assert.rejects(
    canonicalizeVsixArchive(await createArchive(entries, { archiveComment: "comment" })),
    /ZIP comments are not supported/u
  );
  await assert.rejects(
    canonicalizeVsixArchive(
      await createArchive(entries, {
        fileComments: new Map([["extension/media/icon.png", "comment"]])
      })
    ),
    /unsupported ZIP comments or extra fields/u
  );

  const valid = await createArchive(entries);
  await assert.rejects(
    canonicalizeVsixArchive(addCentralExtraField(valid, "extension/media/icon.png")),
    /unsupported ZIP comments or extra fields/u
  );
});

test("enforces input, entry, and canonical output bounds", async () => {
  await assert.rejects(canonicalizeVsixArchive(Buffer.alloc(0)), /one non-empty Buffer/u);
  await assert.rejects(canonicalizeVsixArchive("not a buffer"), /one non-empty Buffer/u);
  await assert.rejects(
    canonicalizeVsixArchive(Buffer.allocUnsafe(MAX_VSIX_BYTES + 1)),
    new RegExp(`no larger than ${MAX_VSIX_BYTES}`, "u")
  );

  const valid = await createArchive(productionEntries(), { compress: false });
  const oversizedEntry = patchEntry(valid, "extension/media/icon.png", ({ centralOffset, result }) => {
    result.writeUInt32LE(MAX_VSIX_ENTRY_BYTES + 1, centralOffset + 20);
    result.writeUInt32LE(MAX_VSIX_ENTRY_BYTES + 1, centralOffset + 24);
  });
  await assert.rejects(canonicalizeVsixArchive(oversizedEntry), /exceeds its per-entry size limit/u);

  const sharedLargeEntry = Buffer.alloc(MAX_VSIX_ENTRY_BYTES);
  const outputOverflow = productionEntries();
  for (const suffix of ["a", "b", "c", "d"]) {
    outputOverflow.push({
      bytes: sharedLargeEntry,
      kind: "file",
      name: `extension/python/openwrangler_runtime/canonical-bound-${suffix}.py`
    });
  }
  const compressedOverflow = await createArchive(outputOverflow, { compress: true });
  assert.ok(compressedOverflow.length < MAX_VSIX_BYTES);
  await assert.rejects(canonicalizeVsixArchive(compressedOverflow), /Canonical VSIX output must be between 1 and/u);
});
