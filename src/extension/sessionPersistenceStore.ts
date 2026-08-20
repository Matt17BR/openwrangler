import { AsyncLocalStorage } from "node:async_hooks";
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

export interface SessionPersistenceFailureCause {
  readonly name: string;
  readonly code?: string;
}

export interface SessionPersistenceFailure {
  readonly kind: SessionPersistenceFailureKind;
  readonly cause: SessionPersistenceFailureCause;
  readonly epoch: number;
  readonly firstInEpoch: boolean;
}

export type SessionPersistenceCommitResult =
  | { readonly kind: "committed" }
  | { readonly kind: "stale" }
  | {
      readonly kind: "unavailable";
      readonly failure: SessionPersistenceFailure;
      readonly liveState: "committed" | "unchanged";
    };

export interface SessionPersistenceStatus {
  readonly degraded: boolean;
  readonly epoch: number;
  readonly failureKind?: SessionPersistenceFailureKind;
}

export interface SessionPersistenceOpeningResult<T> {
  readonly value: T;
  readonly readFailure?: SessionPersistenceFailure;
}

export class SessionPersistenceStore {
  private storageTail: Promise<void> = Promise.resolve();
  private commitOrdinal = 0;
  private replacementOrdinal = 0;
  private readonly ownerStatuses = new Map<string, OwnerPersistenceStatus>();
  private readonly retainedOwnerKeys = new Map<string, string>();
  private readonly ownerRetentionCounts = new Map<string, number>();
  private readonly keyTaskTails = new Map<string, Promise<void>>();
  private readonly openingOwner = new AsyncLocalStorage<OpeningPersistenceOwner>();

  constructor(
    private readonly workspaceState?: Memento,
    private readonly onPersistenceFailure?: (failure: SessionPersistenceFailure) => void
  ) {}

  retainOwner(ownerId: string, source: SessionSource, backend: DataBackend): void {
    const previousKey = this.retainedOwnerKeys.get(ownerId);
    const key = isPersistentSession(source, backend) ? persistenceKey(source, backend) : undefined;
    if (previousKey === key) return;
    if (previousKey) void this.scheduleOwnerKeyRelease(previousKey);
    if (!key) {
      this.retainedOwnerKeys.delete(ownerId);
      return;
    }
    this.retainedOwnerKeys.set(ownerId, key);
    this.ownerRetentionCounts.set(key, (this.ownerRetentionCounts.get(key) ?? 0) + 1);
  }

  releaseOwner(ownerId: string): Promise<void> {
    const key = this.retainedOwnerKeys.get(ownerId);
    if (!key) return Promise.resolve();
    this.retainedOwnerKeys.delete(ownerId);
    return this.scheduleOwnerKeyRelease(key);
  }

  private scheduleOwnerKeyRelease(key: string): Promise<void> {
    const tail = this.keyTaskTails.get(key);
    if (!tail) {
      this.releaseOwnerKey(key);
      return Promise.resolve();
    }
    return tail.finally(() => this.releaseOwnerKey(key));
  }

  async withOpeningOwner<T>(
    ownerId: string,
    source: SessionSource,
    backend: DataBackend | undefined,
    operation: () => Promise<T>
  ): Promise<SessionPersistenceOpeningResult<T>> {
    const owner: OpeningPersistenceOwner = { ownerId, source, active: true };
    if (backend) this.retainOwner(ownerId, source, backend);
    return this.openingOwner.run(owner, async () => {
      try {
        const value = await operation();
        return { value, ...(owner.readFailure ? { readFailure: owner.readFailure } : {}) };
      } finally {
        owner.active = false;
      }
    });
  }

  ownershipCardinality(): {
    readonly retainedOwners: number;
    readonly retainedKeys: number;
    readonly degradedKeys: number;
  } {
    return {
      retainedOwners: this.retainedOwnerKeys.size,
      retainedKeys: this.ownerRetentionCounts.size,
      degradedKeys: this.ownerStatuses.size
    };
  }

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
    const openingOwner = this.bindOpeningOwner(source, backend);
    const key = persistenceKey(source, backend);
    const stored = this.readStored(key);
    if (!stored.ok) {
      if (openingOwner && !openingOwner.readFailure) openingOwner.readFailure = stored.failure;
      return undefined;
    }
    const state = decodePersistedSession(loadableSessionValue(stored.value[key]));
    return state?.backend === backend ? state : undefined;
  }

  async save(source: SessionSource, state: PersistedSessionState): Promise<void> {
    if (!this.workspaceState || !isPersistentSession(source, state.backend)) return;
    const serialized = serializePersistedSession(state);
    if (!serialized) return;
    const key = persistenceKey(source, state.backend);
    await this.enqueue(key, async () => {
      const stored = this.readStored(key);
      if (!stored.ok) return;
      const written = await this.writeStored(key, { ...stored.value, [key]: serialized }, "save");
      if (written.ok) this.confirmPersistence(key);
    });
  }

  async commitCurrent(
    source: SessionSource,
    state: PersistedSessionState,
    isCurrent: () => boolean,
    commit: () => void
  ): Promise<SessionPersistenceCommitResult> {
    if (!this.workspaceState || !isPersistentSession(source, state.backend)) {
      if (!isCurrent()) return { kind: "stale" };
      commit();
      return { kind: "committed" };
    }
    const serialized = serializePersistedSession(state);
    if (!serialized) {
      if (!isCurrent()) return { kind: "stale" };
      commit();
      return { kind: "committed" };
    }

    const key = persistenceKey(source, state.backend);
    const token = `current-commit:${++this.commitOrdinal}`;
    let result: SessionPersistenceCommitResult = { kind: "stale" };
    await this.enqueue(key, async () => {
      if (!isCurrent()) return;
      const stored = this.readStored(key);
      if (!stored.ok) {
        const current = isCurrent();
        if (current) {
          commit();
        }
        result = unavailable(stored.failure, current ? "committed" : "unchanged");
        return;
      }
      const previousState = loadableSessionValue(stored.value[key]);
      const hadPreviousState = previousState !== undefined;
      const pending = {
        pendingCurrentCommit: {
          token,
          candidate: serialized,
          hadPreviousState,
          ...(hadPreviousState ? { previousState } : {})
        }
      };
      const staged = { ...stored.value, [key]: pending };
      const pendingWrite = await this.writeStored(key, staged, "save");
      if (!pendingWrite.ok) {
        const current = isCurrent();
        if (current) {
          commit();
        }
        result = unavailable(pendingWrite.failure, current ? "committed" : "unchanged");
        return;
      }
      if (!isCurrent()) {
        result = await this.restorePendingCommit(key, token);
        return;
      }
      const latest = this.readStored(key);
      if (!latest.ok) {
        const current = isCurrent();
        if (current) commit();
        result = unavailable(latest.failure, current ? "committed" : "unchanged");
        return;
      }
      const latestPending = pendingCurrentCommit(latest.value[key], token);
      if (!latestPending) return;
      if (!isCurrent()) {
        result = await this.restorePending(key, latest.value, latestPending);
        return;
      }
      commit();
      const candidateWrite = await this.writeStored(key, { ...latest.value, [key]: serialized }, "save");
      if (!candidateWrite.ok) {
        result = unavailable(candidateWrite.failure, "committed");
        return;
      }
      this.confirmPersistence(key);
      result = { kind: "committed" };
    });
    return result;
  }

  async commitRuntimeReplacement(
    source: SessionSource,
    state: PersistedSessionState,
    isCurrent: () => boolean,
    commit: () => () => void
  ): Promise<SessionPersistenceCommitResult> {
    if (!this.workspaceState || !isPersistentSession(source, state.backend)) {
      if (!isCurrent()) return { kind: "stale" };
      commit();
      return { kind: "committed" };
    }
    const serialized = serializePersistedSession(state);
    if (!serialized) return { kind: "stale" };

    const key = persistenceKey(source, state.backend);
    const token = `runtime-replacement:${++this.replacementOrdinal}`;
    let result: SessionPersistenceCommitResult = { kind: "stale" };
    await this.enqueue(key, async () => {
      if (!isCurrent()) return;
      const stored = this.readStored(key);
      if (!stored.ok) {
        result = unavailable(stored.failure, "unchanged");
        return;
      }
      const previousState = loadableSessionValue(stored.value[key]);
      const hadPreviousState = previousState !== undefined;
      const pending = {
        pendingRuntimeReplacement: {
          token,
          candidate: serialized,
          hadPreviousState,
          ...(hadPreviousState ? { previousState } : {})
        }
      };
      const pendingWrite = await this.writeStored(key, { ...stored.value, [key]: pending }, "runtime-replacement");
      if (!pendingWrite.ok) {
        result = unavailable(pendingWrite.failure, "unchanged");
        return;
      }
      if (!isCurrent()) {
        result = await this.restorePendingReplacement(key, token);
        return;
      }

      // Publishing is synchronous once the ignored-on-load candidate record is
      // durable. No superseding callback can interleave with this state swap.
      const rollback = commit();
      const latest = this.readStored(key);
      if (!latest.ok) {
        rollback();
        result = unavailable(latest.failure, "unchanged");
        return;
      }
      if (!isPendingReplacement(latest.value[key], token)) {
        rollback();
        return;
      }
      const candidateWrite = await this.writeStored(key, { ...latest.value, [key]: serialized }, "runtime-replacement");
      if (!candidateWrite.ok) {
        rollback();
        // A pending record always decodes to the previously confirmed state,
        // matching the synchronously restored live runtime.
        result = unavailable(candidateWrite.failure, "unchanged");
        return;
      }
      this.confirmPersistence(key);
      result = { kind: "committed" };
    });
    return result;
  }

  private async restorePendingCommit(key: string, token: string): Promise<SessionPersistenceCommitResult> {
    const latest = this.readStored(key);
    if (!latest.ok) return unavailable(latest.failure, "unchanged");
    const pending = pendingCurrentCommit(latest.value[key], token);
    if (!pending) return { kind: "stale" };
    return this.restorePending(key, latest.value, pending);
  }

  private async restorePendingReplacement(key: string, token: string): Promise<SessionPersistenceCommitResult> {
    const latest = this.readStored(key);
    if (!latest.ok) return unavailable(latest.failure, "unchanged");
    const pending = pendingReplacement(latest.value[key], token);
    if (!pending) return { kind: "stale" };
    return this.restorePending(key, latest.value, pending);
  }

  private async restorePending(
    key: string,
    latest: Record<string, unknown>,
    pending: PendingPersistenceCommit
  ): Promise<SessionPersistenceCommitResult> {
    const restored = { ...latest };
    if (pending.hadPreviousState) restored[key] = pending.previousState;
    else delete restored[key];
    const rollback = await this.writeStored(key, restored, "rollback");
    return rollback.ok ? { kind: "stale" } : unavailable(rollback.failure, "unchanged");
  }

  private readStored(ownerKey: string): StorageResult<Record<string, unknown>> {
    try {
      const value = this.workspaceState?.get<unknown>(SESSION_STORAGE_KEY, undefined);
      if (value === undefined) return { ok: true, value: {} };
      if (!isPersistenceRoot(value)) {
        return {
          ok: false,
          failure: this.recordFailure(ownerKey, "read", { code: "INVALID_ROOT" })
        };
      }
      return { ok: true, value };
    } catch (error) {
      return { ok: false, failure: this.recordFailure(ownerKey, "read", error) };
    }
  }

  private async writeStored(
    ownerKey: string,
    value: Record<string, unknown>,
    kind: Exclude<SessionPersistenceFailureKind, "read">
  ): Promise<StorageResult<void>> {
    try {
      await this.workspaceState?.update(SESSION_STORAGE_KEY, value);
      return { ok: true, value: undefined };
    } catch (error) {
      return { ok: false, failure: this.recordFailure(ownerKey, kind, error) };
    }
  }

  private recordFailure(
    ownerKey: string,
    kind: SessionPersistenceFailureKind,
    error: unknown
  ): SessionPersistenceFailure {
    const previous = this.ownerStatuses.get(ownerKey);
    const firstInEpoch = previous === undefined;
    const shouldReport = firstInEpoch || !previous.reportedKinds.has(kind);
    const reportedKinds = new Set(previous?.reportedKinds);
    reportedKinds.add(kind);
    const status: OwnerPersistenceStatus = {
      degraded: true,
      epoch: previous?.epoch ?? 1,
      failureKind: kind,
      reportedKinds
    };
    this.ownerStatuses.set(ownerKey, status);
    const failure: SessionPersistenceFailure = {
      kind,
      cause: boundedFailureCause(error),
      epoch: status.epoch,
      firstInEpoch
    };
    if (shouldReport) {
      try {
        this.onPersistenceFailure?.(failure);
      } catch {
        // Diagnostics must not change live-session or persistence queue behavior.
      }
    }
    return failure;
  }

  private confirmPersistence(ownerKey: string): void {
    this.ownerStatuses.delete(ownerKey);
  }

  private releaseOwnerKey(ownerKey: string): void {
    const remaining = (this.ownerRetentionCounts.get(ownerKey) ?? 1) - 1;
    if (remaining > 0) {
      this.ownerRetentionCounts.set(ownerKey, remaining);
      return;
    }
    this.ownerRetentionCounts.delete(ownerKey);
    this.ownerStatuses.delete(ownerKey);
  }

  private bindOpeningOwner(source: SessionSource, backend: DataBackend): OpeningPersistenceOwner | undefined {
    const owner = this.openingOwner.getStore();
    if (!owner?.active || owner.source !== source) return undefined;
    this.retainOwner(owner.ownerId, source, backend);
    return owner;
  }

  private async enqueue(ownerKey: string, task: () => Promise<void>): Promise<void> {
    // Memento stores the complete persistence root, so its read-modify-write
    // transition stays serialized. Lifecycle settlement is tracked separately
    // per key so unrelated owners never wait for this global storage sequence.
    const pending = this.storageTail.catch(() => undefined).then(task);
    this.storageTail = pending.catch(() => undefined);
    const keyTail = pending.then(
      () => undefined,
      () => undefined
    );
    this.keyTaskTails.set(ownerKey, keyTail);
    void keyTail.finally(() => {
      if (this.keyTaskTails.get(ownerKey) === keyTail) this.keyTaskTails.delete(ownerKey);
    });
    await pending;
  }
}

interface OpeningPersistenceOwner {
  readonly ownerId: string;
  readonly source: SessionSource;
  active: boolean;
  readFailure?: SessionPersistenceFailure;
}

interface OwnerPersistenceStatus extends SessionPersistenceStatus {
  readonly degraded: boolean;
  readonly epoch: number;
  readonly reportedKinds: ReadonlySet<SessionPersistenceFailureKind>;
}

type StorageResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: SessionPersistenceFailure };

function unavailable(
  failure: SessionPersistenceFailure,
  liveState: "committed" | "unchanged"
): SessionPersistenceCommitResult {
  return { kind: "unavailable", failure, liveState };
}

function boundedFailureCause(error: unknown): SessionPersistenceFailureCause {
  let name = "Error";
  let code: string | undefined;
  try {
    name = safeFailureToken(error instanceof Error ? error.name : undefined, "Error", 64);
    code = isRecord(error) ? safeFailureToken(error.code, undefined, 32) : undefined;
  } catch {
    // A hostile error object must not escape the bounded generic receipt.
  }
  return { name, ...(code ? { code } : {}) };
}

function safeFailureToken(value: unknown, fallback: string, limit: number): string;
function safeFailureToken(value: unknown, fallback: undefined, limit: number): string | undefined;
function safeFailureToken(value: unknown, fallback: string | undefined, limit: number): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > limit || !/^[A-Za-z0-9_.-]+$/u.test(value)) {
    return fallback;
  }
  return value;
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

function isPersistenceRoot(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => "value" in descriptor);
}

function isPersistentSession(source: SessionSource, backend: DataBackend): boolean {
  // Saved notebook outputs are bounded value snapshots, not reopenable source
  // data. Distributed Spark and native R frames belong to one exact live
  // notebook kernel, so workspace replay must never try to reacquire them.
  return source.kind !== "notebookOutput" && backend !== "pyspark" && backend !== "r";
}
