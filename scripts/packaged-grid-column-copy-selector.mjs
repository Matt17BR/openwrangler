import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGED_GRID_COLUMN_COPY_MODE = "grid-column-copy";
export const PACKAGED_GRID_COLUMN_COPY_PHASE = "grid-column-copy";
export const PACKAGED_GRID_COLUMN_COPY_EDITOR = "vscode";

export function resolvePackagedGridColumnCopySelection({ acceptanceMode, requestedEditors }) {
  if (acceptanceMode !== PACKAGED_GRID_COLUMN_COPY_MODE) {
    return Object.freeze({ enabled: false, phase: undefined });
  }
  if (
    !Array.isArray(requestedEditors) ||
    requestedEditors.length !== 1 ||
    requestedEditors[0] !== PACKAGED_GRID_COLUMN_COPY_EDITOR
  ) {
    throw new Error(
      'OPEN_WRANGLER_PACKAGED_MODE="grid-column-copy" requires exactly "vscode" in OPEN_WRANGLER_PACKAGED_EDITORS.'
    );
  }
  return Object.freeze({ enabled: true, phase: PACKAGED_GRID_COLUMN_COPY_PHASE });
}

export function packagedGridColumnCopyEnvironment(environment) {
  const existingMode = environment.OPEN_WRANGLER_PACKAGED_MODE;
  if (existingMode !== undefined && existingMode !== PACKAGED_GRID_COLUMN_COPY_MODE) {
    throw new Error("The packaged whole-column selector cannot replace another acceptance mode.");
  }
  const existingEditors = environment.OPEN_WRANGLER_PACKAGED_EDITORS;
  if (existingEditors !== undefined && existingEditors !== PACKAGED_GRID_COLUMN_COPY_EDITOR) {
    throw new Error("The packaged whole-column selector requires exactly the pinned VS Code lane.");
  }
  return {
    ...environment,
    OPEN_WRANGLER_PACKAGED_EDITORS: PACKAGED_GRID_COLUMN_COPY_EDITOR,
    OPEN_WRANGLER_PACKAGED_MODE: PACKAGED_GRID_COLUMN_COPY_MODE
  };
}

export function runPackagedGridColumnCopySelector(
  args,
  { environment = process.env, execute = spawnSync, executable = process.execPath } = {}
) {
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== "string" || /[\0\r\n]/u.test(argument))) {
    throw new TypeError("The packaged whole-column selector received invalid runner arguments.");
  }
  const script = resolve(dirname(fileURLToPath(import.meta.url)), "run-packaged-editor-tests.mjs");
  const result = execute(executable, [script, ...args], {
    env: packagedGridColumnCopyEnvironment(environment),
    stdio: "inherit",
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`The packaged whole-column selector was terminated by ${result.signal}.`);
  if (result.status !== 0) {
    throw new Error(`The packaged whole-column selector failed with exit code ${String(result.status)}.`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runPackagedGridColumnCopySelector(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
