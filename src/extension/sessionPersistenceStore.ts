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

export type SessionPersistenceFailureKind = "read" | "save" | "rollback" | "runtime-replacement";

export interface SessionPersistenceFailure {
  readonly kind: SessionPersistenceFailureKind;
  readonly ownerKey: string;
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
  private commitOrdinal = 0;
  private replacementOrdinal = 0;
  private readonly ownerStatuses = new Map<string, OwnerPersistenceStatus>();

  constructor(
    private readonly workspaceState?: Memento,
    private readonly onPersistenceFailure?: (failure: SessionPersistenceFailure) => void
  ) {}

  status(source: SessionSource, backend: DataBackend): SessionPersistenceStatus {
    const status = this.ownerStatuses.get(persistenceKey(source, backend));
    return {
      degraded: status?.degraded ?? false,
      epoch: status?.epoch ?? 0,
      ...(status?.failureKind ? { failureKind: status.failureKind } : {})
    };
  }

  load(source: SessionSource, backend: DataBackend): DecodedPersistedSessionState | undefined {
    if (!this.workspaceState || !isPersistentSession(source, backend)) return undefined;
    const key = persistenceKey(source, backend);
    const stored = this.readStored(key);
    if (!stored) return undefined;
    const state = decodePersistedSession(loadableSessionValue(stored[key]));
    return state?.backend === backend ? state : undefined;
  }

  async save(source: SessionSource, state: PersistedSessionState): Promise<void> {
    if (!this.workspaceState || !isPersistentSession(source, state.backend)) return;
    const serialized = serializePersistedSession(state);
    if (!serialized) return;
    const key = persistenceKey(source, state.backend);
    await this.enqueue(async () => {
      const stored = this.readStored(key);
      if (!stored) return;
      if (await this.writeStored(key, { ...stored, [key]: serialized }, "save")) this.confirmPersistence(key);
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
    const token = `current-commit:${++this.commitOrdinal}`;
    let committed = false;
    await this.enqueue(async () => {
      if (!isCurrent()) return;
      const stored = this.readStored(key);
      if (!stored) {
        if (isCurrent()) {
          commit();
          committed = true;
        }
        return;
      }
      const previousState = loadableSessionValue(stored[key]);
      const hadPreviousState = previousState !== undefined;
      const pending = {
        pendingCurrentCommit: {
          token,
          candidate: serialized,
          hadPreviousState,
          ...(hadPreviousState ? { previousState } : {})
        }
      };
      const staged = { ...stored, [key]: pending };
      if (!(await this.writeStored(key, staged, "save"))) {
        if (isCurrent()) {
          commit();
          committed = true;
        }
        return;
      }
      if (!isCurrent()) {
        await this.restorePendingCommit(key, token);
        return;
      }
      const latest = this.readStored(key);
      if (!latest) return;
      const latestPending = pendingCurrentCommit(latest[key], token);
      if (!latestPending) return;
      if (!isCurrent()) {
        await this.restorePending(key, latest, latestPending);
        return;
      }
      commit();
      committed = true;
      if (await this.writeStored(key, { ...latest, [key]: serialized }, "save")) this.confirmPersistence(key);
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
      const stored = this.readStored(key);
      if (!stored) return;
      const previousState = loadableSessionValue(stored[key]);
      const hadPreviousState = previousState !== undefined;
      const pending = {
        pendingRuntimeReplacement: {
          token,
          candidate: serialized,
          hadPreviousState,
          ...(hadPreviousState ? { previousState } : {})
        }
      };
      if (!(await this.writeStored(key, { ...stored, [key]: pending }, "runtime-replacement"))) return;
      if (!isCurrent()) {
        await this.restorePendingReplacement(key, token);
        return;
      }

      // Publishing is synchronous once the ignored-on-load candidate record is
      // durable. No superseding callback can interleave with this state swap.
      const rollback = commit();
      committed = true;
      const latest = this.readStored(key);
      if (!latest) {
        rollback();
        committed = false;
        return;
      }
      if (!isPendingReplacement(latest[key], token)) {
        rollback();
        committed = false;
        return;
      }
      if (!(await this.writeStored(key, { ...latest, [key]: serialized }, "runtime-replacement"))) {
        rollback();
        committed = false;
        // A pending record always decodes to the previously confirmed state,
        // matching the synchronously restored live runtime.
        return;
      }
      this.confirmPersistence(key);
    });
    return committed;
  }

  private async restorePendingCommit(key: string, token: string): Promise<void> {
    const latest = this.readStored(key);
    if (!latest) return;
    const pending = pendingCurrentCommit(latest[key], token);
    if (!pending) return;
    await this.restorePending(key, latest, pending);
  }

  private async restorePendingReplacement(key: string, token: string): Promise<void> {
    const latest = this.readStored(key);
    if (!latest) return;
    const pending = pendingReplacement(latest[key], token);
    if (!pending) return;
    await this.restorePending(key, latest, pending);
  }

  private async restorePending(
    key: string,
    latest: Record<string, unknown>,
    pending: PendingPersistenceCommit
  ): Promise<void> {
    const restored = { ...latest };
    if (pending.hadPreviousState) restored[key] = pending.previousState;
    else delete restored[key];
    if (await this.writeStored(key, restored, "rollback")) this.confirmPersistence(key);
  }

  private readStored(ownerKey: string): Record<string, unknown> | undefined {
    try {
      return this.workspaceState?.get<Record<string, unknown>>(SESSION_STORAGE_KEY, {}) ?? {};
    } catch (error) {
      this.recordFailure(ownerKey, "read", error);
      return undefined;
    }
  }

  private async writeStored(
    ownerKey: string,
    value: Record<string, unknown>,
    kind: Exclude<SessionPersistenceFailureKind, "read">
  ): Promise<boolean> {
    try {
      await this.workspaceState?.update(SESSION_STORAGE_KEY, value);
      return true;
    } catch (error) {
      this.recordFailure(ownerKey, kind, error);
      return false;
    }
  }

  private recordFailure(ownerKey: string, kind: SessionPersistenceFailureKind, error: unknown): void {
    const previous = this.ownerStatuses.get(ownerKey);
    const firstInEpoch = !previous?.degraded;
    const status: OwnerPersistenceStatus = {
      degraded: true,
      epoch: firstInEpoch ? (previous?.epoch ?? 0) + 1 : (previous?.epoch ?? 1),
      failureKind: kind
    };
    this.ownerStatuses.set(ownerKey, status);
    try {
      this.onPersistenceFailure?.({ kind, ownerKey, error, epoch: status.epoch, firstInEpoch });
    } catch {
      // Diagnostics must not change live-session or persistence queue behavior.
    }
  }

  private confirmPersistence(ownerKey: string): void {
    const previous = this.ownerStatuses.get(ownerKey);
    if (!previous) return;
    this.ownerStatuses.set(ownerKey, { degraded: false, epoch: previous.epoch });
  }

  private async enqueue(task: () => Promise<void>): Promise<void> {
    const pending = this.tail.catch(() => undefined).then(task);
    this.tail = pending.catch(() => undefined);
    await this.tail;
  }
}

interface OwnerPersistenceStatus extends SessionPersistenceStatus {
  readonly degraded: boolean;
  readonly epoch: number;
}

interface PendingPersistenceCommit {
  token: string;
  candidate: SerializedPersistedSessionState;
  hadPreviousState: boolean;
  previousState?: unknown;
}

function pendingCurrentCommit(value: unknown, token?: string): PendingPersistenceCommit | undefined {
  return pendingCommit(value, "pendingCurrentCommit", token);
}

function pendingReplacement(value: unknown, token?: string): PendingPersistenceCommit | undefined {
  return pendingCommit(value, "pendingRuntimeReplacement", token);
}

function pendingCommit(
  value: unknown,
  property: "pendingCurrentCommit" | "pendingRuntimeReplacement",
  token?: string
): PendingPersistenceCommit | undefined {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !isRecord(value[property])) {
    return undefined;
  }
  const pending = value[property];
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
  return pending as unknown as PendingPersistenceCommit;
}

function isPendingReplacement(value: unknown, token: string): boolean {
  return pendingReplacement(value, token) !== undefined;
}

function loadableSessionValue(value: unknown): unknown {
  const pending = pendingCurrentCommit(value) ?? pendingReplacement(value);
  if (!pending) return value;
  return pending.hadPreviousState ? pending.previousState : undefined;
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
