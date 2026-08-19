import { describe, expect, it, vi } from "vitest";
import type { Memento } from "vscode";
import type { DataBackend, SessionSource } from "../shared/protocol";
import {
  persistenceKey,
  serializePersistedSession,
  SESSION_STORAGE_KEY,
  type PersistedSessionState
} from "../extension/sessionPersistence";
import { SessionPersistenceStore } from "../extension/sessionPersistenceStore";

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
    const persistence = new SessionPersistenceStore(mementoFrom(() => stored, update));
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
  });

  it("restores live state when final runtime replacement persistence fails", async () => {
    const key = persistenceKey(source, "polars");
    const previous = serializedState("polars", 1);
    let stored: Record<string, unknown> = { [key]: previous, unrelated: "keep" };
    const update = vi.fn(async (_storageKey: string, value: Record<string, unknown>) => {
      if (update.mock.calls.length === 2) throw new Error("final storage unavailable");
      stored = value;
    });
    const persistence = new SessionPersistenceStore(mementoFrom(() => stored, update));
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
  });

  it("publishes current live state after a best-effort write failure and keeps the queue usable", async () => {
    let stored: Record<string, unknown> = {};
    const update = vi.fn(async (_storageKey: string, value: Record<string, unknown>) => {
      if (update.mock.calls.length === 1) throw new Error("storage unavailable");
      stored = value;
    });
    const persistence = new SessionPersistenceStore(mementoFrom(() => stored, update));
    const commit = vi.fn();

    await expect(persistence.commitCurrent(source, state("polars", 1), () => true, commit)).resolves.toBe(true);
    await expect(persistence.save(source, state("polars", 2))).resolves.toBeUndefined();

    expect(commit).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledTimes(2);
    expect(stored[persistenceKey(source, "polars")]).toEqual(serializedState("polars", 2));
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
