import { execFile } from "node:child_process";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import type * as vscode from "vscode";
import { describe, expect, it } from "vitest";
import {
  MAX_SYSTEM_PYTHON_CANDIDATES,
  PYTHON_ENVIRONMENT_RESOLUTION_TIMEOUT_MS,
  isPythonEnvironmentResolutionTerminalError,
  resolvePythonEnvironment,
  type PythonEnvironmentProcessExecutor
} from "../extension/pythonEnvironment";
import { isFullyQualifiedPythonPath } from "../extension/pythonPath";

const execFileAsync = promisify(execFile);

describe("real Python environment resolution", () => {
  it(
    "discovers one supported, fully qualified system interpreter inside the aggregate bound",
    async () => {
      let processCount = 0;
      const executeProcess: PythonEnvironmentProcessExecutor = async (executable, arguments_, options) => {
        processCount += 1;
        const result = await execFileAsync(executable, [...arguments_], options);
        return { stdout: result.stdout, stderr: result.stderr };
      };
      const startedAt = performance.now();

      try {
        const environment = await resolvePythonEnvironment(
          { extensionPath: path.resolve(__dirname, "..", "..") } as vscode.ExtensionContext,
          undefined,
          undefined,
          { executeProcess }
        );
        const elapsedMs = performance.now() - startedAt;

        expect(environment.source).toBe("system");
        expect(isFullyQualifiedPythonPath(environment.executable)).toBe(true);
        expect(environment.version).toMatch(/^3\.(?:10|11|12|13|14)\.\d+$/);
        expect(path.isAbsolute(environment.packageRoot)).toBe(true);
        expect(processCount).toBeGreaterThan(0);
        expect(processCount).toBeLessThanOrEqual(MAX_SYSTEM_PYTHON_CANDIDATES + 1);
        expect(elapsedMs).toBeLessThan(PYTHON_ENVIRONMENT_RESOLUTION_TIMEOUT_MS);
      } catch (error) {
        const classification = isPythonEnvironmentResolutionTerminalError(error)
          ? error.code
          : "python_environment_resolution_failed";
        throw new Error(
          `Python environment smoke failed: classification=${classification}; stage=system-resolution; processCount=${processCount}; candidateLimit=${MAX_SYSTEM_PYTHON_CANDIDATES}.`
        );
      }
    },
    PYTHON_ENVIRONMENT_RESOLUTION_TIMEOUT_MS + 5_000
  );
});
