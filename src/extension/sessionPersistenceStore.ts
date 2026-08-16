import type { Memento } from "vscode";
import type { DataBackend, SessionSource } from "../shared/protocol";
import {
  decodePersistedSession,
  persistenceKey,
  SESSION_STORAGE_KEY,
  type DecodedPersistedSessionState,
  type PersistedSessionState
} from "./sessionPersistence";

export class SessionPersistenceStore {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly workspaceState?: Memento) {}

  load(source: SessionSource, backend: DataBackend): DecodedPersistedSessionState | undefined {
    if (!this.workspaceState || !isPersistentSession(source, backend)) return undefined;
    const key = persistenceKey(source, backend);
    const stored = this.workspaceState.get<Record<string, unknown>>(SESSION_STORAGE_KEY, {});
    const state = decodePersistedSession(stored[key]);
    return state?.backend === backend ? state : undefined;
  }

  async save(source: SessionSource, state: PersistedSessionState): Promise<void> {
    if (!this.workspaceState || !isPersistentSession(source, state.backend)) return;
    const key = persistenceKey(source, state.backend);
    await this.enqueue(async () => {
      const stored = this.workspaceState?.get<Record<string, unknown>>(SESSION_STORAGE_KEY, {}) ?? {};
      await this.workspaceState?.update(SESSION_STORAGE_KEY, { ...stored, [key]: state });
    });
  }

  async commitCurrent(
    source: SessionSource,
    state: PersistedSessionState,
    isCurrent: () => boolean,
    commit: () => void
  ): Promise<boolean> {
    if (!this.workspaceState || !isPersistentSession(source, state.backend)) {
      if (!isCurrent()) return false;
      commit();
      return true;
    }

    const key = persistenceKey(source, state.backend);
    let committed = false;
    await this.enqueue(async () => {
      if (!isCurrent()) return;
      const stored = this.workspaceState?.get<Record<string, unknown>>(SESSION_STORAGE_KEY, {}) ?? {};
      const hadPreviousState = Object.prototype.hasOwnProperty.call(stored, key);
      const previousState = stored[key];
      try {
        await this.workspaceState?.update(SESSION_STORAGE_KEY, { ...stored, [key]: state });
      } catch {
        if (isCurrent()) {
          commit();
          committed = true;
        }
        return;
      }
      if (!isCurrent()) {
        const latest = this.workspaceState?.get<Record<string, unknown>>(SESSION_STORAGE_KEY, {}) ?? {};
        const restored = { ...latest };
        if (hadPreviousState) restored[key] = previousState;
        else delete restored[key];
        try {
          await this.workspaceState?.update(SESSION_STORAGE_KEY, restored);
        } catch {
          // The stale page remains rejected even if best-effort persistence rollback fails.
        }
        return;
      }
      commit();
      committed = true;
    });
    return committed;
  }

  private async enqueue(task: () => Promise<void>): Promise<void> {
    const pending = this.tail.catch(() => undefined).then(task);
    this.tail = pending.catch(() => undefined);
    await this.tail;
  }
}

function isPersistentSession(source: SessionSource, backend: DataBackend): boolean {
  // Saved notebook outputs are bounded value snapshots, not reopenable source
  // data. Distributed Spark and native R frames belong to one exact live
  // notebook kernel, so workspace replay must never try to reacquire them.
  return source.kind !== "notebookOutput" && backend !== "pyspark" && backend !== "r";
}
