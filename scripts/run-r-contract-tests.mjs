import { spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants, realpathSync } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const rscript = resolveExecutable(process.env.RSCRIPT ?? "Rscript");
const r = resolveExecutable(process.env.R ?? "R");
const rEnvironment = { ...process.env, R: r, RSCRIPT: rscript };
const DIRECT_R_CONTRACT_TIMEOUT_MS = 300_000;
const VITEST_CONTRACT_TIMEOUT_MS = 120_000;

function resolveExecutable(command) {
  const candidates = isAbsolute(command)
    ? [command]
    : (process.env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .flatMap((entry) =>
          process.platform === "win32"
            ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT")
                .split(";")
                .map((extension) => resolve(entry, `${command}${extension}`))
            : [resolve(entry, command)]
        );
  for (const candidate of candidates) {
    try {
      accessSync(candidate, fsConstants.X_OK);
      return realpathSync(candidate);
    } catch {
      // Keep searching the caller's PATH.
    }
  }
  throw new Error(`Could not find the requested Rscript executable: ${command}`);
}

function run(command, args, { environment = process.env, timeoutMs }) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: "inherit",
    timeout: timeoutMs,
    env: environment
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed with ${result.status === null ? "a signal" : `exit ${result.status}`}.`);
  }
}

run(rscript, ["--vanilla", "r/tests/frame_contract.R"], {
  environment: rEnvironment,
  timeoutMs: DIRECT_R_CONTRACT_TIMEOUT_MS
});
run(rscript, ["--vanilla", "r/tests/kernel_agent.R"], {
  environment: rEnvironment,
  timeoutMs: DIRECT_R_CONTRACT_TIMEOUT_MS
});
run(rscript, ["--vanilla", "r/tests/complete_catalog_contract.R"], {
  environment: rEnvironment,
  timeoutMs: DIRECT_R_CONTRACT_TIMEOUT_MS
});
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
    "src/test/rInteractiveSessionTransport.cross.test.ts",
    "--maxWorkers=1"
  ],
  {
    environment: { ...rEnvironment, OPEN_WRANGLER_R_CONTRACT_TESTS: "1" },
    timeoutMs: VITEST_CONTRACT_TIMEOUT_MS
  }
);
