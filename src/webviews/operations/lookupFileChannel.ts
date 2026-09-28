import type { LookupFileState } from "../../shared/lookupColumns";
import type { LookupFile } from "../../shared/protocol";
import { vscode } from "../vscodeApi";

type LookupFileListener = (requestId: string, state: LookupFileState) => void;

const listeners = new Set<LookupFileListener>();
let requestSequence = 0;

/** Asks the host to show its file picker, or to describe `file`, and returns the ID its reply will carry. */
export function requestLookupFile(file?: LookupFile): string {
  requestSequence += 1;
  const requestId = `lookup-file-${Date.now().toString(36)}-${requestSequence.toString(36)}`;
  vscode.postMessage({ kind: "lookupFile", requestId, ...(file ? { file } : {}) });
  return requestId;
}

export function publishLookupFileState(requestId: string, state: LookupFileState): void {
  for (const listener of listeners) listener(requestId, state);
}

export function subscribeLookupFileState(listener: LookupFileListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
