import { spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants, realpathSync } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const rscript = resolveExecutable(process.env.RSCRIPT ?? "Rscript");
const rEnvironment = { ...process.env, RSCRIPT: rscript };

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

run(rscript, ["--vanilla", "r/tests/frame_contract.R"], rEnvironment);
run(rscript, ["--vanilla", "r/tests/kernel_agent.R"], rEnvironment);
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
  { ...rEnvironment, OPEN_WRANGLER_R_CONTRACT_TESTS: "1" }
);
