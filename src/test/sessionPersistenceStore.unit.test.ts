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

  it("distinguishes an automatic-backend opening read fault and releases its exact owner", async () => {
    const failures = vi.fn<(failure: SessionPersistenceFailure) => void>();
    const persistence = new SessionPersistenceStore(
      mementoFrom(() => {
        throw codedError("EACCES", "cannot read /private/workspace/state.json");
      }, vi.fn()),
      failures
    );

    const first = await persistence.withOpeningOwner("opening:first", source, undefined, async () =>
      persistence.load(source, "polars")
    );

    expect(first).toEqual({
      value: undefined,
      readFailure: {
        kind: "read",
        cause: { name: "Error", code: "EACCES" },
        epoch: 1,
        firstInEpoch: true
      }
    });
    expect(persistence.ownershipCardinality()).toEqual({ retainedOwners: 1, retainedKeys: 1, degradedKeys: 1 });
    await persistence.releaseOwner("opening:first");
    expect(persistence.ownershipCardinality()).toEqual({ retainedOwners: 0, retainedKeys: 0, degradedKeys: 0 });

    const second = await persistence.withOpeningOwner("opening:second", source, undefined, async () =>
      persistence.load(source, "polars")
    );
    expect(second.readFailure).toMatchObject({ kind: "read", epoch: 1, firstInEpoch: true });
    expect(failures).toHaveBeenCalledTimes(2);
    await persistence.releaseOwner("opening:second");
    expect(persistence.ownershipCardinality()).toEqual({ retainedOwners: 0, retainedKeys: 0, degradedKeys: 0 });
  });

  it.each([
    ["null", null],
    ["array", []],
    ["primitive", 42],
    ["non-plain object", new Date(0)],
    ["accessor root", Object.defineProperty({}, "entry", { enumerable: true, get: () => ({}) })]
  ])("classifies a %s Memento root as unavailable without overwriting durable state", async (_label, root) => {
    const key = persistenceKey(source, "polars");
    let durable: Record<string, unknown> = { [key]: serializedState("polars", 7) };
    const update = vi.fn(async (_storageKey: string, value: Record<string, unknown>) => {
      durable = value;
    });
    const persistence = new SessionPersistenceStore(mementoFrom(() => root as never, update));

    const opening = await persistence.withOpeningOwner("opening:invalid-root", source, undefined, async () =>
      persistence.load(source, "polars")
    );

    expect(opening).toEqual({
      value: undefined,
      readFailure: {
        kind: "read",
        cause: { name: "Error", code: "INVALID_ROOT" },
        epoch: 1,
        firstInEpoch: true
      }
    });
    expect(update).not.toHaveBeenCalled();
    expect(durable).toEqual({ [key]: serializedState("polars", 7) });
    await persistence.releaseOwner("opening:invalid-root");
    expect(persistence.ownershipCardinality()).toEqual({ retainedOwners: 0, retainedKeys: 0, degradedKeys: 0 });
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
    await expect(persistence.commitCurrent(source, state("r", 4), () => true, commit)).resolves.toEqual({
      kind: "committed"
    });

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

  it("surfaces commit callback failure without poisoning the recovered queue tail", async () => {
    const key = persistenceKey(source, "polars");
    const previous = serializedState("polars", 1);
    let stored: Record<string, unknown> = { [key]: previous };
    const update = vi.fn(async (_storageKey: string, value: Record<string, unknown>) => {
      stored = value;
    });
    const persistence = new SessionPersistenceStore(mementoFrom(() => stored, update));
    const callbackFailure = new Error("unexpected commit callback failure");

    await expect(
      persistence.commitCurrent(
        source,
        state("polars", 2),
        () => true,
        () => {
          throw callbackFailure;
        }
      )
    ).rejects.toBe(callbackFailure);
    expect(stored[key]).toEqual(previous);
    expect(persistence.load(source, "polars")).toEqual(state("polars", 1));

    await expect(persistence.save(source, state("polars", 3))).resolves.toEqual({ kind: "committed" });
    expect(persistence.load(source, "polars")).toEqual(state("polars", 3));
  });

  it("preserves a publication failure before its persistence rollback failure", async () => {
    const key = persistenceKey(source, "polars");
    const previous = serializedState("polars", 1);
    let stored: Record<string, unknown> = { [key]: previous };
    const publicationFailure = new Error("publication callback failed");
    const rollbackFailure = new Error("persistence rollback failed");
    const update = vi.fn(async (_storageKey: string, value: Record<string, unknown>) => {
      if (update.mock.calls.length === 2) throw rollbackFailure;
      stored = value;
    });
    const persistence = new SessionPersistenceStore(mementoFrom(() => stored, update));

    const failure = await persistence
      .commitCurrent(
        source,
        state("polars", 2),
        () => true,
        () => {
          throw publicationFailure;
        }
      )
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([publicationFailure, rollbackFailure]);
    expect(stored[key]).toHaveProperty("pendingCurrentCommit");
    expect(persistence.load(source, "polars")).toEqual(state("polars", 1));
  });

  it("surfaces rollback callback failure after restoring live and durable state", async () => {
    const key = persistenceKey(source, "polars");
    const previous = serializedState("polars", 1);
    let stored: Record<string, unknown> = { [key]: previous };
    const update = vi.fn(async (_storageKey: string, value: Record<string, unknown>) => {
      if (update.mock.calls.length === 2) throw new Error("final storage unavailable");
      stored = value;
    });
    const persistence = new SessionPersistenceStore(mementoFrom(() => stored, update));
    const rollbackFailure = new Error("unexpected rollback callback failure");
    let live = "previous";

    const failure = await persistence
      .commitRuntimeReplacement(
        source,
        state("polars", 2),
        () => true,
        () => {
          live = "candidate";
          return () => {
            live = "previous";
            throw rollbackFailure;
          };
        }
      )
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({ message: "final storage unavailable" }),
      rollbackFailure
    ]);

    expect(live).toBe("previous");
    expect(stored[key]).toHaveProperty("pendingRuntimeReplacement");
    expect(persistence.load(source, "polars")).toEqual(state("polars", 1));
    await expect(persistence.save(source, state("polars", 3))).resolves.toEqual({ kind: "committed" });
    expect(persistence.load(source, "polars")).toEqual(state("polars", 3));
  });

  it("rejects a stale queued commit before it writes or publishes", async () => {
    const memory = memento();
    const persistence = new SessionPersistenceStore(memory.value);
    const commit = vi.fn();

    await expect(persistence.commitCurrent(source, state("polars", 1), () => false, commit)).resolves.toEqual({
      kind: "stale"
    });

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
    await expect(pending).resolves.toEqual({ kind: "committed" });

    expect(commit).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledTimes(2);
    expect(new SessionPersistenceStore(mementoFrom(() => stored, update)).load(source, "polars")).toEqual(
      state("polars", 2)
    );
  });

  it("stages an in-place mutation before dispatch ownership and restores it when dispatch aborts", async () => {
    const key = persistenceKey(source, "polars");
    const previous = serializedState("polars", 1);
    let stored: Record<string, unknown> = { [key]: previous };
    const update = vi.fn(async (_storageKey: string, value: Record<string, unknown>) => {
      stored = value;
    });
    const persistence = new SessionPersistenceStore(mementoFrom(() => stored, update));

    const staged = await persistence.stageCurrent(source, state("polars", 1));
    expect(staged.kind).toBe("staged");
    expect(stored[key]).toHaveProperty("pendingCurrentCommit");
    if (staged.kind !== "staged") throw new Error("Expected a staged persistence transaction.");

    await expect(persistence.restoreStagedCurrent(staged.transaction)).resolves.toEqual({ kind: "stale" });
    expect(stored[key]).toEqual(previous);
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("does not let a failed final write roll back a reentrant newer owner", async () => {
    const key = persistenceKey(source, "polars");
    const previous = serializedState("polars", 1);
    let stored: Record<string, unknown> = { [key]: previous };
    let liveOwner = "previous";
    const update = vi.fn(async (_storageKey: string, value: Record<string, unknown>) => {
      if (update.mock.calls.length === 2) {
        liveOwner = "newer";
        throw new Error("final storage unavailable");
      }
      stored = value;
    });
    const persistence = new SessionPersistenceStore(mementoFrom(() => stored, update));

    await expect(
      persistence.commitCurrent(
        source,
        state("polars", 2),
        () => true,
        () => {
          liveOwner = "candidate";
          return () => {
            if (liveOwner !== "candidate") return false;
            liveOwner = "previous";
            return true;
          };
        }
      )
    ).resolves.toMatchObject({ kind: "unavailable", liveState: "committed" });

    expect(liveOwner).toBe("newer");
    expect(stored[key]).toHaveProperty("pendingCurrentCommit");
    expect(persistence.load(source, "polars")).toEqual(state("polars", 1));
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

    await expect(pending).resolves.toEqual({ kind: "stale" });
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

    await expect(pending).resolves.toEqual({ kind: "stale" });
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

    await expect(pending).resolves.toMatchObject({
      kind: "unavailable",
      failure: { kind: "rollback" },
      liveState: "unchanged"
    });
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
      { kind: "save", cause: { name: "Error" }, epoch: 1, firstInEpoch: true },
      { kind: "rollback", cause: { name: "Error" }, epoch: 1, firstInEpoch: false }
    ]);
  });

  it("does not recover failed snapshot A when stale candidate B rolls back successfully", async () => {
    const key = persistenceKey(source, "polars");
    const previous = serializedState("polars", 0);
    let stored: Record<string, unknown> = { [key]: previous };
    const staged = deferred<void>();
    const update = vi.fn(async (_storageKey: string, value: Record<string, unknown>) => {
      if (update.mock.calls.length === 1) throw new Error("snapshot A save failed");
      stored = value;
      if (update.mock.calls.length === 2) await staged.promise;
    });
    const failures = vi.fn<(failure: SessionPersistenceFailure) => void>();
    const persistence = new SessionPersistenceStore(
      mementoFrom(() => stored, update),
      failures
    );
    let current = true;

    await persistence.save(source, state("polars", 1));
    const candidateB = persistence.commitCurrent(source, state("polars", 2), () => current, vi.fn());
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    current = false;
    staged.resolve();

    await expect(candidateB).resolves.toEqual({ kind: "stale" });
    expect(update).toHaveBeenCalledTimes(3);
    expect(stored[key]).toEqual(previous);
    expect(persistence.status(source, "polars")).toEqual({ degraded: true, epoch: 1, failureKind: "save" });
    expect(failureReceipts(failures)).toEqual([
      { kind: "save", cause: { name: "Error" }, epoch: 1, firstInEpoch: true }
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

    await expect(pending).resolves.toMatchObject({
      kind: "unavailable",
      failure: { kind: "rollback" },
      liveState: "unchanged"
    });
    expect(update).toHaveBeenCalledTimes(2);
    expect(commit).not.toHaveBeenCalled();
    expect(persistence.load(source, "polars")).toEqual(state("polars", 1));
    expect(stored[key]).toHaveProperty("pendingRuntimeReplacement");
    expect(stored.unrelated).toBe("keep");
    expect(persistence.status(source, "polars")).toEqual({ degraded: true, epoch: 1, failureKind: "rollback" });
    expect(failureReceipts(failures)).toEqual([
      { kind: "rollback", cause: { name: "Error" }, epoch: 1, firstInEpoch: true }
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

    await expect(
      persistence.commitRuntimeReplacement(source, state("polars", 2), () => true, commit)
    ).resolves.toMatchObject({
      kind: "unavailable",
      failure: { kind: "runtime-replacement" },
      liveState: "unchanged"
    });

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
      { kind: "runtime-replacement", cause: { name: "Error" }, epoch: 1, firstInEpoch: true }
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

    await expect(
      persistence.commitRuntimeReplacement(source, state("polars", 2), () => true, commit)
    ).resolves.toMatchObject({
      kind: "unavailable",
      failure: { kind: "read" },
      liveState: "unchanged"
    });

    expect(commit).toHaveBeenCalledOnce();
    expect(rollback).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledOnce();
    expect(stored[key]).toHaveProperty("pendingRuntimeReplacement");
    expect(new SessionPersistenceStore(workspaceState).load(source, "polars")).toEqual(state("polars", 1));
    expect(persistence.status(source, "polars")).toEqual({ degraded: true, epoch: 1, failureKind: "read" });
    expect(failureReceipts(failures)).toEqual([
      { kind: "read", cause: { name: "Error" }, epoch: 1, firstInEpoch: true }
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
    expect(persistence.status(source, "polars")).toEqual({ degraded: false, epoch: 0 });
    expect(new SessionPersistenceStore(workspaceState).load(source, "polars")).toEqual(state("polars", 2));
    expect(failureReceipts(failures)).toEqual([
      { kind: "read", cause: { name: "Error" }, epoch: 1, firstInEpoch: true }
    ]);
  });

  it("returns typed read failures while preserving current-page and replacement ownership", async () => {
    const workspaceState = mementoFrom(() => {
      throw codedError("EACCES", "cannot read /private/workspace/state.json");
    }, vi.fn());
    const failures = vi.fn<(failure: SessionPersistenceFailure) => void>();
    const persistence = new SessionPersistenceStore(workspaceState, failures);
    const pageCommit = vi.fn();
    const replacementCommit = vi.fn(() => vi.fn());

    await expect(persistence.commitCurrent(source, state("polars", 1), () => true, pageCommit)).resolves.toEqual({
      kind: "unavailable",
      failure: {
        kind: "read",
        cause: { name: "Error", code: "EACCES" },
        epoch: 1,
        firstInEpoch: true
      },
      liveState: "unchanged"
    });
    await expect(
      persistence.commitRuntimeReplacement(source, state("polars", 2), () => true, replacementCommit)
    ).resolves.toMatchObject({
      kind: "unavailable",
      failure: { kind: "read", cause: { name: "Error", code: "EACCES" }, firstInEpoch: false },
      liveState: "unchanged"
    });

    expect(pageCommit).not.toHaveBeenCalled();
    expect(replacementCommit).not.toHaveBeenCalled();
    expect(failureReceipts(failures)).toEqual([
      { kind: "read", cause: { name: "Error", code: "EACCES" }, epoch: 1, firstInEpoch: true }
    ]);
    expect(JSON.stringify(failureReceipts(failures))).not.toContain("/private/workspace");
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
    expect(persistence.status(source, "polars")).toEqual({ degraded: false, epoch: 0 });
    expect(new SessionPersistenceStore(mementoFrom(() => stored, update)).load(otherSource, "polars")).toEqual(
      state("polars", 2)
    );
  });

  it("bounds retained and degraded owner state across recovery and exact release", async () => {
    const otherSource: SessionSource = { ...source, path: "/workspace/other.csv" };
    let stored: Record<string, unknown> = {};
    let writesFail = true;
    const update = vi.fn(async (_storageKey: string, value: Record<string, unknown>) => {
      if (writesFail) throw new Error("storage unavailable");
      stored = value;
    });
    const failures = vi.fn<(failure: SessionPersistenceFailure) => void>();
    const persistence = new SessionPersistenceStore(
      mementoFrom(() => stored, update),
      failures
    );
    persistence.retainOwner("session-a", source, "polars");
    persistence.retainOwner("session-b", otherSource, "polars");

    await persistence.save(source, state("polars", 1));
    await persistence.save(otherSource, state("polars", 2));
    expect(persistence.ownershipCardinality()).toEqual({ retainedOwners: 2, retainedKeys: 2, degradedKeys: 2 });
    expect(failures).toHaveBeenCalledTimes(2);

    persistence.releaseOwner("session-a");
    expect(persistence.status(source, "polars")).toEqual({ degraded: false, epoch: 0 });
    expect(persistence.status(otherSource, "polars")).toEqual({ degraded: true, epoch: 1, failureKind: "save" });
    expect(persistence.ownershipCardinality()).toEqual({ retainedOwners: 1, retainedKeys: 1, degradedKeys: 1 });

    writesFail = false;
    await persistence.save(otherSource, state("polars", 3));
    expect(persistence.ownershipCardinality()).toEqual({ retainedOwners: 1, retainedKeys: 1, degradedKeys: 0 });

    persistence.releaseOwner("session-b");
    expect(persistence.ownershipCardinality()).toEqual({ retainedOwners: 0, retainedKeys: 0, degradedKeys: 0 });
  });

  it("does not accumulate lifecycle state across many failed, closed owners", async () => {
    const persistence = new SessionPersistenceStore(
      mementoFrom(
        () => ({}),
        vi.fn(async () => {
          throw new Error("storage unavailable");
        })
      )
    );

    for (let index = 0; index < 128; index += 1) {
      const ownerSource: SessionSource = { ...source, path: `/workspace/session-${index}.csv` };
      const ownerId = `session-${index}`;
      persistence.retainOwner(ownerId, ownerSource, "polars");
      await persistence.save(ownerSource, state("polars", index));
      persistence.releaseOwner(ownerId);
    }

    expect(persistence.ownershipCardinality()).toEqual({ retainedOwners: 0, retainedKeys: 0, degradedKeys: 0 });
  });

  it("releases degradation after an in-flight owner write settles", async () => {
    const write = rejectingDeferred<void>();
    const update = vi.fn(() => write.promise);
    const persistence = new SessionPersistenceStore(mementoFrom(() => ({}), update));
    persistence.retainOwner("closing-session", source, "polars");

    const save = persistence.save(source, state("polars", 1));
    await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
    persistence.releaseOwner("closing-session");
    write.reject(new Error("storage unavailable during close"));
    await save;

    await vi.waitFor(() =>
      expect(persistence.ownershipCardinality()).toEqual({ retainedOwners: 0, retainedKeys: 0, degradedKeys: 0 })
    );
    expect(persistence.status(source, "polars")).toEqual({ degraded: false, epoch: 0 });
  });

  it("releases an unrelated opening owner while another key write never settles", async () => {
    const otherSource: SessionSource = { ...source, path: "/workspace/other.csv" };
    const neverSettles = new Promise<void>(() => undefined);
    const update = vi.fn(() => neverSettles);
    const persistence = new SessionPersistenceStore(mementoFrom(() => ({}), update));
    persistence.retainOwner("session-a", source, "polars");

    void persistence.save(source, state("polars", 1));
    await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
    const opening = await persistence.withOpeningOwner("opening:b", otherSource, undefined, async () =>
      persistence.load(otherSource, "polars")
    );
    expect(opening).toEqual({ value: undefined });

    await expect(persistence.releaseOwner("opening:b")).resolves.toBeUndefined();
    expect(persistence.ownershipCardinality()).toEqual({ retainedOwners: 1, retainedKeys: 1, degradedKeys: 0 });

    let stalledOwnerReleased = false;
    void persistence.releaseOwner("session-a").then(() => {
      stalledOwnerReleased = true;
    });
    await Promise.resolve();
    expect(stalledOwnerReleased).toBe(false);
    expect(persistence.ownershipCardinality()).toEqual({ retainedOwners: 0, retainedKeys: 1, degradedKeys: 0 });
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

    await expect(persistence.commitCurrent(source, state("polars", 1), () => true, commit)).resolves.toMatchObject({
      kind: "unavailable",
      failure: { kind: "save" },
      liveState: "unchanged"
    });
    await expect(persistence.save(source, state("polars", 2))).resolves.toMatchObject({ kind: "unavailable" });
    expect(persistence.status(source, "polars")).toEqual({ degraded: true, epoch: 1, failureKind: "save" });
    expect(new SessionPersistenceStore(workspaceState).load(source, "polars")).toBeUndefined();

    await expect(persistence.save(source, state("polars", 3))).resolves.toEqual({ kind: "committed" });
    expect(persistence.status(source, "polars")).toEqual({ degraded: false, epoch: 0 });
    expect(new SessionPersistenceStore(workspaceState).load(source, "polars")).toEqual(state("polars", 3));

    await expect(persistence.save(source, state("polars", 4))).resolves.toMatchObject({ kind: "unavailable" });

    expect(commit).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(4);
    expect(stored[persistenceKey(source, "polars")]).toEqual(serializedState("polars", 3));
    expect(persistence.status(source, "polars")).toEqual({ degraded: true, epoch: 1, failureKind: "save" });
    expect(failureReceipts(failures)).toEqual([
      { kind: "save", cause: { name: "Error" }, epoch: 1, firstInEpoch: true },
      { kind: "save", cause: { name: "Error" }, epoch: 1, firstInEpoch: true }
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

function rejectingDeferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function failureReceipts(failures: ReturnType<typeof vi.fn<(failure: SessionPersistenceFailure) => void>>): Array<{
  kind: SessionPersistenceFailure["kind"];
  cause: SessionPersistenceFailure["cause"];
  epoch: number;
  firstInEpoch: boolean;
}> {
  return failures.mock.calls.map(([failure]) => ({
    kind: failure.kind,
    cause: failure.cause,
    epoch: failure.epoch,
    firstInEpoch: failure.firstInEpoch
  }));
}
