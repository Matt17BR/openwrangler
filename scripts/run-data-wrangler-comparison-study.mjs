#!/usr/bin/env node

import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildDataWranglerStudyManifest,
  buildDataWranglerStudyResult,
  canonicalStudyJson,
  digestStudyValue,
  loadDataWranglerStudyFragments,
  pendingDataWranglerStudyTrials,
  publishDataWranglerStudyFragment,
  validateDataWranglerStudyFragment,
  validateDataWranglerStudyManifest,
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

function readBoundedJson(path, label) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size <= 0 || stat.size > MAX_INPUT_BYTES) {
    throw new TypeError(`${label} must be one bounded, singly linked regular JSON file.`);
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new TypeError(`${label} is not valid JSON.`);
  }
}

export function runDataWranglerComparisonStudy(argv, { cwd = process.cwd(), now = () => new Date() } = {}) {
  const options = parseArguments(argv, cwd);
  if (options.command === "plan") {
    const specification = readBoundedJson(options.spec, "Study specification");
    const manifest = buildDataWranglerStudyManifest(specification);
    return {
      command: options.command,
      receipt: writeDataWranglerStudyJsonExclusive(options.out, manifest),
      output: manifest
    };
  }
  const manifest = validateDataWranglerStudyManifest(readBoundedJson(options.manifest, "Study manifest"));
  if (options.command === "record") {
    const fragment = validateDataWranglerStudyFragment(
      readBoundedJson(options.fragment, "Study fragment input"),
      manifest
    );
    return {
      command: options.command,
      receipt: publishDataWranglerStudyFragment(options.fragments, fragment, manifest),
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
  const result = buildDataWranglerStudyResult({
    manifest,
    fragments,
    finalizedAtUtc: now().toISOString()
  });
  if (!result.accounting.allPlannedPairsComplete) {
    throw new Error("Study result cannot be finalized while planned pair work remains.");
  }
  validateDataWranglerStudyResultEvidence({ manifest, fragments, result });
  return {
    command: options.command,
    receipt: writeDataWranglerStudyJsonExclusive(options.out, result),
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
