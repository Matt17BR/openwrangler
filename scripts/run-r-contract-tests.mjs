import { spawnSync } from "node:child_process";

function run(command, args, environment = process.env) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: environment,
    encoding: "utf8",
    stdio: "inherit",
    timeout: 120_000
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("Rscript", ["--vanilla", "r/tests/test-frame-contract.R"]);
run(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "src/test/rRuntimeContract.cross.test.ts"], {
  ...process.env,
  OPEN_WRANGLER_REQUIRE_R_CONTRACT: "1"
});
