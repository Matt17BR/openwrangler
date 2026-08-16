import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inspectReleaseTrainWorkflow } from "./release-train-workflow.mjs";

export function inspectStableReleaseWorkflow(source) {
  return inspectReleaseTrainWorkflow(source, "stable");
}

function runCli() {
  const path = resolve(import.meta.dirname, "..", ".github", "workflows", "stable-release.yml");
  const problems = inspectStableReleaseWorkflow(readFileSync(path, "utf8"));
  if (problems.length > 0) throw new Error(`Stable release workflow validation failed:\n- ${problems.join("\n- ")}`);
  console.log("Stable release workflow structure is valid.");
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) runCli();
