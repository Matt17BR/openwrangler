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
  private replacementOrdinal = 0;

  constructor(private readonly workspaceState?: Memento) {}

  load(source: SessionSource, backend: DataBackend): DecodedPersistedSessionState | undefined {
    if (!this.workspaceState || !isPersistentSession(source, backend)) return undefined;
    const key = persistenceKey(source, backend);
    const stored = this.workspaceState.get<Record<string, unknown>>(SESSION_STORAGE_KEY, {});
    const state = decodePersistedSession(loadableSessionValue(stored[key]));
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

  async commitRuntimeReplacement(
    source: SessionSource,
    state: PersistedSessionState,
    isCurrent: () => boolean,
    commit: () => () => void
  ): Promise<boolean> {
    if (!this.workspaceState || !isPersistentSession(source, state.backend)) {
      if (!isCurrent()) return false;
      commit();
      return true;
    }

    const key = persistenceKey(source, state.backend);
    const token = `runtime-replacement:${++this.replacementOrdinal}`;
    let committed = false;
    await this.enqueue(async () => {
      if (!isCurrent()) return;
      const stored = this.workspaceState?.get<Record<string, unknown>>(SESSION_STORAGE_KEY, {}) ?? {};
      const hadPreviousState = Object.prototype.hasOwnProperty.call(stored, key);
      const previousState = stored[key];
      const pending = {
        pendingRuntimeReplacement: {
          token,
          candidate: state,
          hadPreviousState,
          ...(hadPreviousState ? { previousState } : {})
        }
      };
      try {
        await this.workspaceState?.update(SESSION_STORAGE_KEY, { ...stored, [key]: pending });
      } catch {
        return;
      }
      if (!isCurrent()) {
        await this.restorePendingReplacement(key, token);
        return;
      }

      // Publishing is synchronous once the ignored-on-load candidate record is
      // durable. No superseding callback can interleave with this state swap.
      const rollback = commit();
      committed = true;
      const latest = this.workspaceState?.get<Record<string, unknown>>(SESSION_STORAGE_KEY, {}) ?? {};
      if (!isPendingReplacement(latest[key], token)) {
        rollback();
        committed = false;
        return;
      }
      try {
        await this.workspaceState?.update(SESSION_STORAGE_KEY, { ...latest, [key]: state });
      } catch {
        rollback();
        committed = false;
        // A pending record always decodes to the previously confirmed state,
        // matching the synchronously restored live runtime.
      }
    });
    return committed;
  }

  private async restorePendingReplacement(key: string, token: string): Promise<void> {
    const latest = this.workspaceState?.get<Record<string, unknown>>(SESSION_STORAGE_KEY, {}) ?? {};
    const pending = pendingReplacement(latest[key], token);
    if (!pending) return;
    const restored = { ...latest };
    if (pending.hadPreviousState) restored[key] = pending.previousState;
    else delete restored[key];
    try {
      await this.workspaceState?.update(SESSION_STORAGE_KEY, restored);
    } catch {
      // The retained pending record remains ignored and resolves to the prior
      // confirmed state even when best-effort physical rollback is unavailable.
    }
  }

  private async enqueue(task: () => Promise<void>): Promise<void> {
    const pending = this.tail.catch(() => undefined).then(task);
    this.tail = pending.catch(() => undefined);
    await this.tail;
  }
}

interface PendingRuntimeReplacement {
  token: string;
  candidate: PersistedSessionState;
  hadPreviousState: boolean;
  previousState?: unknown;
}

function pendingReplacement(value: unknown, token?: string): PendingRuntimeReplacement | undefined {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !isRecord(value.pendingRuntimeReplacement)) {
    return undefined;
  }
  const pending = value.pendingRuntimeReplacement;
  const allowed = new Set(["token", "candidate", "hadPreviousState", "previousState"]);
  if (
    Object.keys(pending).some((key) => !allowed.has(key)) ||
    typeof pending.token !== "string" ||
    pending.token.length === 0 ||
    (token !== undefined && pending.token !== token) ||
    typeof pending.hadPreviousState !== "boolean" ||
    !isRecord(pending.candidate) ||
    pending.hadPreviousState !== Object.prototype.hasOwnProperty.call(pending, "previousState")
  ) {
    return undefined;
  }
  return pending as unknown as PendingRuntimeReplacement;
}

function isPendingReplacement(value: unknown, token: string): boolean {
  return pendingReplacement(value, token) !== undefined;
}

function loadableSessionValue(value: unknown): unknown {
  const pending = pendingReplacement(value);
  return pending?.hadPreviousState ? pending.previousState : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPersistentSession(source: SessionSource, backend: DataBackend): boolean {
  // Saved notebook outputs are bounded value snapshots, not reopenable source
  // data. Distributed Spark and native R frames belong to one exact live
  // notebook kernel, so workspace replay must never try to reacquire them.
  return source.kind !== "notebookOutput" && backend !== "pyspark" && backend !== "r";
}
