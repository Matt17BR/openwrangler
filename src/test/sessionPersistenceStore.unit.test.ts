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
  it("commits one R library's current state without changing another library's saved work", async () => {
    let stored: Record<string, unknown> = {};
    const memory = memento(
      () => stored,
      (value) => {
        stored = value;
      }
    );
    const persistence = new SessionPersistenceStore(memory.value);
    const base = state("r", 2);
    const collapse = { ...state("r", 8), rLibrary: "collapse" as const };
    await persistence.save(source, "r", () => base, "base");
    await persistence.save(source, "r", () => collapse, "collapse");
    const original = structuredClone(stored[persistenceKey(source, "r")]);
    await expect(
      persistence.commitCurrent(
        source,
        () => ({ ...collapse, view: { ...collapse.view, viewport: { firstVisibleRow: 12, scrollLeft: 40 } } }),
        () => true,
        () => undefined
      )
    ).resolves.toEqual({ kind: "committed" });
    expect(stored[persistenceKey(source, "r")]).toEqual(original);
    expect(persistence.load(source, "r", "collapse")).toMatchObject({
      rLibrary: "collapse",
      view: { viewport: { firstVisibleRow: 12, scrollLeft: 40 } }
    });
    expect(persistence.checkAbsent(source, "r", "dplyr")).toEqual({ kind: "absent" });
    expect(persistence.load(source, "r", "dplyr")).toBeUndefined();
  });
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["malformed", 42],
    ["view-only", serializedState("polars", 3)],
    [
      "pending current",
      { pendingCurrentCommit: { token: "held", candidate: serializedState("polars", 3), hadPreviousState: false } }
    ],
    [
      "pending replacement",
      { pendingRuntimeReplacement: { token: "held", candidate: serializedState("polars", 3), hadPreviousState: false } }
    ]
  ])("require-absent replacement refuses an own %s target entry without writing", async (_label, entry) => {
    const key = persistenceKey(source, "polars");
    let stored: Record<string, unknown> = { [key]: entry, unrelated: "keep" };
    const memory = memento(
      () => stored,
      (value) => {
        stored = value;
      }
    );
    const persistence = new SessionPersistenceStore(memory.value);
    const commit = vi.fn(() => vi.fn());

    await expect(
      persistence.commitRuntimeReplacement(source, state("polars", 2), () => true, commit, { requireAbsent: true })
    ).resolves.toEqual({ kind: "stale" });
    expect(persistence.checkAbsent(source, "polars")).toEqual({ kind: "occupied" });
    expect(memory.update).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(Object.hasOwn(stored, key)).toBe(true);
    expect(stored[key]).toBe(entry);
    expect(stored.unrelated).toBe("keep");
  });

  it("commits a require-absent replacement only after its private pending record is durable", async () => {
    const key = persistenceKey(source, "polars");
    let stored: Record<string, unknown> = { unrelated: "keep" };
    const memory = memento(
      () => stored,
      (value) => {
        stored = value;
      }
    );
    const persistence = new SessionPersistenceStore(memory.value);
    const rollback = vi.fn();
    const commit = vi.fn(() => {
      expect(stored[key]).toMatchObject({ pendingRuntimeReplacement: { hadPreviousState: false } });
      expect(persistence.load(source, "polars")).toBeUndefined();
      expect(persistence.checkAbsent(source, "polars")).toEqual({ kind: "occupied" });
      return rollback;
    });

    expect(persistence.checkAbsent(source, "polars")).toEqual({ kind: "absent" });
    expect(memory.update).not.toHaveBeenCalled();
    await expect(
      persistence.commitRuntimeReplacement(source, state("polars", 2), () => true, commit, { requireAbsent: true })
    ).resolves.toEqual({ kind: "committed" });
    expect(memory.update).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenCalledOnce();
    expect(rollback).not.toHaveBeenCalled();
    expect(stored).toEqual({ [key]: serializedState("polars", 2), unrelated: "keep" });
  });

  it("rechecks require-absent target state after earlier queued storage work", async () => {
    const key = persistenceKey(source, "polars");
    const otherSource = { ...source, path: "/workspace/blocker.csv" };
    let stored: Record<string, unknown> = {};
    const entered = deferred<void>();
    const release = deferred<void>();
    const update = vi.fn(async (_key: string, value: Record<string, unknown>) => {
      stored = value;
      if (update.mock.calls.length === 1) {
        entered.resolve(undefined);
        await release.promise;
      }
    });
    const persistence = new SessionPersistenceStore(mementoFrom(() => stored, update));
    const commit = vi.fn(() => vi.fn());
    const blocker = persistence.save(otherSource, "polars", () => state("polars", 1));
    await entered.promise;
    expect(persistence.checkAbsent(source, "polars")).toEqual({ kind: "absent" });
    const newer = persistence.save(source, "polars", () => state("polars", 7));
    const replacement = persistence.commitRuntimeReplacement(source, state("polars", 2), () => true, commit, {
      requireAbsent: true
    });
    try {
      release.resolve(undefined);
      await blocker;
      await newer;
      await expect(replacement).resolves.toEqual({ kind: "stale" });
      expect(update).toHaveBeenCalledTimes(2);
      expect(commit).not.toHaveBeenCalled();
      expect(stored[key]).toEqual(serializedState("polars", 7));
    } finally {
      release.resolve(undefined);
      await Promise.allSettled([blocker, newer, replacement]);
    }
  });

  it.each(["restore", "rollback failure", "replacement"] as const)(
    "handles require-absent final-write failure with %s without removing unrelated state",
    async (outcome) => {
      const key = persistenceKey(source, "polars");
      let stored: Record<string, unknown> = { unrelated: "keep" };
      const update = vi.fn(async (_key: string, value: Record<string, unknown>) => {
        const attempt = update.mock.calls.length;
        if (attempt === 2) {
          if (outcome === "replacement") stored = { ...stored, [key]: "newer owner" };
          throw new Error("final storage unavailable");
        }
        if (attempt === 3 && outcome === "rollback failure") throw new Error("rollback unavailable");
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
        persistence.commitRuntimeReplacement(source, state("polars", 2), () => true, commit, { requireAbsent: true })
      ).resolves.toMatchObject({
        kind: "unavailable",
        failure: { kind: outcome === "rollback failure" ? "rollback" : "runtime-replacement" },
        liveState: "unchanged"
      });
      expect(commit).toHaveBeenCalledOnce();
      expect(rollback).toHaveBeenCalledOnce();
      expect(stored.unrelated).toBe("keep");
      if (outcome === "restore") {
        expect(update).toHaveBeenCalledTimes(3);
        expect(Object.hasOwn(stored, key)).toBe(false);
        expect(persistence.checkAbsent(source, "polars")).toEqual({ kind: "absent" });
        await expect(
          persistence.commitRuntimeReplacement(source, state("polars", 4), () => true, commit, { requireAbsent: true })
        ).resolves.toEqual({ kind: "committed" });
        expect(stored[key]).toEqual(serializedState("polars", 4));
      } else {
        expect(persistence.checkAbsent(source, "polars")).toEqual({ kind: "occupied" });
        if (outcome === "replacement") {
          expect(update).toHaveBeenCalledTimes(2);
          expect(stored[key]).toBe("newer owner");
        } else {
          expect(update).toHaveBeenCalledTimes(3);
          expect(stored[key]).toHaveProperty("pendingRuntimeReplacement");
          expect(failures.mock.calls.map(([failure]) => failure.kind)).toEqual(["runtime-replacement", "rollback"]);
        }
      }
    }
  );

  it("refuses require-absent work without a Memento while preserving ordinary ephemeral replacement", async () => {
    const persistence = new SessionPersistenceStore();
    const commit = vi.fn(() => vi.fn());
    await expect(
      persistence.commitRuntimeReplacement(source, state("polars", 2), () => true, commit, { requireAbsent: true })
    ).resolves.toMatchObject({
      kind: "unavailable",
      failure: { kind: "read", cause: { code: "STORAGE_UNAVAILABLE" } },
      liveState: "unchanged"
    });
    expect(persistence.checkAbsent(source, "polars")).toMatchObject({ kind: "unavailable", failure: { kind: "read" } });
    expect(commit).not.toHaveBeenCalled();
    await expect(persistence.commitRuntimeReplacement(source, state("polars", 2), () => true, commit)).resolves.toEqual(
      { kind: "committed" }
    );
    expect(commit).toHaveBeenCalledOnce();
  });

  it("preserves a staged candidate and confirmed cleaning/filter during a presentation save", async () => {
    const key = persistenceKey(source, "polars");
    const previous = state("polars", 1);
    const candidate: PersistedSessionState = {
      ...state("polars", 2),
      cleaning: {
        steps: [
          {
            id: "clone",
            kind: "cloneColumn",
            params: {
              column: { id: "c:value", name: "value" },
              newName: "copy"
            }
          }
        ]
      },
      view: {
        ...state("polars", 2).view,
        filterModel: { filters: [], sort: [{ column: "value", direction: "desc", nulls: "last" }] }
      }
    };
    let stored: Record<string, unknown> = { [key]: serializePersistedSession(previous) };
    const persistence = new SessionPersistenceStore(
      memento(
        () => stored,
        (value) => {
          stored = value;
        }
      ).value
    );
    const staged = await persistence.stageCurrent(source, candidate);
    if (staged.kind !== "staged") throw new Error("Expected the candidate to stage.");
    const pending = structuredClone(stored[key]);
    const presentation = {
      ...candidate,
      view: {
        ...candidate.view,
        selectedColumnId: "c:value",
        columnWidths: new Map([["c:value", 317]]),
        viewport: { firstVisibleRow: 7, scrollLeft: 67 }
      }
    };
    await persistence.save(source, "polars", () => presentation);
    expect(stored[key]).toMatchObject({
      pendingCurrentCommit: {
        token: staged.transaction.token,
        candidate: serializePersistedSession(candidate)
      }
    });
    expect(persistence.load(source, "polars")).toMatchObject({
      cleaning: previous.cleaning,
      view: { ...presentation.view, filterModel: previous.view.filterModel }
    });
    expect(pending).toMatchObject({ pendingCurrentCommit: { candidate: serializePersistedSession(candidate) } });
    const commit = vi.fn();
    await expect(
      persistence.commitStagedCurrent(
        staged.transaction,
        () => presentation,
        () => true,
        commit
      )
    ).resolves.toEqual({ kind: "committed" });
    expect(commit).toHaveBeenCalledWith(presentation);
    expect(persistence.load(source, "polars")).toEqual(presentation);
  });

  it("samples a queued save after an earlier commit publishes its new cleaning and filter", async () => {
    const key = persistenceKey(source, "polars");
    const otherSource = { ...source, path: "/workspace/blocker.csv" };
    let live = state("polars", 1);
    let stored: Record<string, unknown> = { [key]: serializePersistedSession(live) };
    const entered = deferred<void>();
    const release = deferred<void>();
    const persistence = new SessionPersistenceStore(
      mementoFrom(
        () => stored,
        async (_key, value) => {
          stored = value;
          if (value[persistenceKey(otherSource, "polars")]) {
            entered.resolve(undefined);
            await release.promise;
          }
        }
      )
    );
    const staged = await persistence.stageCurrent(source, live);
    if (staged.kind !== "staged") throw new Error("Expected staging to succeed.");
    const blocker = persistence.save(otherSource, "polars", () => state("polars", 0));
    try {
      await entered.promise;
      const candidate: PersistedSessionState = {
        ...state("polars", 7),
        cleaning: {
          steps: [
            {
              id: "clone",
              kind: "cloneColumn",
              params: {
                column: { id: "c:value", name: "value" },
                newName: "copy"
              }
            }
          ]
        },
        view: {
          ...state("polars", 7).view,
          filterModel: { filters: [], sort: [{ column: "value", direction: "desc", nulls: "last" }] }
        }
      };
      const commit = persistence.commitStagedCurrent(
        staged.transaction,
        () => candidate,
        () => true,
        (prepared) => {
          live = prepared;
        }
      );
      const save = persistence.save(source, "polars", () => live);
      expect(live.cleaning.steps).toEqual([]);
      release.resolve(undefined);
      await blocker;
      await expect(commit).resolves.toEqual({ kind: "committed" });
      await expect(save).resolves.toEqual({ kind: "committed" });
      expect(persistence.load(source, "polars")).toEqual(candidate);
      expect(stored[key]).toEqual(serializePersistedSession(candidate));
    } finally {
      release.resolve(undefined);
      await blocker;
    }
  });

  it.each([
    ["absent", undefined],
    ["invalid", { opaque: "retained" }],
    ["without view", { backend: "polars", cleaning: { steps: [] } }]
  ])("does not invent a reloadable candidate when the previous snapshot is %s", async (_label, previous) => {
    const key = persistenceKey(source, "polars");
    let stored: Record<string, unknown> = previous === undefined ? {} : { [key]: previous };
    const memory = memento(
      () => stored,
      (value) => {
        stored = value;
      }
    );
    const persistence = new SessionPersistenceStore(memory.value);
    const staged = await persistence.stageCurrent(source, state("polars", 2));
    if (staged.kind !== "staged") throw new Error("Expected staging to succeed.");
    const pending = structuredClone(stored[key]);
    await persistence.save(source, "polars", () => state("polars", 7));
    expect(memory.update).toHaveBeenCalledOnce();
    expect(stored[key]).toEqual(pending);
    await expect(persistence.restoreStagedCurrent(staged.transaction)).resolves.toEqual({ kind: "stale" });
    expect(stored[key]).toEqual(previous);
  });

  it("keeps a newer staged token active when an older transaction finishes", async () => {
    const key = persistenceKey(source, "polars");
    let stored: Record<string, unknown> = { [key]: serializedState("polars", 1) };
    const persistence = new SessionPersistenceStore(
      memento(
        () => stored,
        (value) => {
          stored = value;
        }
      ).value
    );
    const older = await persistence.stageCurrent(source, state("polars", 2));
    const newer = await persistence.stageCurrent(source, state("polars", 3));
    if (older.kind !== "staged" || newer.kind !== "staged") throw new Error("Expected both candidates to stage.");
    const commit = vi.fn();
    await expect(
      persistence.commitStagedCurrent(
        older.transaction,
        () => state("polars", 2),
        () => true,
        commit
      )
    ).resolves.toEqual({ kind: "stale" });
    expect(commit).not.toHaveBeenCalled();
    await persistence.save(source, "polars", () => state("polars", 7));
    expect(stored[key]).toMatchObject({ pendingCurrentCommit: { token: newer.transaction.token } });
    await expect(
      persistence.commitStagedCurrent(
        newer.transaction,
        () => state("polars", 3),
        () => true,
        commit
      )
    ).resolves.toEqual({ kind: "committed" });
    expect(commit).toHaveBeenCalledOnce();
    expect(persistence.load(source, "polars")).toEqual(state("polars", 3));
  });

  it.each(["final-write", "publication-rollback", "serialization-rollback", "supplier"] as const)(
    "releases a finished %s token so a later save can recover durable state",
    async (failurePoint) => {
      const key = persistenceKey(source, "polars");
      let stored: Record<string, unknown> = { [key]: serializedState("polars", 1) };
      const update = vi.fn(async (_key: string, value: Record<string, unknown>) => {
        if (update.mock.calls.length === 2) throw new Error("terminal persistence unavailable");
        stored = value;
      });
      const persistence = new SessionPersistenceStore(mementoFrom(() => stored, update));
      const staged = await persistence.stageCurrent(source, state("polars", 2));
      if (staged.kind !== "staged") throw new Error("Expected staging to succeed.");
      const candidate = state("polars", 2);
      if (failurePoint === "serialization-rollback") candidate.view.viewport.scrollLeft = Number.NaN;
      const operation = persistence.commitStagedCurrent(
        staged.transaction,
        () => {
          if (failurePoint === "supplier") throw new Error("state supplier failed");
          return candidate;
        },
        () => true,
        () => {
          if (failurePoint === "publication-rollback") throw new Error("publication failed");
          return () => true;
        }
      );
      if (failurePoint === "publication-rollback" || failurePoint === "supplier")
        await expect(operation).rejects.toThrow();
      else await expect(operation).resolves.toMatchObject({ kind: "unavailable" });
      expect(stored[key]).toHaveProperty("pendingCurrentCommit");
      // The supplier throws before a second write, so its recovery save uses the
      // next available write rather than this fixture's injected write fault.
      if (failurePoint === "supplier")
        update.mockImplementation(async (_key, value) => {
          stored = value;
        });
      await expect(persistence.save(source, "polars", () => state("polars", 17))).resolves.toEqual({
        kind: "committed"
      });
      expect(stored[key]).toEqual(serializedState("polars", 17));
      expect(persistence.status(source, "polars")).toEqual({ degraded: false, epoch: 0 });
    }
  );

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
    expect(persistence.checkAbsent(source, "polars")).toMatchObject({
      kind: "unavailable",
      failure: { kind: "read", cause: { code: "INVALID_ROOT" } }
    });
    const commit = vi.fn(() => vi.fn());
    await expect(
      persistence.commitRuntimeReplacement(source, state("polars", 2), () => true, commit, { requireAbsent: true })
    ).resolves.toMatchObject({ kind: "unavailable", failure: { kind: "read" }, liveState: "unchanged" });
    expect(commit).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(durable).toEqual({ [key]: serializedState("polars", 7) });
    await persistence.releaseOwner("opening:invalid-root");
    expect(persistence.ownershipCardinality()).toEqual({ retainedOwners: 0, retainedKeys: 0, degradedKeys: 0 });
  });

  it("saves native R file state separately while keeping every live R source ephemeral", async () => {
    const rLiveSources: SessionSource[] = [
      { kind: "notebookVariable", label: "frame", variableName: "frame" },
      { kind: "notebookOutput", label: "capture" },
      { kind: "rInteractiveVariable", label: "frame", variableName: "frame" },
      { kind: "documentVariable", label: "frame", variableName: "frame", path: "/workspace/source.R" }
    ];
    const snapshotSource: SessionSource = { kind: "notebookOutput", label: "capture" };
    const ephemeral = [
      [snapshotSource, "polars"],
      [source, "pyspark"],
      ...rLiveSources.map((input) => [input, "r"] as const)
    ] as const;
    let stored: Record<string, unknown> = { [persistenceKey(source, "polars")]: serializedState("polars", 7) };
    const memory = memento(
      () => stored,
      (value) => {
        stored = value;
      }
    );
    const persistence = new SessionPersistenceStore(memory.value);
    await persistence.save(source, "r", () => state("r", 2));
    expect(persistence.load(source, "r")).toEqual(state("r", 2));
    expect(persistence.load(source, "polars")).toEqual(state("polars", 7));
    const savedFileState = structuredClone(stored);
    memory.update.mockClear();
    const replacementCommit = vi.fn(() => vi.fn());
    const commit = vi.fn();
    for (const [input, backend] of ephemeral) {
      stored[persistenceKey(input, backend)] = serializedState("r", 3);
      expect(persistence.load(input, backend)).toBeUndefined();
      await persistence.save(input, backend, () => state(backend, 4));
      expect(persistence.checkAbsent(input, backend)).toMatchObject({
        kind: "unavailable",
        failure: { kind: "read", cause: { code: "STORAGE_UNAVAILABLE" } }
      });
      await expect(
        persistence.commitRuntimeReplacement(input, state(backend, 4), () => true, replacementCommit, {
          requireAbsent: true
        })
      ).resolves.toMatchObject({ kind: "unavailable", liveState: "unchanged" });
      await expect(
        persistence.commitCurrent(
          input,
          () => state(backend, 4),
          () => true,
          commit
        )
      ).resolves.toEqual({ kind: "committed" });
    }
    expect(replacementCommit).not.toHaveBeenCalled();
    expect(memory.update).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledTimes(ephemeral.length);
    expect(stored).toMatchObject(savedFileState);
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

    const first = persistence.save(source, "polars", () => state("polars", 1));
    await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
    const second = persistence.save(secondSource, "duckdb", () => state("duckdb", 2));
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
        () => state("polars", 2),
        () => true,
        () => {
          throw callbackFailure;
        }
      )
    ).rejects.toBe(callbackFailure);
    expect(stored[key]).toEqual(previous);
    expect(persistence.load(source, "polars")).toEqual(state("polars", 1));

    await expect(persistence.save(source, "polars", () => state("polars", 3))).resolves.toEqual({ kind: "committed" });
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
        () => state("polars", 2),
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
    await expect(persistence.save(source, "polars", () => state("polars", 3))).resolves.toEqual({ kind: "committed" });
    expect(persistence.load(source, "polars")).toEqual(state("polars", 3));
  });

  it("rejects a stale queued commit before it writes or publishes", async () => {
    const memory = memento();
    const persistence = new SessionPersistenceStore(memory.value);
    const commit = vi.fn();

    await expect(
      persistence.commitCurrent(
        source,
        () => state("polars", 1),
        () => false,
        commit
      )
    ).resolves.toEqual({
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

    const pending = persistence.commitCurrent(
      source,
      () => state("polars", 2),
      () => true,
      commit
    );
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
        () => state("polars", 2),
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

    const pending = persistence.commitCurrent(
      source,
      () => state("polars", 2),
      () => current,
      commit
    );
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

    const pending = persistence.commitCurrent(
      source,
      () => state("polars", 2),
      () => current,
      vi.fn()
    );
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

    await persistence.save(source, "polars", () => state("polars", 2));
    const pending = persistence.commitCurrent(
      source,
      () => state("polars", 3),
      () => current,
      vi.fn()
    );
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

    await persistence.save(source, "polars", () => state("polars", 1));
    const candidateB = persistence.commitCurrent(
      source,
      () => state("polars", 2),
      () => current,
      vi.fn()
    );
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

  it.each([
    { requireAbsent: false, cleanupReadFails: false },
    { requireAbsent: true, cleanupReadFails: false },
    { requireAbsent: true, cleanupReadFails: true }
  ])(
    "restores live state after a post-swap read failure (requireAbsent=$requireAbsent, cleanupReadFails=$cleanupReadFails)",
    async ({ requireAbsent, cleanupReadFails }) => {
      const key = persistenceKey(source, "polars");
      const previous = serializedState("polars", 1);
      let stored: Record<string, unknown> = { ...(requireAbsent ? {} : { [key]: previous }), unrelated: "keep" };
      let reads = 0;
      const update = vi.fn(async (_storageKey: string, value: Record<string, unknown>) => {
        stored = value;
      });
      const workspaceState = mementoFrom(() => {
        reads += 1;
        if (reads === 2) throw codedError("EACCES", "workspace read unavailable");
        if (reads === 3 && cleanupReadFails) throw codedError("EIO", "cleanup read unavailable");
        return stored;
      }, update);
      const failures = vi.fn<(failure: SessionPersistenceFailure) => void>();
      const persistence = new SessionPersistenceStore(workspaceState, failures);
      const rollback = vi.fn();
      const commit = vi.fn(() => rollback);

      await expect(
        persistence.commitRuntimeReplacement(source, state("polars", 2), () => true, commit, { requireAbsent })
      ).resolves.toMatchObject({
        kind: "unavailable",
        failure: { kind: "read", cause: { code: cleanupReadFails ? "EIO" : "EACCES" } },
        liveState: "unchanged"
      });

      expect(commit).toHaveBeenCalledOnce();
      expect(rollback).toHaveBeenCalledOnce();
      if (requireAbsent && !cleanupReadFails) {
        expect(Object.hasOwn(stored, key)).toBe(false);
      } else {
        expect(stored[key]).toHaveProperty("pendingRuntimeReplacement");
      }
      expect(stored.unrelated).toBe("keep");
      expect(reads).toBe(requireAbsent ? 3 : 2);
      expect(update).toHaveBeenCalledTimes(requireAbsent && !cleanupReadFails ? 2 : 1);
      expect(persistence.checkAbsent(source, "polars")).toEqual({
        kind: requireAbsent && !cleanupReadFails ? "absent" : "occupied"
      });
      expect(new SessionPersistenceStore(workspaceState).load(source, "polars")).toEqual(
        requireAbsent ? undefined : state("polars", 1)
      );
      expect(persistence.status(source, "polars")).toEqual({ degraded: true, epoch: 1, failureKind: "read" });
      expect(failureReceipts(failures)).toEqual([
        { kind: "read", cause: { name: "Error", code: "EACCES" }, epoch: 1, firstInEpoch: true }
      ]);
    }
  );

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

    await persistence.save(source, "polars", () => state("polars", 2));
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

    await expect(
      persistence.commitCurrent(
        source,
        () => state("polars", 1),
        () => true,
        pageCommit
      )
    ).resolves.toEqual({
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
    expect(persistence.checkAbsent(source, "polars")).toMatchObject({
      kind: "unavailable",
      failure: { kind: "read", cause: { code: "EACCES" } }
    });
    await expect(
      persistence.commitRuntimeReplacement(source, state("polars", 2), () => true, replacementCommit, {
        requireAbsent: true
      })
    ).resolves.toMatchObject({ kind: "unavailable", failure: { kind: "read" }, liveState: "unchanged" });

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

    await persistence.save(source, "polars", () => state("polars", 1));
    await persistence.save(otherSource, "polars", () => state("polars", 2));

    expect(persistence.status(source, "polars")).toEqual({ degraded: true, epoch: 1, failureKind: "save" });
    expect(persistence.status(otherSource, "polars")).toEqual({ degraded: false, epoch: 0 });

    await persistence.save(source, "polars", () => state("polars", 3));
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

    await persistence.save(source, "polars", () => state("polars", 1));
    await persistence.save(otherSource, "polars", () => state("polars", 2));
    expect(persistence.ownershipCardinality()).toEqual({ retainedOwners: 2, retainedKeys: 2, degradedKeys: 2 });
    expect(failures).toHaveBeenCalledTimes(2);

    persistence.releaseOwner("session-a");
    expect(persistence.status(source, "polars")).toEqual({ degraded: false, epoch: 0 });
    expect(persistence.status(otherSource, "polars")).toEqual({ degraded: true, epoch: 1, failureKind: "save" });
    expect(persistence.ownershipCardinality()).toEqual({ retainedOwners: 1, retainedKeys: 1, degradedKeys: 1 });

    writesFail = false;
    await persistence.save(otherSource, "polars", () => state("polars", 3));
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
      await persistence.save(ownerSource, "polars", () => state("polars", index));
      persistence.releaseOwner(ownerId);
    }

    expect(persistence.ownershipCardinality()).toEqual({ retainedOwners: 0, retainedKeys: 0, degradedKeys: 0 });
  });

  it("releases degradation after an in-flight owner write settles", async () => {
    const write = rejectingDeferred<void>();
    const update = vi.fn(() => write.promise);
    const persistence = new SessionPersistenceStore(mementoFrom(() => ({}), update));
    persistence.retainOwner("closing-session", source, "polars");

    const save = persistence.save(source, "polars", () => state("polars", 1));
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

    void persistence.save(source, "polars", () => state("polars", 1));
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

    await expect(
      persistence.commitCurrent(
        source,
        () => state("polars", 1),
        () => true,
        commit
      )
    ).resolves.toMatchObject({
      kind: "unavailable",
      failure: { kind: "save" },
      liveState: "unchanged"
    });
    await expect(persistence.save(source, "polars", () => state("polars", 2))).resolves.toMatchObject({
      kind: "unavailable"
    });
    expect(persistence.status(source, "polars")).toEqual({ degraded: true, epoch: 1, failureKind: "save" });
    expect(new SessionPersistenceStore(workspaceState).load(source, "polars")).toBeUndefined();

    await expect(persistence.save(source, "polars", () => state("polars", 3))).resolves.toEqual({ kind: "committed" });
    expect(persistence.status(source, "polars")).toEqual({ degraded: false, epoch: 0 });
    expect(new SessionPersistenceStore(workspaceState).load(source, "polars")).toEqual(state("polars", 3));

    await expect(persistence.save(source, "polars", () => state("polars", 4))).resolves.toMatchObject({
      kind: "unavailable"
    });

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
    ...(backend === "r" ? { rLibrary: "base" as const } : {}),
    cleaning: { steps: [] },
    view: {
      filterModel: { filters: [], sort: [] },
      columnWidths: new Map(),
      viewport: { firstVisibleRow, scrollLeft: 0 }
    }
  };
}

function serializedState(backend: Extract<DataBackend, "pandas" | "polars" | "duckdb" | "r">, firstVisibleRow: number) {
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
