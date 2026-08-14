import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { resolveAndPreflightAcceptancePython } from "./packaged-python-preflight.mjs";

const root = resolve(import.meta.dirname, "..");
const executable = resolveAndPreflightAcceptancePython({
  profile: "repository-command",
  repositoryRoot: root,
  environment: process.env,
  platform: process.platform
});
const result = spawnSync(executable, process.argv.slice(2), {
  cwd: root,
  env: {
    ...process.env,
    PYTHONPATH: resolve(root, "python")
  },
  stdio: "inherit"
});

if (result.error) {
  throw result.error;
}
process.exitCode = result.status ?? 1;
