/**
 * Returns whether a POSIX process group still has at least one member.
 *
 * `EPERM` proves that the group exists even when the caller cannot signal it.
 * Other probe failures are ownership uncertainty and must stay visible to the
 * caller.
 */
export function posixProcessGroupRunning(pid, signalProcess = process.kill) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new TypeError("A POSIX process-group identity must be one positive safe integer.");
  }
  try {
    signalProcess(-pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ESRCH") return false;
    if (error && typeof error === "object" && error.code === "EPERM") return true;
    throw error;
  }
}

/** Signals every process in an already-owned POSIX process group. */
export function signalPosixProcessGroup(pid, signal, signalProcess = process.kill) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new TypeError("A POSIX process-group identity must be one positive safe integer.");
  }
  signalProcess(-pid, signal);
}
