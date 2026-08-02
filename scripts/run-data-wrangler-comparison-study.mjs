#!/usr/bin/env node

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildDataWranglerStudyManifest,
  buildDataWranglerStudyResult,
  canonicalStudyJson,
  createOrLoadDataWranglerStudyFinalizationIntent,
  digestStudyValue,
  loadDataWranglerStudyFragments,
  pendingDataWranglerStudyTrials,
  publishDataWranglerStudyFragment,
  readDataWranglerStudyManifestPublication,
  validateDataWranglerStudyFragment,
  validateDataWranglerStudyResultEvidence,
  writeDataWranglerStudyJsonExclusive
} from "./data-wrangler-comparison-study.mjs";

const MAX_INPUT_BYTES = 32 * 1024 * 1024;

function usage() {
  return [
    "Usage:",
    "  node scripts/run-data-wrangler-comparison-study.mjs plan --spec <spec.json> --out <manifest.json>",
    "  node scripts/run-data-wrangler-comparison-study.mjs record --manifest <manifest.json> --fragments <dir> --fragment <fragment.json>",
    "  node scripts/run-data-wrangler-comparison-study.mjs status --manifest <manifest.json> --fragments <dir>",
    "  node scripts/run-data-wrangler-comparison-study.mjs finalize --manifest <manifest.json> --fragments <dir> --out <result.json>"
  ].join("\n");
}

function parseArguments(argv, cwd = process.cwd()) {
  const [command, ...rest] = argv;
  if (!["plan", "record", "status", "finalize"].includes(command)) {
    throw new TypeError(usage());
  }
  const allowed = {
    plan: new Set(["--spec", "--out"]),
    record: new Set(["--manifest", "--fragments", "--fragment"]),
    status: new Set(["--manifest", "--fragments"]),
    finalize: new Set(["--manifest", "--fragments", "--out"])
  }[command];
  const options = { command };
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!allowed.has(flag) || value === undefined || value.startsWith("--")) {
      throw new TypeError(`Unknown or incomplete study argument ${flag ?? "<missing>"}.\n${usage()}`);
    }
    const key = flag.slice(2);
    if (options[key] !== undefined) {
      throw new TypeError(`Study argument ${flag} may appear only once.`);
    }
    options[key] = resolve(cwd, value);
  }
  for (const flag of allowed) {
    const key = flag.slice(2);
    if (options[key] === undefined) {
      throw new TypeError(`Study command ${command} requires ${flag}.`);
    }
  }
  return options;
}

function sameInputIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameInputMetadata(left, right) {
  return (
    sameInputIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.nlink === right.nlink
  );
}

function assertBoundedJsonInput(metadata, label) {
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1n ||
    metadata.size <= 0n ||
    metadata.size > BigInt(MAX_INPUT_BYTES)
  ) {
    throw new TypeError(`${label} must be one bounded, singly linked regular JSON file.`);
  }
}

function readExactBoundedDescriptor(descriptor, expectedSize, label) {
  const expectedBytes = Number(expectedSize);
  const bytes = Buffer.alloc(expectedBytes + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const count = readSync(descriptor, bytes, offset, bytes.length - offset, null);
    if (count === 0) {
      break;
    }
    offset += count;
  }
  if (offset !== expectedBytes) {
    throw new TypeError(`${label} changed size while it was read.`);
  }
  return bytes.subarray(0, offset).toString("utf8");
}

function readBoundedJson(path, label, { faultInjector } = {}) {
  let descriptor;
  let operationError;
  let text;
  try {
    const before = lstatSync(path, { bigint: true });
    assertBoundedJsonInput(before, label);
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor, { bigint: true });
    assertBoundedJsonInput(opened, label);
    if (!sameInputMetadata(before, opened)) {
      throw new TypeError(`${label} changed while it opened.`);
    }
    if (faultInjector !== undefined) {
      if (typeof faultInjector !== "function") {
        throw new TypeError("Study input fault injector must be a function.");
      }
      faultInjector("file-opened", label);
    }
    text = readExactBoundedDescriptor(descriptor, opened.size, label);
    const after = fstatSync(descriptor, { bigint: true });
    const entry = lstatSync(path, { bigint: true });
    assertBoundedJsonInput(after, label);
    assertBoundedJsonInput(entry, label);
    if (!sameInputMetadata(opened, after) || !sameInputMetadata(after, entry)) {
      throw new TypeError(`${label} changed while it was read.`);
    }
  } catch (error) {
    operationError =
      error instanceof TypeError ? error : new TypeError(`${label} could not be opened and read safely as JSON.`);
  }
  let closeError;
  if (descriptor !== undefined) {
    try {
      closeSync(descriptor);
    } catch (error) {
      closeError = error;
    }
  }
  if (operationError !== undefined || closeError !== undefined) {
    if (operationError !== undefined && closeError === undefined) {
      throw operationError;
    }
    if (operationError === undefined) {
      throw closeError;
    }
    throw new AggregateError([operationError, closeError], `${label} failed and its descriptor did not close cleanly.`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new TypeError(`${label} is not valid JSON.`);
  }
}

export function runDataWranglerComparisonStudy(
  argv,
  { cwd = process.cwd(), inputReadOptions = {}, now = () => new Date(), publicationOptions = {} } = {}
) {
  const options = parseArguments(argv, cwd);
  if (options.command === "plan") {
    const specification = readBoundedJson(options.spec, "Study specification", inputReadOptions);
    const manifest = buildDataWranglerStudyManifest(specification);
    return {
      command: options.command,
      receipt: writeDataWranglerStudyJsonExclusive(options.out, manifest, publicationOptions.manifest),
      output: manifest
    };
  }
  const manifest = readDataWranglerStudyManifestPublication(options.manifest);
  if (options.command === "record") {
    const fragment = validateDataWranglerStudyFragment(
      readBoundedJson(options.fragment, "Study fragment input", inputReadOptions),
      manifest
    );
    return {
      command: options.command,
      receipt: publishDataWranglerStudyFragment(options.fragments, fragment, manifest, publicationOptions.fragment),
      output: fragment
    };
  }
  const fragments = loadDataWranglerStudyFragments(options.fragments, manifest);
  if (options.command === "status") {
    const pending = pendingDataWranglerStudyTrials(manifest, fragments);
    return {
      command: options.command,
      receipt: null,
      output: {
        manifestSha256: digestStudyValue(manifest),
        fragmentCount: fragments.length,
        pendingCount: pending.length,
        pending
      }
    };
  }
  const pending = pendingDataWranglerStudyTrials(manifest, fragments);
  if (pending.length !== 0) {
    throw new Error("Study result cannot be finalized while planned pair work remains.");
  }
  const intent = createOrLoadDataWranglerStudyFinalizationIntent({
    outputPath: options.out,
    manifest,
    fragments,
    finalizedAtUtc: now().toISOString(),
    publicationOptions: publicationOptions.finalizationIntent
  });
  const result = buildDataWranglerStudyResult({
    manifest,
    fragments,
    finalizedAtUtc: intent.finalizedAtUtc
  });
  validateDataWranglerStudyResultEvidence({ manifest, fragments, result });
  return {
    command: options.command,
    receipt: writeDataWranglerStudyJsonExclusive(options.out, result, publicationOptions.result),
    output: result
  };
}

async function main() {
  const result = runDataWranglerComparisonStudy(process.argv.slice(2));
  process.stdout.write(
    canonicalStudyJson({
      command: result.command,
      receipt: result.receipt === null ? null : { sha256: result.receipt.sha256 },
      output: result.output
    })
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export { parseArguments as parseDataWranglerComparisonStudyArguments };
