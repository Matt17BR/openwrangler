#!/usr/bin/env node

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildDataWranglerStudyManifest,
  canonicalStudyJson,
  captureDataWranglerStudyMethodReceipt,
  digestStudyValue,
  readDataWranglerStudySpecificationPublication,
  writeDataWranglerStudySpecificationExclusive
} from "./data-wrangler-comparison-study.mjs";
import { parseStrictJson } from "./strict-json.mjs";

const MAXIMUM_DRAFT_BYTES = 32 * 1024 * 1024;

export const DATA_WRANGLER_STUDY_SPECIFICATION_GENERATOR_PROTOCOL =
  "openwrangler-data-wrangler-study-specification-generator-v1";

function usage() {
  return "Usage: node scripts/generate-data-wrangler-comparison-spec.mjs --draft <draft.json> --out <spec.json>";
}

function parseArguments(argv, cwd = process.cwd()) {
  if (argv.length !== 4) {
    throw new TypeError(usage());
  }
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      !["--draft", "--out"].includes(flag) ||
      values.has(flag) ||
      typeof value !== "string" ||
      value.length === 0 ||
      value.startsWith("--") ||
      /[\0\r\n]/u.test(value)
    ) {
      throw new TypeError(usage());
    }
    values.set(flag, resolve(cwd, value));
  }
  if (values.size !== 2) {
    throw new TypeError(usage());
  }
  return Object.freeze({ draft: values.get("--draft"), out: values.get("--out") });
}

function plainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sameFile(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function validDraftFile(metadata) {
  return (
    metadata.isFile() &&
    !metadata.isSymbolicLink() &&
    metadata.nlink === 1n &&
    metadata.size > 0n &&
    metadata.size <= BigInt(MAXIMUM_DRAFT_BYTES) &&
    (typeof process.getuid !== "function" || metadata.uid === BigInt(process.getuid()))
  );
}

export function readBoundedDataWranglerComparisonSpecificationDraft(path) {
  const target = resolve(path);
  let descriptor;
  try {
    const namedBefore = lstatSync(target, { bigint: true });
    if (!validDraftFile(namedBefore)) {
      throw new TypeError("Study specification draft must be one bounded, owned, singly linked regular JSON file.");
    }
    descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor, { bigint: true });
    if (!validDraftFile(opened) || !sameFile(namedBefore, opened)) {
      throw new Error("Study specification draft changed while it opened.");
    }
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (count === 0) {
        throw new Error("Study specification draft ended before its identified byte size.");
      }
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    const namedAfter = lstatSync(target, { bigint: true });
    if (!sameFile(opened, after) || !sameFile(after, namedAfter)) {
      throw new Error("Study specification draft changed while it was read.");
    }
    return parseStrictJson(bytes.toString("utf8"), { maxBytes: MAXIMUM_DRAFT_BYTES });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function generateDataWranglerComparisonSpecification(options, overrides = {}) {
  if (!plainRecord(options) || typeof options.draft !== "string" || typeof options.out !== "string") {
    throw new TypeError("Study specification generation requires draft and output paths.");
  }
  const dependencies = {
    readDraft: readBoundedDataWranglerComparisonSpecificationDraft,
    captureMethodology: captureDataWranglerStudyMethodReceipt,
    buildManifest: buildDataWranglerStudyManifest,
    writeSpecification: writeDataWranglerStudySpecificationExclusive,
    readSpecification: readDataWranglerStudySpecificationPublication,
    ...overrides
  };
  for (const [name, dependency] of Object.entries(dependencies)) {
    if (typeof dependency !== "function") {
      throw new TypeError(`Study specification ${name} dependency must be a function.`);
    }
  }

  const draft = structuredClone(dependencies.readDraft(options.draft));
  if (!plainRecord(draft)) {
    throw new TypeError("Study specification draft must be one JSON object.");
  }
  draft.method = structuredClone(dependencies.captureMethodology());

  const manifest = dependencies.buildManifest(draft);
  const publication = dependencies.writeSpecification(options.out, draft);
  const published = dependencies.readSpecification(options.out);
  if (canonicalStudyJson(published) !== canonicalStudyJson(draft)) {
    throw new Error("Published study specification does not match the validated generated value.");
  }
  return Object.freeze({
    protocol: DATA_WRANGLER_STUDY_SPECIFICATION_GENERATOR_PROTOCOL,
    specification: published,
    manifest,
    publication
  });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = generateDataWranglerComparisonSpecification(options);
  process.stdout.write(
    canonicalStudyJson({
      protocol: result.protocol,
      specificationSha256: digestStudyValue(result.specification),
      methodologySha256: result.specification.method.sha256,
      publicationStatus: result.publication.status
    })
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export { parseArguments as parseDataWranglerComparisonSpecificationArguments };
