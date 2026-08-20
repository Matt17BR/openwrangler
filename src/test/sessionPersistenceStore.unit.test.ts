import { describe, expect, it, vi } from "vitest";
import type { Memento } from "vscode";
import type { DataBackend, SessionSource } from "../shared/protocol";
import {
  persistenceKey,
  serializePersistedSession,
  SESSION_STORAGE_KEY,
  type PersistedSessionState
} from "../extension/sessionPersistence";
import { type SessionPersistenceFailure, SessionPersistenceStore } from "../extension/sessionPersistenceStore";

const source: SessionSource = { kind: "file", label: "sample.csv", path: "/workspace/sample.csv" };

describe("SessionPersistenceStore", () => {
  it("loads only decoded state for the exact source and backend", () => {
    const key = persistenceKey(source, "polars");
    let stored: Record<string, unknown> = { [key]: serializedState("pandas", 1) };
    const memory = memento(
      () => stored,
      (value) => {
        stored = value;
      }
    );
    const persistence = new SessionPersistenceStore(memory.value);

    expect(persistence.load(source, "polars")).toBeUndefined();
    stored = { [key]: serializedState("polars", 2) };
    expect(persistence.load(source, "polars")).toEqual(state("polars", 2));
    expect(persistence.load(source, "duckdb")).toBeUndefined();
  });

  it("keeps notebook-output, native R, and Spark state ephemeral", async () => {
    const snapshotSource: SessionSource = { kind: "notebookOutput", label: "capture" };
    const stored = {
      [persistenceKey(snapshotSource, "polars")]: serializedState("polars", 1),
      [persistenceKey(source, "r")]: state("r", 2),
      [persistenceKey(source, "pyspark")]: state("pyspark", 3)
    };
    const memory = memento(() => stored);
    const persistence = new SessionPersistenceStore(memory.value);
    const commit = vi.fn();

    expect(persistence.load(snapshotSource, "polars")).toBeUndefined();
    expect(persistence.load(source, "r")).toBeUndefined();
    expect(persistence.load(source, "pyspark")).toBeUndefined();

    await persistence.save(snapshotSource, state("polars", 1));
    await persistence.save(source, state("r", 2));
    await persistence.save(source, state("pyspark", 3));
    await expect(persistence.commitCurrent(source, state("r", 4), () => true, commit)).resolves.toBe(true);

    expect(memory.update).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledOnce();
  });

  it("serializes writes and bases each update on the latest stored state", async () => {
    let stored: Record<string, unknown> = {};
    const firstUpdate = deferred<void>();
    const update = vi.fn(async (_key: string, value: Record<string, unknown>) => {
      stored = value;
      if (update.mock.calls.length === 1) await firstUpdate.promise;
    });
    const workspaceState = mementoFrom(() => stored, update);
    const persistence = new SessionPersistenceStore(workspaceState);
    const secondSource: SessionSource = { ...source, path: "/workspace/second.csv" };

    const first = persistence.save(source, state("polars", 1));
    await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
    const second = persistence.save(secondSource, state("duckdb", 2));
    await Promise.resolve();
    expect(update).toHaveBeenCalledOnce();
    firstUpdate.resolve();
    await Promise.all([first, second]);

    expect(update).toHaveBeenCalledTimes(2);
    expect(stored).toEqual({
      [persistenceKey(source, "polars")]: serializedState("polars", 1),
      [persistenceKey(secondSource, "duckdb")]: serializedState("duckdb", 2)
    });
  });

  it("rejects a stale queued commit before it writes or publishes", async () => {
    const memory = memento();
    const persistence = new SessionPersistenceStore(memory.value);
    const commit = vi.fn();

    await expect(persistence.commitCurrent(source, state("polars", 1), () => false, commit)).resolves.toBe(false);

    expect(memory.update).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it("publishes a current page only after its pending record is durable", async () => {
    let stored: Record<string, unknown> = {};
    const staged = deferred<void>();
    const update = vi.fn(async (_storageKey: string, value: Record<string, unknown>) => {
      stored = value;
      if (update.mock.calls.length === 1) await staged.promise;
    });
    const persistence = new SessionPersistenceStore(mementoFrom(() => stored, update));
    const commit = vi.fn();

    const pending = persistence.commitCurrent(source, state("polars", 2), () => true, commit);
    await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
    expect(commit).not.toHaveBeenCalled();
    expect(stored[persistenceKey(source, "polars")]).toHaveProperty("pendingCurrentCommit");

    staged.resolve();
    await expect(pending).resolves.toBe(true);

    expect(commit).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledTimes(2);
    expect(new SessionPersistenceStore(mementoFrom(() => stored, update)).load(source, "polars")).toEqual(
      state("polars", 2)
    );
  });

  it("restores the previous exact entry when a page becomes stale during its write", async () => {
    const key = persistenceKey(source, "polars");
    const previous = serializedState("polars", 1);
    let stored: Record<string, unknown> = { [key]: previous, unrelated: "keep" };
    const firstUpdate = deferred<void>();
    const update = vi.fn(async (_storageKey: string, value: Record<string, unknown>) => {
      stored = value;
      if (update.mock.calls.length === 1) await firstUpdate.promise;
    });
    const persistence = new SessionPersistenceStore(mementoFrom(() => stored, update));
    const commit = vi.fn();
    let current = true;

    const pending = persistence.commitCurrent(source, state("polars", 2), () => current, commit);
    await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
    current = false;
    firstUpdate.resolve();

    await expect(pending).resolves.toBe(false);
    expect(update).toHaveBeenCalledTimes(2);
    expect(stored).toEqual({ [key]: previous, unrelated: "keep" });
    expect(commit).not.toHaveBeenCalled();
  });

  it("deletes a newly introduced entry when a page becomes stale during its write", async () => {
    let stored: Record<string, unknown> = { unrelated: "keep" };
    const firstUpdate = deferred<void>();
    const update = vi.fn(async (_storageKey: string, value: Record<string, unknown>) => {
      stored = value;
      if (update.mock.calls.length === 1) await firstUpdate.promise;
    });
    const persistence = new SessionPersistenceStore(mementoFrom(() => stored, update));
    let current = true;

    const pending = persistence.commitCurrent(source, state("polars", 2), () => current, vi.fn());
    await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
    current = false;
    firstUpdate.resolve();

    await expect(pending).resolves.toBe(false);
    expect(stored).toEqual({ unrelated: "keep" });
  });

  it("keeps the last durable value hidden behind a pending page after save and rollback failures", async () => {
    const key = persistenceKey(source, "polars");
    const previous = serializedState("polars", 1);
    let stored: Record<string, unknown> = { [key]: previous, unrelated: "keep" };
    const staged = deferred<void>();
    const update = vi.fn(async (_storageKey: string, value: Record<string, unknown>) => {
      const attempt = update.mock.calls.length;
      if (attempt === 1) throw new Error("ordinary storage unavailable");
      if (attempt === 3) throw new Error("rollback storage unavailable");
      stored = value;
      await staged.promise;
    });
    const failures = vi.fn<(failure: SessionPersistenceFailure) => void>();
    const workspaceState = mementoFrom(() => stored, update);
    const persistence = new SessionPersistenceStore(workspaceState, failures);
    let current = true;

    await persistence.save(source, state("polars", 2));
    const pending = persistence.commitCurrent(source, state("polars", 3), () => current, vi.fn());
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    current = false;
    staged.resolve();

    await expect(pending).resolves.toBe(false);
    expect(update).toHaveBeenCalledTimes(3);
    expect(stored[key]).toHaveProperty("pendingCurrentCommit");
    expect(stored.unrelated).toBe("keep");
    expect(new SessionPersistenceStore(workspaceState).load(source, "polars")).toEqual(state("polars", 1));
    expect(persistence.status(source, "polars")).toEqual({
      degraded: true,
      epoch: 1,
      failureKind: "rollback"
    });
    expect(failureReceipts(failures)).toEqual([
      { kind: "save", message: "ordinary storage unavailable", epoch: 1, firstInEpoch: true },
      { kind: "rollback", message: "rollback storage unavailable", epoch: 1, firstInEpoch: false }
    ]);
  });

  it("never reloads an unpublished runtime candidate when stale rollback storage fails", async () => {
    const key = persistenceKey(source, "polars");
    const previous = serializedState("polars", 1);
    let stored: Record<string, unknown> = { [key]: previous, unrelated: "keep" };
    const staged = deferred<void>();
    const update = vi.fn(async (_storageKey: string, value: Record<string, unknown>) => {
      if (update.mock.calls.length > 1) throw new Error("rollback storage unavailable");
      stored = value;
      await staged.promise;
    });
    const failures = vi.fn<(failure: SessionPersistenceFailure) => void>();
    const persistence = new SessionPersistenceStore(
      mementoFrom(() => stored, update),
      failures
    );
    const commit = vi.fn(() => vi.fn());
    let current = true;

    const pending = persistence.commitRuntimeReplacement(source, state("polars", 2), () => current, commit);
    await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
    current = false;
    staged.resolve();

    await expect(pending).resolves.toBe(false);
    expect(update).toHaveBeenCalledTimes(2);
    expect(commit).not.toHaveBeenCalled();
    expect(persistence.load(source, "polars")).toEqual(state("polars", 1));
    expect(stored[key]).toHaveProperty("pendingRuntimeReplacement");
    expect(stored.unrelated).toBe("keep");
    expect(persistence.status(source, "polars")).toEqual({ degraded: true, epoch: 1, failureKind: "rollback" });
    expect(failureReceipts(failures)).toEqual([
      { kind: "rollback", message: "rollback storage unavailable", epoch: 1, firstInEpoch: true }
    ]);
  });

  it("restores live state when final runtime replacement persistence fails", async () => {
    const key = persistenceKey(source, "polars");
    const previous = serializedState("polars", 1);
    let stored: Record<string, unknown> = { [key]: previous, unrelated: "keep" };
    const update = vi.fn(async (_storageKey: string, value: Record<string, unknown>) => {
      if (update.mock.calls.length === 2) throw new Error("final storage unavailable");
      stored = value;
    });
    const failures = vi.fn<(failure: SessionPersistenceFailure) => void>();
    const persistence = new SessionPersistenceStore(
      mementoFrom(() => stored, update),
      failures
    );
    const rollback = vi.fn();
    const commit = vi.fn(() => rollback);

    await expect(persistence.commitRuntimeReplacement(source, state("polars", 2), () => true, commit)).resolves.toBe(
      false
    );

    expect(commit).toHaveBeenCalledOnce();
    expect(rollback).toHaveBeenCalledOnce();
    expect(persistence.load(source, "polars")).toEqual(state("polars", 1));
    expect(stored[key]).toHaveProperty("pendingRuntimeReplacement");
    expect(stored.unrelated).toBe("keep");
    expect(persistence.status(source, "polars")).toEqual({
      degraded: true,
      epoch: 1,
      failureKind: "runtime-replacement"
    });
    expect(failureReceipts(failures)).toEqual([
      { kind: "runtime-replacement", message: "final storage unavailable", epoch: 1, firstInEpoch: true }
    ]);
  });

  it("restores live state and retains the durable value when a post-swap read fails", async () => {
    const key = persistenceKey(source, "polars");
    const previous = serializedState("polars", 1);
    let stored: Record<string, unknown> = { [key]: previous, unrelated: "keep" };
    let reads = 0;
    const update = vi.fn(async (_storageKey: string, value: Record<string, unknown>) => {
      stored = value;
    });
    const workspaceState = mementoFrom(() => {
      reads += 1;
      if (reads === 2) throw new Error("workspace read unavailable");
      return stored;
    }, update);
    const failures = vi.fn<(failure: SessionPersistenceFailure) => void>();
    const persistence = new SessionPersistenceStore(workspaceState, failures);
    const rollback = vi.fn();
    const commit = vi.fn(() => rollback);

    await expect(persistence.commitRuntimeReplacement(source, state("polars", 2), () => true, commit)).resolves.toBe(
      false
    );

    expect(commit).toHaveBeenCalledOnce();
    expect(rollback).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledOnce();
    expect(stored[key]).toHaveProperty("pendingRuntimeReplacement");
    expect(new SessionPersistenceStore(workspaceState).load(source, "polars")).toEqual(state("polars", 1));
    expect(persistence.status(source, "polars")).toEqual({ degraded: true, epoch: 1, failureKind: "read" });
    expect(failureReceipts(failures)).toEqual([
      { kind: "read", message: "workspace read unavailable", epoch: 1, firstInEpoch: true }
    ]);
  });

  it("classifies availability reads separately and recovers only after a confirmed write", async () => {
    let readsFail = true;
    let stored: Record<string, unknown> = {};
    const update = vi.fn(async (_storageKey: string, value: Record<string, unknown>) => {
      stored = value;
    });
    const workspaceState = mementoFrom(() => {
      if (readsFail) throw new Error("workspace read unavailable");
      return stored;
    }, update);
    const failures = vi.fn<(failure: SessionPersistenceFailure) => void>();
    const persistence = new SessionPersistenceStore(workspaceState, failures);

    expect(persistence.load(source, "polars")).toBeUndefined();
    expect(persistence.status(source, "polars")).toEqual({ degraded: true, epoch: 1, failureKind: "read" });

    readsFail = false;
    expect(persistence.load(source, "polars")).toBeUndefined();
    expect(persistence.status(source, "polars")).toEqual({ degraded: true, epoch: 1, failureKind: "read" });

    await persistence.save(source, state("polars", 2));
    expect(persistence.status(source, "polars")).toEqual({ degraded: false, epoch: 1 });
    expect(new SessionPersistenceStore(workspaceState).load(source, "polars")).toEqual(state("polars", 2));
    expect(failureReceipts(failures)).toEqual([
      { kind: "read", message: "workspace read unavailable", epoch: 1, firstInEpoch: true }
    ]);
  });

  it("does not clear one persistence owner when another owner writes successfully", async () => {
    const otherSource: SessionSource = { ...source, path: "/workspace/other.csv" };
    const sourceKey = persistenceKey(source, "polars");
    let stored: Record<string, unknown> = {};
    let failSource = true;
    const update = vi.fn(async (_storageKey: string, value: Record<string, unknown>) => {
      if (failSource && Object.prototype.hasOwnProperty.call(value, sourceKey)) {
        failSource = false;
        throw new Error("source storage unavailable");
      }
      stored = value;
    });
    const persistence = new SessionPersistenceStore(mementoFrom(() => stored, update));

    await persistence.save(source, state("polars", 1));
    await persistence.save(otherSource, state("polars", 2));

    expect(persistence.status(source, "polars")).toEqual({ degraded: true, epoch: 1, failureKind: "save" });
    expect(persistence.status(otherSource, "polars")).toEqual({ degraded: false, epoch: 0 });

    await persistence.save(source, state("polars", 3));
    expect(persistence.status(source, "polars")).toEqual({ degraded: false, epoch: 1 });
    expect(new SessionPersistenceStore(mementoFrom(() => stored, update)).load(otherSource, "polars")).toEqual(
      state("polars", 2)
    );
  });

  it("reports one degraded epoch until a confirmed save recovers restart state", async () => {
    let stored: Record<string, unknown> = {};
    const update = vi.fn(async (_storageKey: string, value: Record<string, unknown>) => {
      if (update.mock.calls.length === 1) throw new Error("first storage unavailable");
      if (update.mock.calls.length === 2) throw new Error("second storage unavailable");
      if (update.mock.calls.length === 4) throw new Error("later storage unavailable");
      stored = value;
    });
    const workspaceState = mementoFrom(() => stored, update);
    const failures = vi.fn<(failure: SessionPersistenceFailure) => void>();
    const persistence = new SessionPersistenceStore(workspaceState, failures);
    const commit = vi.fn();

    await expect(persistence.commitCurrent(source, state("polars", 1), () => true, commit)).resolves.toBe(true);
    await expect(persistence.save(source, state("polars", 2))).resolves.toBeUndefined();
    expect(persistence.status(source, "polars")).toEqual({ degraded: true, epoch: 1, failureKind: "save" });
    expect(new SessionPersistenceStore(workspaceState).load(source, "polars")).toBeUndefined();

    await expect(persistence.save(source, state("polars", 3))).resolves.toBeUndefined();
    expect(persistence.status(source, "polars")).toEqual({ degraded: false, epoch: 1 });
    expect(new SessionPersistenceStore(workspaceState).load(source, "polars")).toEqual(state("polars", 3));

    await expect(persistence.save(source, state("polars", 4))).resolves.toBeUndefined();

    expect(commit).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledTimes(4);
    expect(stored[persistenceKey(source, "polars")]).toEqual(serializedState("polars", 3));
    expect(persistence.status(source, "polars")).toEqual({ degraded: true, epoch: 2, failureKind: "save" });
    expect(failureReceipts(failures)).toEqual([
      { kind: "save", message: "first storage unavailable", epoch: 1, firstInEpoch: true },
      { kind: "save", message: "second storage unavailable", epoch: 1, firstInEpoch: false },
      { kind: "save", message: "later storage unavailable", epoch: 2, firstInEpoch: true }
    ]);
  });
});

function state(backend: DataBackend, firstVisibleRow: number): PersistedSessionState {
  return {
    backend,
    cleaning: { steps: [] },
    view: {
      filterModel: { filters: [], sort: [] },
      columnWidths: new Map(),
      viewport: { firstVisibleRow, scrollLeft: 0 }
    }
  };
}

function serializedState(backend: Extract<DataBackend, "pandas" | "polars" | "duckdb">, firstVisibleRow: number) {
  const serialized = serializePersistedSession(state(backend, firstVisibleRow));
  if (!serialized) throw new Error("Expected test state to serialize.");
  return serialized;
}

function memento(
  read: () => Record<string, unknown> = () => ({}),
  write: (value: Record<string, unknown>) => void = () => undefined
): { value: Memento; update: ReturnType<typeof vi.fn> } {
  const update = vi.fn(async (_key: string, value: Record<string, unknown>) => write(value));
  return { value: mementoFrom(read, update), update };
}

function mementoFrom(
  read: () => Record<string, unknown>,
  update: (key: string, value: Record<string, unknown>) => Promise<void>
): Memento {
  return {
    get: vi.fn((key: string, fallback?: unknown) => (key === SESSION_STORAGE_KEY ? read() : fallback)),
    update,
    keys: vi.fn(() => [SESSION_STORAGE_KEY])
  } as unknown as Memento;
}

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function failureReceipts(failures: ReturnType<typeof vi.fn<(failure: SessionPersistenceFailure) => void>>): Array<{
  kind: SessionPersistenceFailure["kind"];
  message: string;
  epoch: number;
  firstInEpoch: boolean;
}> {
  return failures.mock.calls.map(([failure]) => ({
    kind: failure.kind,
    message: failure.error instanceof Error ? failure.error.message : String(failure.error),
    epoch: failure.epoch,
    firstInEpoch: failure.firstInEpoch
  }));
}
