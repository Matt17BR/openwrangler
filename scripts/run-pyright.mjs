import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { resolveAndPreflightAcceptancePython } from "./packaged-python-preflight.mjs";

const root = resolve(import.meta.dirname, "..");
const python = resolveAndPreflightAcceptancePython({
  profile: "repository-command",
  repositoryRoot: root,
  environment: process.env,
  platform: process.platform
});

const pyright = join(root, "node_modules", ".bin", process.platform === "win32" ? "pyright.cmd" : "pyright");
const result = spawnSync(pyright, ["--pythonpath", python, ...process.argv.slice(2)], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32"
});

if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
