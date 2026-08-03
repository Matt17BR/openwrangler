#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalStudyJson } from "./data-wrangler-comparison-study.mjs";
import { runUnrecordedPreparedDataWranglerComparisonDiagnostic } from "./run-data-wrangler-comparison-prepared.mjs";

export const DATA_WRANGLER_COMPARISON_DIAGNOSTIC_PROTOCOL =
  "openwrangler-data-wrangler-comparison-unrecorded-diagnostic-v1";

function fail() {
  throw new TypeError(
    "Usage: node scripts/run-data-wrangler-comparison-diagnostic.mjs --manifest <manifest.json> --prepared <prepared.json>"
  );
}

export function parseDataWranglerComparisonDiagnosticArguments(argv, cwd = process.cwd()) {
  if (!Array.isArray(argv)) fail();
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      !["--manifest", "--prepared"].includes(flag) ||
      values.has(flag) ||
      typeof value !== "string" ||
      value.length === 0 ||
      value.startsWith("--") ||
      /[\0\r\n]/u.test(value)
    ) {
      fail();
    }
    values.set(flag, resolve(cwd, value));
  }
  if (values.size !== 2 || !values.has("--manifest") || !values.has("--prepared")) fail();
  return Object.freeze({ manifestPath: values.get("--manifest"), preparationPath: values.get("--prepared") });
}

async function main() {
  const options = parseDataWranglerComparisonDiagnosticArguments(process.argv.slice(2));
  const result = await runUnrecordedPreparedDataWranglerComparisonDiagnostic(options);
  process.stdout.write(`${canonicalStudyJson(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
