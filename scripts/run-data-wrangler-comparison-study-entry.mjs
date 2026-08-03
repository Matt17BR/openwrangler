#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { runDataWranglerComparisonStudyCli } from "./run-data-wrangler-comparison-study.mjs";
import { runHeavyLocalCommand } from "./run-heavy-local-command.mjs";

export async function runDataWranglerComparisonStudyPublicEntry(arguments_ = process.argv.slice(2)) {
  if (arguments_[0] !== "run-next") {
    await runDataWranglerComparisonStudyCli(arguments_);
    return;
  }
  const { code, signal } = await runHeavyLocalCommand([
    "comparison:study:run-next",
    "--",
    "node",
    "scripts/run-data-wrangler-comparison-study.mjs",
    ...arguments_
  ]);
  if (signal) {
    throw new Error(`Open Wrangler comparison study run-next ended after signal ${signal}.`);
  }
  if (code !== 0) process.exitCode = code ?? 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runDataWranglerComparisonStudyPublicEntry().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
