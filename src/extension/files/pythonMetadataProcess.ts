import { execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import { stopChildProcessGracefully } from "../processShutdown";

const execFileAsync = promisify(execFile);

export interface PythonMetadataProcessOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly encoding: "utf8";
  readonly maxBuffer: number;
  readonly shell: false;
  readonly signal?: AbortSignal;
  readonly timeout: number;
  readonly windowsHide: true;
}

export type PythonMetadataExecutor = (
  executable: string,
  arguments_: readonly string[],
  options: PythonMetadataProcessOptions
) => Promise<{ stdout: string }>;

export const executePythonMetadataProcess: PythonMetadataExecutor = async (executable, arguments_, options) => {
  const result = execFileAsync(executable, [...arguments_], { ...options, killSignal: "SIGKILL" });
  // Abort can reject execFile before close. Keep the environment read lease
  // until the child and its stdio are closed, including on spawn failure.
  let hasClosed = false;
  const closed = new Promise<void>((resolve) =>
    result.child.once("close", () => {
      hasClosed = true;
      resolve();
    })
  );
  try {
    return { stdout: (await result).stdout };
  } catch (error) {
    // Node's execFile uses killSignal for its timeout, but AbortSignal still
    // reaches spawn with its default SIGTERM. Finish stopping a surviving child.
    if (!hasClosed && result.child.pid !== undefined) {
      try {
        await stopChildProcessGracefully(result.child as ChildProcessWithoutNullStreams, 0);
      } catch {
        // An unconfirmed stop must not release the environment read lease.
        // The close event below remains authoritative, even after this failure.
      }
    }
    throw error;
  } finally {
    await closed;
  }
};
