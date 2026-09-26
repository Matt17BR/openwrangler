import { describe, expect, it, vi } from "vitest";
import type { Memento } from "vscode";
import { SessionCoordinator } from "../extension/sessionCoordinator";
import {
  persistedSessionState,
  persistenceKey,
  serializePersistedSession,
  SESSION_STORAGE_KEY
} from "../extension/sessionPersistence";
import type {
  ColumnSchema,
  DataBackend,
  OpenWranglerRequest,
  OpenWranglerResponse,
  RLibrary,
  SessionMetadata,
  SessionSource,
  TransformStep
} from "../shared/protocol";
import {
  appliedFor,
  appliedStep,
  initialSource,
  metadataFor,
  open,
  openRequest,
  openedFor,
  pageFor,
  previewFor,
  schema
} from "./sessionReconfigurationTestFixtures";

const rSchema: ColumnSchema[] = schema.map((column, position) => ({
  ...column,
  id: `r:c:${position}`,
  rawType: "double"
}));
const rValue = { id: "r:c:0", name: "value" };
const rStep: TransformStep = { id: appliedStep.id, kind: "roundNumber", params: { column: rValue, decimals: 1 } };

interface RuntimeSession {
  backend: DataBackend;
  source: SessionSource;
  rLibrary: RLibrary | undefined;
  steps: TransformStep[];
  draft: TransformStep | undefined;
}

/**
 * One runtime process: its first open is the confirmed session, later opens are replacement candidates. A Python
 * runtime serves whichever Python engine a request names.
 */
function fakeRuntime(backend: DataBackend, columns: ColumnSchema[], initialSteps: TransformStep[] = []) {
  const requests: OpenWranglerRequest[] = [];
  const sessions = new Map<string, RuntimeSession>();
  const describeSession = (sessionId: string, revision: number): SessionMetadata => {
    const session = sessions.get(sessionId);
    if (!session) throw new Error(`Unknown runtime session ${sessionId}.`);
    return {
      ...metadataFor({
        runtimeId: sessionId,
        source: session.source,
        backend: session.backend,
        revision,
        steps: session.steps,
        draftStep: session.draft
      }),
      ...(session.rLibrary ? { rLibrary: session.rLibrary } : {}),
      schema: columns,
      ...(session.steps.length > 0 ? { latestStepInputSchema: columns } : {})
    };
  };
  const request = vi.fn(async (message: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
    requests.push(message);
    switch (message.kind) {
      case "openSession": {
        const sessionId = message.requestedSessionId ?? `${backend}-runtime`;
        sessions.set(sessionId, {
          backend: backend === "r" ? "r" : (message.backend ?? backend),
          source: message.source,
          rLibrary: backend === "r" ? (message.rLibrary ?? "base") : undefined,
          steps: requests.filter((item) => item.kind === "openSession").length === 1 ? [...initialSteps] : [],
          draft: undefined
        });
        const opened = openedFor(message, describeSession(sessionId, 0));
        return { ...opened, page: { ...opened.page, columnIds: columns.map((column) => column.id) } };
      }
      case "previewStep": {
        const session = sessions.get(message.sessionId);
        if (session) session.draft = message.step;
        return previewFor(message, describeSession(message.sessionId, message.revision + 1), "# preview");
      }
      case "applyDraft": {
        const session = sessions.get(message.sessionId);
        if (session?.draft) session.steps = [...session.steps, session.draft];
        if (session) session.draft = undefined;
        return appliedFor(message, describeSession(message.sessionId, message.revision + 1), "# apply");
      }
      case "getPage":
        return pageFor(message, {
          ...describeSession(message.sessionId, message.revision),
          filterModel: message.filterModel
        });
      case "closeSession":
        sessions.delete(message.sessionId);
        return { kind: "sessionClosed", sessionId: message.sessionId };
      default:
        throw new Error(`Unexpected request: ${message.kind}`);
    }
  });
  const replayed = (): TransformStep[] =>
    requests.flatMap((message) => (message.kind === "previewStep" ? [message.step] : []));
  const opens = () => requests.filter((message) => message.kind === "openSession");
  return { delegate: { request, onIdle: vi.fn() }, requests, sessions, replayed, opens };
}

function memento(): Memento & { stored: Record<string, unknown> } {
  const state = { stored: {} as Record<string, unknown> };
  return Object.assign(state, {
    get: (key: string, fallback?: unknown) => (key === SESSION_STORAGE_KEY ? state.stored : fallback),
    update: async (key: string, value: unknown) => {
      if (key === SESSION_STORAGE_KEY) state.stored = value as Record<string, unknown>;
    },
    keys: () => [SESSION_STORAGE_KEY]
  }) as unknown as Memento & { stored: Record<string, unknown> };
}

describe("SessionCoordinator file engine switching across runtimes", () => {
  it("moves steps between Python and R runtimes by column position and hands the session to the target runtime", async () => {
    const coordinator = new SessionCoordinator(memento());
    const python = fakeRuntime("polars", schema, [appliedStep]);
    const r = fakeRuntime("r", rSchema);
    const pythonBridge = coordinator.createBridge(python.delegate);
    const rBridge = coordinator.createBridge(r.delegate);
    try {
      const opened = await open(pythonBridge, initialSource);
      const publicId = opened.metadata.sessionId;
      await pythonBridge.updateViewState?.(publicId, {
        selectedColumnId: "c:value",
        columnWidths: new Map([["c:value", 245]]),
        viewport: { firstVisibleRow: 0, scrollLeft: 0 }
      });

      const toR = await pythonBridge.reconfigureFileSession!(publicId, opened.metadata.revision, initialSource, {
        backendPreference: "r",
        rLibrary: "dplyr",
        targetBridge: rBridge
      });

      expect(toR).toMatchObject({
        kind: "sessionOpened",
        metadata: { sessionId: publicId, backend: "r", rLibrary: "dplyr", steps: [rStep] }
      });
      expect(r.opens()).toEqual([expect.objectContaining({ backend: "r", rLibrary: "dplyr", source: initialSource })]);
      expect(r.replayed()).toEqual([rStep]);
      expect(coordinator.activeSession()?.viewState).toMatchObject({
        selectedColumnId: "r:c:0",
        columnWidths: new Map([["r:c:0", 245]])
      });
      await vi.waitFor(() => expect(python.sessions.size).toBe(0));
      await vi.waitFor(() => expect(python.delegate.onIdle).toHaveBeenCalled());
      expect(r.delegate.onIdle).not.toHaveBeenCalled();
      expect(rBridge.savedFileWork?.(initialSource, { backend: "polars" })).toEqual({
        steps: [appliedStep],
        draftStep: undefined
      });
      await expect(
        pythonBridge.reconfigureFileSession!(publicId, 1, initialSource, { backendPreference: "polars" })
      ).resolves.toMatchObject({ kind: "error", code: "unknown_session" });
      if (toR.kind !== "sessionOpened") throw new Error("Expected an R session.");

      const back = await rBridge.reconfigureFileSession!(publicId, toR.metadata.revision, initialSource, {
        backendPreference: "polars",
        targetBridge: pythonBridge
      });

      expect(back).toMatchObject({
        kind: "sessionOpened",
        metadata: { sessionId: publicId, backend: "polars", steps: [appliedStep] }
      });
      expect(python.replayed()).toEqual([appliedStep]);
      await vi.waitFor(() => expect(r.sessions.size).toBe(0));
      await vi.waitFor(() => expect(r.delegate.onIdle).toHaveBeenCalled());
    } finally {
      await coordinator.shutdown();
    }
  });

  it("switches R libraries for files in place instead of offering an editing copy", async () => {
    const coordinator = new SessionCoordinator();
    const r = fakeRuntime("r", rSchema, [rStep]);
    const rBridge = coordinator.createBridge(r.delegate);
    try {
      const opened = await rBridge.request({ ...openRequest(initialSource), backend: "r", rLibrary: "base" });
      if (opened.kind !== "sessionOpened") throw new Error("Expected an R file session.");

      expect(rBridge.captureRLibraryCopy?.(opened.metadata.sessionId, opened.metadata.revision)).toMatchObject({
        kind: "error",
        code: "r_library_copy_unavailable"
      });
      const switched = await rBridge.reconfigureFileSession!(
        opened.metadata.sessionId,
        opened.metadata.revision,
        initialSource,
        { backendPreference: "r", rLibrary: "data.table" }
      );

      expect(switched).toMatchObject({
        kind: "sessionOpened",
        metadata: { sessionId: opened.metadata.sessionId, rLibrary: "data.table", steps: [rStep] }
      });
      expect(r.opens().at(-1)).toMatchObject({ backend: "r", rLibrary: "data.table" });
      expect(r.replayed()).toEqual([rStep]);
      expect(coordinator.diagnostics().sessionCount).toBe(1);
    } finally {
      await coordinator.shutdown();
    }
  });

  it("restores the target engine's saved work instead of this session's plan when asked", async () => {
    const workspaceState = memento();
    const coordinator = new SessionCoordinator(workspaceState);
    const python = fakeRuntime("polars", schema, [appliedStep]);
    const r = fakeRuntime("r", rSchema);
    const pythonBridge = coordinator.createBridge(python.delegate);
    const rBridge = coordinator.createBridge(r.delegate);
    try {
      const opened = await open(pythonBridge, initialSource);
      const saved: TransformStep = { id: "saved-floor", kind: "floorNumber", params: { column: rValue } };
      const savedMetadata: SessionMetadata = {
        ...metadataFor({ runtimeId: "saved", source: initialSource, backend: "r", steps: [saved] }),
        rLibrary: "collapse",
        schema: rSchema
      };
      workspaceState.stored = {
        ...workspaceState.stored,
        [persistenceKey(initialSource, "r", "collapse")]: serializePersistedSession(
          persistedSessionState(savedMetadata, coordinator.activeSession()!.viewState)
        )
      };
      expect(pythonBridge.savedFileWork?.(initialSource, { backend: "r", rLibrary: "collapse" })).toEqual({
        steps: [saved],
        draftStep: undefined
      });

      const response = await pythonBridge.reconfigureFileSession!(
        opened.metadata.sessionId,
        opened.metadata.revision,
        initialSource,
        { backendPreference: "r", rLibrary: "collapse", targetBridge: rBridge, plan: "saved" }
      );

      expect(response).toMatchObject({
        kind: "sessionOpened",
        metadata: { backend: "r", rLibrary: "collapse", steps: [saved] }
      });
      expect(r.replayed()).toEqual([saved]);
    } finally {
      await coordinator.shutdown();
    }
  });

  it("reports missing saved work before opening the target runtime", async () => {
    const coordinator = new SessionCoordinator(memento());
    const python = fakeRuntime("polars", schema, [appliedStep]);
    const r = fakeRuntime("r", rSchema);
    const pythonBridge = coordinator.createBridge(python.delegate);
    const rBridge = coordinator.createBridge(r.delegate);
    try {
      const opened = await open(pythonBridge, initialSource);

      const response = await pythonBridge.reconfigureFileSession!(
        opened.metadata.sessionId,
        opened.metadata.revision,
        initialSource,
        { backendPreference: "r", rLibrary: "dplyr", targetBridge: rBridge, plan: "saved" }
      );

      expect(response).toMatchObject({ kind: "error", code: "saved_work_unavailable" });
      expect(r.requests).toEqual([]);
      expect(coordinator.activeSession()?.metadata).toMatchObject({ backend: "polars", steps: [appliedStep] });
      await vi.waitFor(() => expect(r.delegate.onIdle).toHaveBeenCalled());
    } finally {
      await coordinator.shutdown();
    }
  });

  it("replays only the kept prefix of this session's steps", async () => {
    const coordinator = new SessionCoordinator();
    const python = fakeRuntime("polars", schema, [appliedStep]);
    const pythonBridge = coordinator.createBridge(python.delegate);
    try {
      const opened = await open(pythonBridge, initialSource);

      const response = await pythonBridge.reconfigureFileSession!(
        opened.metadata.sessionId,
        opened.metadata.revision,
        initialSource,
        { backendPreference: "pandas", plan: { steps: 0 } }
      );

      expect(response).toMatchObject({ kind: "sessionOpened", metadata: { steps: [] } });
      expect(python.replayed()).toEqual([]);
    } finally {
      await coordinator.shutdown();
    }
  });

  it("keeps the session on its runtime when the target engine reads different column names", async () => {
    const coordinator = new SessionCoordinator();
    const python = fakeRuntime("polars", schema, [appliedStep]);
    const r = fakeRuntime("r", [{ ...rSchema[0]!, name: "Value" }]);
    const pythonBridge = coordinator.createBridge(python.delegate);
    const rBridge = coordinator.createBridge(r.delegate);
    try {
      const opened = await open(pythonBridge, initialSource);

      const response = await pythonBridge.reconfigureFileSession!(
        opened.metadata.sessionId,
        opened.metadata.revision,
        initialSource,
        { backendPreference: "r", rLibrary: "base", targetBridge: rBridge }
      );

      expect(response).toMatchObject({
        kind: "error",
        code: "import_state_replay_failed",
        message: expect.stringContaining("reads this file's columns differently")
      });
      expect(r.replayed()).toEqual([]);
      await vi.waitFor(() => expect(r.sessions.size).toBe(0));
      await vi.waitFor(() => expect(r.delegate.onIdle).toHaveBeenCalled());
      expect(coordinator.activeSession()?.metadata).toMatchObject({ backend: "polars", steps: [appliedStep] });
      await expect(
        pythonBridge.reconfigureFileSession!(opened.metadata.sessionId, opened.metadata.revision, initialSource, {
          backendPreference: "pandas"
        })
      ).resolves.toMatchObject({ kind: "sessionOpened", metadata: { backend: "pandas" } });
    } finally {
      await coordinator.shutdown();
    }
  });
});
