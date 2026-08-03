#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  captureDataWranglerComparisonPreregistration,
  createDataWranglerComparisonPreregistrationReceipt,
  writeDataWranglerComparisonPreregistration
} from "./data-wrangler-comparison-preregistration.mjs";
import { canonicalStudyJson } from "./data-wrangler-comparison-study.mjs";

function usage() {
  return "Usage: npm run comparison:preregister -- --out <preregistration.json>";
}

export function parseDataWranglerComparisonPreregistrationArguments(argv, cwd = process.cwd()) {
  if (
    !Array.isArray(argv) ||
    argv.length !== 2 ||
    argv[0] !== "--out" ||
    typeof argv[1] !== "string" ||
    argv[1].length === 0 ||
    argv[1].startsWith("--") ||
    /[\0\r\n]/u.test(argv[1])
  ) {
    throw new TypeError(usage());
  }
  return Object.freeze({ out: resolve(cwd, argv[1]) });
}

export async function generateDataWranglerComparisonPreregistration(options, dependencies = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options) || typeof options.out !== "string") {
    throw new TypeError(usage());
  }
  const proveJourneyGraph =
    dependencies.proveJourneyGraph ??
    (await import("./data-wrangler-comparison-driver.mjs")).proveDataWranglerComparisonJourneyGraph;
  const value = captureDataWranglerComparisonPreregistration(dependencies.identity, {
    ...dependencies,
    proveJourneyGraph
  });
  const publication = writeDataWranglerComparisonPreregistration(options.out, value, dependencies.publication);
  const receipt = createDataWranglerComparisonPreregistrationReceipt(value);
  return Object.freeze({ value, receipt, publication });
}

async function main() {
  const options = parseDataWranglerComparisonPreregistrationArguments(process.argv.slice(2));
  const result = await generateDataWranglerComparisonPreregistration(options);
  process.stdout.write(
    canonicalStudyJson({
      protocol: result.receipt.protocol,
      sha256: result.receipt.sha256,
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
