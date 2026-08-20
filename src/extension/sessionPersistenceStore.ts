import type { Memento } from "vscode";
import type { DataBackend, SessionSource } from "../shared/protocol";
import {
  decodePersistedSession,
  persistenceKey,
  serializePersistedSession,
  SESSION_STORAGE_KEY,
  type DecodedPersistedSessionState,
  type PersistedSessionState,
  type SerializedPersistedSessionState
} from "./sessionPersistence";

export type SessionPersistenceFailureKind = "save" | "rollback" | "runtime-replacement";

export interface SessionPersistenceFailure {
  readonly kind: SessionPersistenceFailureKind;
  readonly error: unknown;
  readonly epoch: number;
  readonly firstInEpoch: boolean;
}

export interface SessionPersistenceStatus {
  readonly degraded: boolean;
  readonly epoch: number;
  readonly failureKind?: SessionPersistenceFailureKind;
}

export class SessionPersistenceStore {
  private tail: Promise<void> = Promise.resolve();
  private replacementOrdinal = 0;
  private degraded = false;
  private degradationEpoch = 0;
  private failureKind: SessionPersistenceFailureKind | undefined;

  constructor(
    private readonly workspaceState?: Memento,
    private readonly onPersistenceFailure?: (failure: SessionPersistenceFailure) => void
  ) {}

  status(): SessionPersistenceStatus {
    return {
      degraded: this.degraded,
      epoch: this.degradationEpoch,
      ...(this.failureKind ? { failureKind: this.failureKind } : {})
    };
  }

  load(source: SessionSource, backend: DataBackend): DecodedPersistedSessionState | undefined {
    if (!this.workspaceState || !isPersistentSession(source, backend)) return undefined;
    const key = persistenceKey(source, backend);
    const stored = this.workspaceState.get<Record<string, unknown>>(SESSION_STORAGE_KEY, {});
    const state = decodePersistedSession(loadableSessionValue(stored[key]));
    return state?.backend === backend ? state : undefined;
  }

  async save(source: SessionSource, state: PersistedSessionState): Promise<void> {
    if (!this.workspaceState || !isPersistentSession(source, state.backend)) return;
    const serialized = serializePersistedSession(state);
    if (!serialized) return;
    const key = persistenceKey(source, state.backend);
    await this.enqueue(async () => {
      const stored = this.readStored("save");
      if (!stored) return;
      if (await this.writeStored({ ...stored, [key]: serialized }, "save")) this.confirmPersistence();
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
    const serialized = serializePersistedSession(state);
    if (!serialized) {
      if (!isCurrent()) return false;
      commit();
      return true;
    }

    const key = persistenceKey(source, state.backend);
    let committed = false;
    await this.enqueue(async () => {
      if (!isCurrent()) return;
      const stored = this.readStored("save");
      if (!stored) return;
      const hadPreviousState = Object.prototype.hasOwnProperty.call(stored, key);
      const previousState = stored[key];
      if (!(await this.writeStored({ ...stored, [key]: serialized }, "save"))) {
        if (isCurrent()) {
          commit();
          committed = true;
        }
        return;
      }
      if (!isCurrent()) {
        const latest = this.readStored("rollback");
        if (!latest) return;
        const restored = { ...latest };
        if (hadPreviousState) restored[key] = previousState;
        else delete restored[key];
        if (await this.writeStored(restored, "rollback")) this.confirmPersistence();
        return;
      }
      commit();
      committed = true;
      this.confirmPersistence();
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
    const serialized = serializePersistedSession(state);
    if (!serialized) return false;

    const key = persistenceKey(source, state.backend);
    const token = `runtime-replacement:${++this.replacementOrdinal}`;
    let committed = false;
    await this.enqueue(async () => {
      if (!isCurrent()) return;
      const stored = this.readStored("runtime-replacement");
      if (!stored) return;
      const hadPreviousState = Object.prototype.hasOwnProperty.call(stored, key);
      const previousState = stored[key];
      const pending = {
        pendingRuntimeReplacement: {
          token,
          candidate: serialized,
          hadPreviousState,
          ...(hadPreviousState ? { previousState } : {})
        }
      };
      if (!(await this.writeStored({ ...stored, [key]: pending }, "runtime-replacement"))) return;
      if (!isCurrent()) {
        await this.restorePendingReplacement(key, token);
        return;
      }

      // Publishing is synchronous once the ignored-on-load candidate record is
      // durable. No superseding callback can interleave with this state swap.
      const rollback = commit();
      committed = true;
      const latest = this.readStored("runtime-replacement");
      if (!latest) return;
      if (!isPendingReplacement(latest[key], token)) {
        rollback();
        committed = false;
        return;
      }
      if (!(await this.writeStored({ ...latest, [key]: serialized }, "runtime-replacement"))) {
        rollback();
        committed = false;
        // A pending record always decodes to the previously confirmed state,
        // matching the synchronously restored live runtime.
        return;
      }
      this.confirmPersistence();
    });
    return committed;
  }

  private async restorePendingReplacement(key: string, token: string): Promise<void> {
    const latest = this.readStored("rollback");
    if (!latest) return;
    const pending = pendingReplacement(latest[key], token);
    if (!pending) return;
    const restored = { ...latest };
    if (pending.hadPreviousState) restored[key] = pending.previousState;
    else delete restored[key];
    if (await this.writeStored(restored, "rollback")) this.confirmPersistence();
  }

  private readStored(kind: SessionPersistenceFailureKind): Record<string, unknown> | undefined {
    try {
      return this.workspaceState?.get<Record<string, unknown>>(SESSION_STORAGE_KEY, {}) ?? {};
    } catch (error) {
      this.recordFailure(kind, error);
      return undefined;
    }
  }

  private async writeStored(value: Record<string, unknown>, kind: SessionPersistenceFailureKind): Promise<boolean> {
    try {
      await this.workspaceState?.update(SESSION_STORAGE_KEY, value);
      return true;
    } catch (error) {
      this.recordFailure(kind, error);
      return false;
    }
  }

  private recordFailure(kind: SessionPersistenceFailureKind, error: unknown): void {
    const firstInEpoch = !this.degraded;
    if (firstInEpoch) this.degradationEpoch += 1;
    this.degraded = true;
    this.failureKind = kind;
    try {
      this.onPersistenceFailure?.({ kind, error, epoch: this.degradationEpoch, firstInEpoch });
    } catch {
      // Diagnostics must not change live-session or persistence queue behavior.
    }
  }

  private confirmPersistence(): void {
    this.degraded = false;
    this.failureKind = undefined;
  }

  private async enqueue(task: () => Promise<void>): Promise<void> {
    const pending = this.tail.catch(() => undefined).then(task);
    this.tail = pending.catch(() => undefined);
    await this.tail;
  }
}

interface PendingRuntimeReplacement {
  token: string;
  candidate: SerializedPersistedSessionState;
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
