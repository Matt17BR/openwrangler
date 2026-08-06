import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const rscript = process.env.RSCRIPT ?? "Rscript";

function run(command, args, environment = process.env) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: "inherit",
    timeout: 120_000,
    env: environment
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed with ${result.status === null ? "a signal" : `exit ${result.status}`}.`);
  }
}

run(rscript, ["--vanilla", "r/tests/frame_contract.R"]);
run(rscript, ["--vanilla", "r/tests/kernel_agent.R"]);
run(
  process.execPath,
  [
    "node_modules/vitest/vitest.mjs",
    "run",
    "src/test/rFrameContract.unit.test.ts",
    "src/test/rFrameContract.cross.test.ts",
    "src/test/rKernelTransport.unit.test.ts",
    "src/test/rKernelTransport.cross.test.ts",
    "src/test/rProcessTransport.cross.test.ts",
    "--maxWorkers=1"
  ],
  { ...process.env, OPEN_WRANGLER_R_CONTRACT_TESTS: "1" }
);
