import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { captureExportSourceProtection, beginAtomicFileTransaction } from "../extension/files/safeFileExport";
import { describe, expect, it, vi } from "vitest";
import type { Memento } from "vscode";
import { SessionCoordinator } from "../extension/sessionCoordinator";
import type {
  ColumnSchema,
  FilterModel,
  OpenWranglerRequest,
  OpenWranglerResponse,
  SessionMetadata,
  TransformStep
} from "../shared/protocol";
import {
  appliedFor,
  deferred,
  initialSource,
  metadataFor,
  open,
  openedFor,
  pageFor,
  previewFor
} from "./sessionReconfigurationTestFixtures";

const first: TransformStep = {
  id: "round-value",
  kind: "roundNumber",
  params: { column: { id: "c:value", name: "value" }, decimals: 1 }
};
const replacement: TransformStep = {
  ...first,
  params: { column: { id: "c:value", name: "value" }, decimals: 2 }
};
const second: TransformStep = {
  id: "floor-value",
  kind: "floorNumber",
  params: { column: { id: "c:value", name: "value" } }
};
const third: TransformStep = {
  id: "clone-value",
  kind: "cloneColumn",
  params: { column: { id: "c:value", name: "value" }, newName: "copy" }
};

describe("SessionCoordinator earlier-step plan rewrites", () => {
  it("keeps the cloned runtime source protected when an earlier cleaning step is rewritten", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "openwrangler-source-clone-"));
    const sourcePath = path.join(directory, "sample.csv");
    const original = path.join(directory, "original.csv");
    const source = { ...initialSource, path: sourcePath, uri: vscode.Uri.file(sourcePath).toString() };
    const coordinator = new SessionCoordinator();
    try {
      await writeFile(sourcePath, "value\n1\n");
      const harness = rewriteHarness({ source, draft: replacement });
      const bridge = coordinator.createBridge({ request: harness.request });
      const opened = await open(bridge, source);
      const retained = coordinator.activeSession()?.sourceProtection;
      expect(retained?.available).toBe(true);
      await rename(sourcePath, original);
      await writeFile(sourcePath, "ordinary saved source\n");
      const response = await bridge.rewriteCleaningPlan?.(
        opened.metadata.sessionId,
        opened.metadata.revision,
        first.id,
        "applyDraft",
        { offset: 0, limit: 100, columnOffset: 0, columnLimit: 16 }
      );
      expect(response?.kind).toBe("planUpdated");
      expect(coordinator.activeSession()?.sourceProtection).toBe(retained);
      const action = await captureExportSourceProtection(
        [vscode.Uri.file(sourcePath)],
        coordinator.activeSession()?.sourceProtection
      );
      await expect(
        beginAtomicFileTransaction({ destination: vscode.Uri.file(original), sourceProtection: action })
      ).rejects.toThrow(/never overwrites/u);
      const separate = await beginAtomicFileTransaction({
        destination: vscode.Uri.file(path.join(directory, "clean.py")),
        sourceProtection: action
      });
      await separate.rollback();
    } finally {
      await coordinator.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("publishes one stable-ID replacement only after replaying the unchanged suffix", async () => {
    const harness = rewriteHarness({ draft: replacement });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: harness.request });
    const opened = await open(bridge, initialSource);

    const response = await bridge.rewriteCleaningPlan?.(
      opened.metadata.sessionId,
      opened.metadata.revision,
      first.id,
      "applyDraft",
      { offset: 0, limit: 100, columnOffset: 0, columnLimit: 16 }
    );

    expect(response).toMatchObject({
      kind: "planUpdated",
      action: "apply",
      revision: opened.metadata.revision + 1,
      metadata: { sessionId: opened.metadata.sessionId, steps: [replacement, second, third] }
    });
    expect(harness.replayedStepIds()).toEqual([first.id, second.id, third.id]);
    expect(harness.replayedSteps()[0]).toEqual(replacement);
    expect(harness.candidateOpenRequests()).toEqual([
      expect.objectContaining({
        cloneFrom: { sessionId: "runtime-old", revision: 7 },
        requestedSessionId: expect.any(String)
      })
    ]);
    expect(coordinator.activeSession()).toMatchObject({
      sessionId: opened.metadata.sessionId,
      metadata: { steps: [replacement, second, third] },
      code: "# applied clone-value"
    });
    expect(coordinator.activeSession()?.metadata).not.toHaveProperty("draftStep");
    expect(harness.closedRuntimeIds()).toContain("runtime-old");
  });

  it("deletes exactly one stable-ID target and retains every suffix ID", async () => {
    const harness = rewriteHarness();
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: harness.request });
    const opened = await open(bridge, initialSource);
    const session = coordinator["sessions"].get(opened.metadata.sessionId)!;
    session.sourceSchema = undefined;

    const response = await bridge.rewriteCleaningPlan?.(
      opened.metadata.sessionId,
      opened.metadata.revision,
      second.id,
      "deleteStep",
      { offset: 0, limit: 100, columnOffset: 0, columnLimit: 16 }
    );

    expect(response).toMatchObject({
      kind: "planUpdated",
      action: "apply",
      metadata: { steps: [first, third] }
    });
    expect(harness.replayedStepIds()).toEqual([first.id, third.id]);
    expect(session.sourceSchema).toBeUndefined();
  });

  it.each([
    { label: "type-changed predicate", amountPredicate: true, amountSort: false },
    { label: "type-changed sort", amountPredicate: false, amountSort: true },
    { label: "unrelated view", amountPredicate: false, amountSort: false }
  ])("reconciles the $label before paging a rewritten plan", async ({ amountPredicate, amountSort }) => {
    const originalSchema: ColumnSchema[] = [
      { id: "c:amount", name: "amount", position: 0, rawType: "int64", type: "integer", nullable: false },
      { id: "c:label", name: "label", position: 1, rawType: "str", type: "string", nullable: false }
    ];
    const castSchema: ColumnSchema[] = [
      { ...originalSchema[0]!, rawType: "string", type: "string" },
      originalSchema[1]!
    ];
    const cast: TransformStep = {
      id: "amount-text",
      kind: "castColumn",
      params: { column: { id: "c:amount", name: "amount" }, dtype: "string" }
    };
    const lower: TransformStep = {
      id: "lower-label",
      kind: "lowerText",
      params: { column: { id: "c:label", name: "label" } }
    };
    const kept: FilterModel = {
      logic: "and",
      filters: [
        { column: "label", type: "string", predicates: [{ kind: "predicate", operator: "notEquals", value: "b" }] }
      ],
      sort: [{ column: "label", direction: "desc", nulls: "last" }]
    };
    const currentView: FilterModel = {
      ...kept,
      filters: amountPredicate
        ? [
            { column: "amount", type: "string", predicates: [{ kind: "predicate", operator: "contains", value: "1" }] },
            ...kept.filters
          ]
        : kept.filters,
      sort: amountSort ? [{ column: "amount", direction: "asc", nulls: "last" }, ...kept.sort] : kept.sort
    };
    const harness = rewriteHarness();
    // Supply schemas for this plan; this fixture observes host dispatch, not native execution.
    const request = async (message: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      const response = await harness.request(message);
      if (
        response.kind !== "sessionOpened" &&
        response.kind !== "stepPreview" &&
        response.kind !== "planUpdated" &&
        response.kind !== "page"
      )
        return response;
      const original = response.metadata.sessionId === "runtime-old";
      const schema = original ? castSchema : originalSchema;
      const totalRows = response.page.totalRows;
      if (totalRows === null) throw new Error("Expected a finite editing fixture page.");
      return {
        ...response,
        metadata: {
          ...response.metadata,
          backend: "pandas",
          rowAxis: { kind: "positional", levelNames: [] },
          schema,
          shape: { rows: 2, columns: 2 },
          filteredShape: { rows: 2, columns: 2 },
          ...(original ? { steps: [cast, lower] } : {}),
          ...(response.metadata.latestStepInputSchema ? { latestStepInputSchema: schema } : {})
        },
        page: { ...response.page, totalRows, columnIds: schema.map((column) => column.id) }
      };
    };
    const coordinator = new SessionCoordinator();
    try {
      const bridge = coordinator.createBridge({ request });
      const opened = await open(bridge, initialSource);
      const viewed = await bridge.request({
        kind: "getPage",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision,
        viewRequestId: "before-cast-deletion",
        offset: 0,
        limit: 100,
        columnOffset: 0,
        columnLimit: 16,
        filterModel: currentView
      });
      expect(viewed.kind).toBe("page");
      expect(coordinator.activeSession()?.metadata.filterModel).toEqual(currentView);
      const response = await bridge.rewriteCleaningPlan?.(
        opened.metadata.sessionId,
        opened.metadata.revision,
        cast.id,
        "deleteStep",
        { offset: 0, limit: 100, columnOffset: 0, columnLimit: 16 }
      );
      expect(response).toMatchObject({ kind: "planUpdated", metadata: { steps: [lower] } });
      expect(harness.replayedSteps()).toEqual([lower]);
      expect(harness.candidatePageRequests()).toEqual([expect.objectContaining({ filterModel: kept })]);
      expect(coordinator.activeSession()?.metadata.filterModel).toEqual(kept);
    } finally {
      await coordinator.shutdown();
    }
  });

  it("leaves the confirmed runtime, plan, draft, view, revision, and code unchanged when a suffix rejects", async () => {
    const harness = rewriteHarness({ draft: replacement, rejectStepId: second.id });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: harness.request });
    const opened = await open(bridge, initialSource);
    const before = coordinator.activeSession();

    const response = await bridge.rewriteCleaningPlan?.(
      opened.metadata.sessionId,
      opened.metadata.revision,
      first.id,
      "applyDraft",
      { offset: 0, limit: 100, columnOffset: 0, columnLimit: 16 }
    );

    expect(response).toMatchObject({ kind: "error", code: "plan_rewrite_failed", recoverable: true });
    expect(coordinator.activeSession()).toEqual(before);
    expect(harness.closedRuntimeIds()).toEqual([expect.stringMatching(/.+/u)]);
    expect(harness.closedRuntimeIds()).not.toContain("runtime-old");
  });

  it("rejects a candidate whose backend drifts during suffix replay", async () => {
    const harness = rewriteHarness({ draft: replacement, replayBackend: "pandas" });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: harness.request });
    const opened = await open(bridge, initialSource);
    const before = coordinator.activeSession();

    const response = await bridge.rewriteCleaningPlan?.(
      opened.metadata.sessionId,
      opened.metadata.revision,
      first.id,
      "applyDraft",
      { offset: 0, limit: 100, columnOffset: 0, columnLimit: 16 }
    );

    expect(response).toMatchObject({ kind: "error", code: "plan_rewrite_failed", recoverable: true });
    expect(coordinator.activeSession()).toEqual(before);
    expect(harness.closedRuntimeIds()).toHaveLength(1);
  });

  it("keeps a view change confirmed while a replacement draft waits for an in-flight page", async () => {
    const foregroundPage = deferred<OpenWranglerResponse>();
    const harness = rewriteHarness({ draft: replacement, oldPage: foregroundPage.promise });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: harness.request });
    const opened = await open(bridge, initialSource);
    const currentFilter = {
      logic: "and" as const,
      filters: [],
      sort: [{ column: "value", direction: "asc" as const, nulls: "last" as const }]
    };

    const pageRequest = {
      kind: "getPage" as const,
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      offset: 0,
      limit: 100,
      columnOffset: 0,
      columnLimit: 16,
      filterModel: currentFilter,
      viewRequestId: "view-after-preview"
    };
    const page = bridge.request(pageRequest);
    await vi.waitFor(() =>
      expect(harness.request).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "getPage", sessionId: "runtime-old" }),
        undefined
      )
    );

    const rewrite = bridge.rewriteCleaningPlan?.(
      opened.metadata.sessionId,
      opened.metadata.revision,
      first.id,
      "applyDraft",
      { offset: 0, limit: 100, columnOffset: 0, columnLimit: 16 }
    );

    expect(harness.candidateOpenRequests()).toEqual([]);
    foregroundPage.resolve(
      pageFor(
        { ...pageRequest, sessionId: "runtime-old" },
        {
          ...metadataFor({
            runtimeId: "runtime-old",
            source: initialSource,
            revision: opened.metadata.revision,
            steps: [first, second, third],
            draftStep: replacement,
            filterModel: currentFilter
          }),
          draftReplacesStepId: first.id
        }
      )
    );
    try {
      await expect(page).resolves.toMatchObject({
        kind: "page",
        revision: opened.metadata.revision,
        metadata: { filterModel: currentFilter }
      });
      await expect(rewrite).resolves.toMatchObject({ kind: "planUpdated", metadata: { filterModel: currentFilter } });
      expect(harness.candidatePageRequests()).toEqual([expect.objectContaining({ filterModel: currentFilter })]);
      expect(coordinator.activeSession()?.metadata.filterModel).toEqual(currentFilter);
    } finally {
      await coordinator.shutdown();
    }
  });

  it.each([false, true])("pairs the saved draft view with its full schema, newer view: %s", async (newerView) => {
    const inputSchema = metadataFor({ runtimeId: "runtime-old", source: initialSource }).schema;
    const firstClone: TransformStep = {
      id: first.id,
      kind: "cloneColumn",
      params: { column: { id: "c:value", name: "value" }, newName: "old_copy" }
    };
    const replacementClone: TransformStep = { ...firstClone, params: { ...firstClone.params, newName: "new_copy" } };
    const copiedColumn: ColumnSchema = { ...inputSchema[0]!, id: "c:copy", name: "copy", position: 2 };
    const draftSchema: ColumnSchema[] = [
      ...inputSchema,
      { ...inputSchema[0]!, id: "c:first-copy", name: "new_copy", position: 1 }
    ];
    const committedSchema: ColumnSchema[] = [...inputSchema, { ...draftSchema[1]!, name: "old_copy" }, copiedColumn];
    const finalSchema = [...draftSchema, copiedColumn];
    const baseView: FilterModel = {
      logic: "and",
      filters: [{ column: "copy", type: "float", predicates: [{ kind: "predicate", operator: "gte", value: 1 }] }],
      sort: [{ column: "copy", direction: "desc", nulls: "last" }]
    };
    const changedView: FilterModel = {
      logic: "and",
      filters: [{ column: "new_copy", type: "float", predicates: [{ kind: "predicate", operator: "lt", value: 1 }] }],
      sort: [{ column: "new_copy", direction: "asc", nulls: "last" }]
    };
    let originalMetadata: SessionMetadata = {
      ...metadataFor({
        runtimeId: "runtime-old",
        source: initialSource,
        revision: 7,
        steps: [firstClone, second, third]
      }),
      schema: committedSchema,
      latestStepInputSchema: committedSchema.slice(0, 2),
      shape: { rows: 2, columns: 3 },
      filteredShape: { rows: 2, columns: 3 }
    };
    const harness = rewriteHarness();
    const request = async (message: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (message.kind === "getPage" && message.sessionId === "runtime-old") {
        originalMetadata = { ...originalMetadata, filterModel: message.filterModel };
        return pageFor(message, originalMetadata);
      }
      if (message.kind === "previewStep" && message.sessionId === "runtime-old") {
        originalMetadata = {
          ...originalMetadata,
          revision: message.revision + 1,
          draftStep: message.step,
          draftReplacesStepId: message.replaceStepId,
          schema: draftSchema,
          filterModel: { filters: [], sort: [] },
          shape: { rows: 2, columns: 2 },
          filteredShape: { rows: 2, columns: 2 }
        };
        return previewFor(message, originalMetadata, "# earlier replacement draft");
      }
      const response = await harness.request(message);
      if (
        response.kind !== "sessionOpened" &&
        response.kind !== "stepPreview" &&
        response.kind !== "planUpdated" &&
        response.kind !== "page"
      )
        return response;
      const old = response.metadata.sessionId === "runtime-old";
      const hasCopy =
        response.metadata.steps.some((step) => step.id === third.id) || response.metadata.draftStep?.id === third.id;
      const hasFirstClone =
        response.metadata.steps.some((step) => step.id === first.id) || response.metadata.draftStep?.id === first.id;
      const schema = hasCopy ? finalSchema : hasFirstClone ? draftSchema : inputSchema;
      const totalRows = response.page.totalRows;
      if (totalRows === null) throw new Error("Expected a finite editing fixture page.");
      return {
        ...response,
        metadata: old
          ? originalMetadata
          : {
              ...response.metadata,
              schema,
              shape: { rows: 2, columns: schema.length },
              filteredShape: { rows: 2, columns: schema.length },
              ...(response.metadata.latestStepInputSchema
                ? { latestStepInputSchema: hasCopy ? draftSchema : inputSchema }
                : {})
            },
        page: { ...response.page, totalRows, columnIds: (old ? committedSchema : schema).map((column) => column.id) }
      };
    };
    const coordinator = new SessionCoordinator();
    try {
      const bridge = coordinator.createBridge({ request });
      const opened = await open(bridge, initialSource);
      const sid = opened.metadata.sessionId;
      const session = coordinator["sessions"].get(sid)!;
      // This fixture starts with a confirmed plan, so retain its genuine
      // original input separately from the already-cleaned opening metadata.
      const sourceSchema = structuredClone(inputSchema);
      session.sourceSchema = sourceSchema;
      const viewRequest = {
        kind: "getPage" as const,
        sessionId: sid,
        revision: opened.metadata.revision,
        viewRequestId: "before-earlier-edit",
        offset: 0,
        limit: 100,
        columnOffset: 0,
        columnLimit: 16,
        filterModel: baseView
      };
      expect((await bridge.request(viewRequest)).kind).toBe("page");
      const preview = await bridge.request({
        kind: "previewStep",
        sessionId: sid,
        revision: opened.metadata.revision,
        step: replacementClone,
        replaceStepId: first.id,
        offset: 0,
        limit: 100,
        columnOffset: 0,
        columnLimit: 16
      });
      expect(preview.kind).toBe("stepPreview");
      expect(coordinator.activeSession()?.metadata.schema).toEqual(draftSchema);
      const revision = coordinator.activeSession()!.metadata.revision;
      if (newerView) {
        expect(
          (
            await bridge.request({
              ...viewRequest,
              revision,
              viewRequestId: "after-earlier-edit",
              filterModel: changedView
            })
          ).kind
        ).toBe("page");
      }
      const response = await bridge.rewriteCleaningPlan?.(sid, revision, first.id, "applyDraft", {
        offset: 0,
        limit: 100,
        columnOffset: 0,
        columnLimit: 16
      });
      expect(response).toMatchObject({
        kind: "planUpdated",
        metadata: { steps: [replacementClone, second, third], schema: finalSchema }
      });
      const expectedView = newerView ? changedView : baseView;
      expect(harness.candidatePageRequests()).toEqual([expect.objectContaining({ filterModel: expectedView })]);
      expect(coordinator.activeSession()?.metadata.filterModel).toEqual(expectedView);
      expect(session.sourceSchema).toEqual(inputSchema);
      expect(session.sourceSchema).not.toBe(sourceSchema);
      expect(session.sourceSchema?.[0]).not.toBe(sourceSchema[0]);
      expect(session.sourceSchema).not.toEqual(finalSchema);
    } finally {
      await coordinator.shutdown();
    }
  });

  it("persists the complete candidate before publishing it once", async () => {
    const harness = rewriteHarness({ draft: replacement });
    let stored: Record<string, unknown> = {};
    const coordinatorRef: { current?: SessionCoordinator } = {};
    let activeStepsDuringPersistence: readonly TransformStep[] | undefined;
    const workspaceState = {
      keys: () => [],
      get: <T>(_key: string, defaultValue?: T): T | undefined =>
        (Object.keys(stored).length > 0 ? stored : defaultValue) as T | undefined,
      update: vi.fn(async (_key: string, value: unknown) => {
        activeStepsDuringPersistence ??= coordinatorRef.current?.activeSession()?.metadata.steps;
        stored = value as Record<string, unknown>;
      })
    } as unknown as Memento;
    const coordinator = new SessionCoordinator(workspaceState);
    coordinatorRef.current = coordinator;
    const bridge = coordinator.createBridge({ request: harness.request });
    const opened = await open(bridge, initialSource);

    const response = await bridge.rewriteCleaningPlan?.(
      opened.metadata.sessionId,
      opened.metadata.revision,
      first.id,
      "applyDraft",
      { offset: 0, limit: 100, columnOffset: 0, columnLimit: 16 }
    );

    expect(response).toMatchObject({ kind: "planUpdated", metadata: { steps: [replacement, second, third] } });
    expect(activeStepsDuringPersistence).toEqual([first, second, third]);
    const persisted = Object.values(stored)[0] as { cleaning?: { steps?: TransformStep[]; draftStep?: unknown } };
    expect(persisted.cleaning?.steps).toEqual([replacement, second, third]);
    expect(persisted.cleaning?.draftStep).toBeUndefined();
    expect(coordinator.activeSession()?.metadata.steps).toEqual([replacement, second, third]);
  });

  it("keeps the prior runtime when replacement persistence becomes unavailable", async () => {
    const harness = rewriteHarness({ draft: replacement });
    let reads = 0;
    const workspaceState = {
      keys: () => [],
      get: <T>(_key: string, defaultValue?: T): T | undefined => {
        reads += 1;
        if (reads === 2) {
          throw Object.assign(new Error("cannot read /private/workspace/state.json"), { code: "EACCES" });
        }
        return defaultValue;
      },
      update: vi.fn()
    } as unknown as Memento;
    const coordinator = new SessionCoordinator(workspaceState);
    const bridge = coordinator.createBridge({ request: harness.request });
    const opened = await open(bridge, initialSource);

    const response = await bridge.rewriteCleaningPlan?.(
      opened.metadata.sessionId,
      opened.metadata.revision,
      first.id,
      "applyDraft",
      { offset: 0, limit: 100, columnOffset: 0, columnLimit: 16 }
    );

    expect(response).toEqual({
      kind: "error",
      code: "persistence_unavailable",
      message:
        "Open Wrangler could not save workspace recovery state, so the active session was left unchanged. Retry after workspace storage is available.",
      recoverable: true,
      sessionId: opened.metadata.sessionId
    });
    expect(JSON.stringify(response)).not.toContain("/private/workspace");
    expect(coordinator.activeSession()?.metadata.steps).toEqual([first, second, third]);
    expect(harness.closedRuntimeIds()).toEqual([harness.candidateOpenRequests()[0]?.requestedSessionId]);

    await coordinator.shutdown();
  });

  it("settles a failed final save before terminal close resolves its runtime target", async () => {
    const harness = rewriteHarness({ draft: replacement });
    let stored: Record<string, unknown> = {};
    let updateCount = 0;
    const finalWriteStarted = deferred<void>();
    const releaseFinalWrite = deferred<void>();
    const workspaceState = {
      keys: () => [],
      get: <T>(_key: string, defaultValue?: T): T | undefined =>
        (Object.keys(stored).length > 0 ? stored : defaultValue) as T | undefined,
      update: vi.fn(async (_key: string, value: unknown) => {
        updateCount += 1;
        if (updateCount === 1) {
          stored = value as Record<string, unknown>;
          return;
        }
        finalWriteStarted.resolve();
        await releaseFinalWrite.promise;
        throw new Error("final persistence unavailable");
      })
    } as unknown as Memento;
    const coordinator = new SessionCoordinator(workspaceState);
    const bridge = coordinator.createBridge({ request: harness.request });
    const opened = await open(bridge, initialSource);
    const session = coordinator["sessions"].get(opened.metadata.sessionId)!;
    const sourceSchema = session.sourceSchema;
    expect(sourceSchema).toEqual(opened.metadata.schema);

    const rewrite = bridge.rewriteCleaningPlan?.(
      opened.metadata.sessionId,
      opened.metadata.revision,
      first.id,
      "applyDraft",
      { offset: 0, limit: 100, columnOffset: 0, columnLimit: 16 }
    );
    await finalWriteStarted.promise;
    const candidateSourceSchema = session.sourceSchema;
    expect(candidateSourceSchema).toEqual(sourceSchema);
    expect(candidateSourceSchema).not.toBe(sourceSchema);
    const candidateId = harness.candidateOpenRequests()[0]?.requestedSessionId;
    expect(candidateId).toEqual(expect.any(String));

    const close = bridge.request({
      kind: "closeSession",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision
    });
    await Promise.resolve();
    expect(harness.closedRuntimeIds()).toEqual([]);

    releaseFinalWrite.resolve();
    await expect(rewrite).resolves.toMatchObject({ kind: "error", code: "persistence_unavailable" });
    expect(session.runtimeId).toBe(candidateId);
    expect(session.sourceSchema).toBe(candidateSourceSchema);
    expect(session.sourceSchema).toEqual(sourceSchema);
    await expect(close).resolves.toEqual({ kind: "sessionClosed", sessionId: opened.metadata.sessionId });
    expect(harness.closedRuntimeIds()).toEqual(["runtime-old", candidateId]);
    expect(coordinator.activeSession()).toBeUndefined();
  });

  it("does not deadlock close behind an active foreground request and a waiting rewrite", async () => {
    const foregroundPage = deferred<OpenWranglerResponse>();
    const harness = rewriteHarness({ draft: replacement, oldPage: foregroundPage.promise });
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge({ request: harness.request });
    const opened = await open(bridge, initialSource);
    const pageRequest = {
      kind: "getPage" as const,
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision,
      viewRequestId: "foreground-before-rewrite",
      offset: 0,
      limit: 100,
      columnOffset: 0,
      columnLimit: 16,
      filterModel: opened.metadata.filterModel
    };

    const page = bridge.request(pageRequest);
    await vi.waitFor(() =>
      expect(harness.request).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "getPage", sessionId: "runtime-old" }),
        undefined
      )
    );
    const rewrite = bridge.rewriteCleaningPlan?.(
      opened.metadata.sessionId,
      opened.metadata.revision,
      first.id,
      "applyDraft",
      { offset: 0, limit: 100, columnOffset: 0, columnLimit: 16 }
    );
    const close = bridge.request({
      kind: "closeSession",
      sessionId: opened.metadata.sessionId,
      revision: opened.metadata.revision
    });

    foregroundPage.resolve(
      pageFor(
        { ...pageRequest, sessionId: "runtime-old" },
        metadataFor({
          runtimeId: "runtime-old",
          source: initialSource,
          revision: opened.metadata.revision,
          steps: [first, second, third],
          draftStep: replacement
        })
      )
    );

    await expect(page).resolves.toMatchObject({ kind: "page" });
    await expect(close).resolves.toEqual({ kind: "sessionClosed", sessionId: opened.metadata.sessionId });
    await expect(rewrite).resolves.toMatchObject({ kind: "error", code: "session_closing" });
    expect(harness.candidateOpenRequests()).toEqual([]);
    expect(harness.closedRuntimeIds()).toEqual(["runtime-old"]);
  });
});

function rewriteHarness(
  options: {
    source?: typeof initialSource;
    draft?: TransformStep;
    rejectStepId?: string;
    replayBackend?: "pandas" | "polars";
    oldPage?: Promise<OpenWranglerResponse>;
  } = {}
) {
  const requests: OpenWranglerRequest[] = [];
  const closed: string[] = [];
  const replayed: TransformStep[] = [];
  let candidateId = "";
  let candidateSteps: TransformStep[] = [];
  const initialMetadata: SessionMetadata = {
    ...metadataFor({
      runtimeId: "runtime-old",
      source: options.source ?? initialSource,
      revision: 7,
      steps: [first, second, third],
      draftStep: options.draft
    }),
    ...(options.draft ? { draftReplacesStepId: first.id } : {})
  };

  const request = vi.fn(async (message: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
    requests.push(message);
    if (message.kind === "openSession" && !message.requestedSessionId) {
      return openedFor(message, initialMetadata);
    }
    if (message.kind === "openSession") {
      candidateId = message.requestedSessionId ?? "";
      candidateSteps = [];
      return openedFor(message, metadataFor({ runtimeId: candidateId, source: options.source ?? initialSource }));
    }
    if (message.kind === "getPage" && message.sessionId === "runtime-old") {
      if (options.oldPage) return options.oldPage;
      return pageFor(message, { ...initialMetadata, filterModel: message.filterModel });
    }
    if (message.kind === "previewStep" && message.sessionId === candidateId) {
      replayed.push(message.step);
      if (message.step.id === options.rejectStepId) {
        return {
          kind: "error",
          code: "invalid_step",
          message: "The unchanged suffix no longer binds.",
          recoverable: true,
          sessionId: candidateId
        };
      }
      return previewFor(
        message,
        {
          ...metadataFor({
            runtimeId: candidateId,
            source: options.source ?? initialSource,
            backend: options.replayBackend,
            revision: message.revision + 1,
            steps: candidateSteps,
            draftStep: message.step
          }),
          latestStepInputSchema: initialMetadata.schema
        },
        `# preview ${message.step.id}`
      );
    }
    if (message.kind === "applyDraft" && message.sessionId === candidateId) {
      const step = replayed.at(-1);
      if (!step) throw new Error("Apply arrived without a replayed preview.");
      candidateSteps = [...candidateSteps, step];
      return appliedFor(
        message,
        metadataFor({
          runtimeId: candidateId,
          source: options.source ?? initialSource,
          backend: options.replayBackend,
          revision: message.revision + 1,
          steps: candidateSteps
        }),
        `# applied ${step.id}`
      );
    }
    if (message.kind === "getPage" && message.sessionId === candidateId) {
      return pageFor(
        message,
        metadataFor({
          runtimeId: candidateId,
          source: options.source ?? initialSource,
          backend: options.replayBackend,
          revision: message.revision,
          steps: candidateSteps,
          filterModel: message.filterModel
        })
      );
    }
    if (message.kind === "closeSession") {
      closed.push(message.sessionId);
      return { kind: "sessionClosed", sessionId: message.sessionId };
    }
    throw new Error(`Unexpected request: ${message.kind}`);
  });
  return {
    request,
    replayedStepIds: () => replayed.map((step) => step.id),
    replayedSteps: () => replayed,
    closedRuntimeIds: () => closed,
    candidateOpenRequests: () =>
      requests.filter(
        (request): request is Extract<OpenWranglerRequest, { kind: "openSession" }> =>
          request.kind === "openSession" && request.requestedSessionId !== undefined
      ),
    candidatePageRequests: () =>
      requests.filter(
        (request): request is Extract<OpenWranglerRequest, { kind: "getPage" }> =>
          request.kind === "getPage" && request.sessionId === candidateId
      )
  };
}
