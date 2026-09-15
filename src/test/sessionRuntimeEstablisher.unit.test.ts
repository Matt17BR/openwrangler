import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import type { Memento, NotebookDocument } from "vscode";
import { DetachedBridgeRequestError, type OpenWranglerBridge } from "../extension/dataBridge";
import {
  persistedSessionState,
  persistenceKey,
  serializePersistedSession,
  SESSION_STORAGE_KEY
} from "../extension/sessionPersistence";
import { SessionPersistenceStore } from "../extension/sessionPersistenceStore";
import { SessionRuntimeEstablisher, type RuntimeEstablishmentHooks } from "../extension/sessionRuntimeEstablisher";
import { SessionRuntimeCleanup } from "../extension/sessionRuntimeCleanup";
import { SessionRuntimeStateRestorer } from "../extension/sessionRuntimeStateRestorer";
import * as sessionOrigin from "../extension/sessionOrigin";
import type { OpenWranglerRequest, OpenWranglerResponse, TransformStep } from "../shared/protocol";
import {
  openRequest,
  openedResponse,
  setOpenNotebookDocuments,
  stepPreviewResponse
} from "./sessionCoordinatorTestFixtures";

describe("SessionRuntimeEstablisher", () => {
  it("publishes a public identity while retaining the exact private runtime contract", async () => {
    const runtime = openedResponse("private-runtime");
    const delegate = bridge(async () => runtime);
    const result = await establisher().establish(delegate, openRequest, undefined, undefined, hooks());

    expect(result).toMatchObject({
      established: true,
      response: { kind: "sessionOpened", metadata: { source: openRequest.source } },
      session: {
        runtimeId: "private-runtime",
        runtimeRevision: 0,
        publicRevision: 0,
        openRequest: { backend: "polars", mode: "editing", source: openRequest.source },
        closing: false,
        reconfiguring: false,
        reconnecting: false,
        recoveryRequired: false
      }
    });
    if (!result.established) throw new Error("Expected the runtime to be established.");
    expect(result.response.metadata.sessionId).not.toBe("private-runtime");
    expect(result.session.publicId).toBe(result.response.metadata.sessionId);
  });

  it("closes an initial runtime whose response names a different immutable source before persistence", async () => {
    const workspaceState = {
      get: vi.fn(),
      update: vi.fn(),
      keys: vi.fn(() => [SESSION_STORAGE_KEY])
    } as unknown as Memento;
    const response = openedResponse("wrong-source-runtime");
    const wrongSource = { ...openRequest.source, path: "/workspace/other.csv" };
    const requests: OpenWranglerRequest[] = [];
    const delegate = bridge(async (request): Promise<OpenWranglerResponse> => {
      requests.push(request);
      if (request.kind === "openSession") {
        return { ...response, metadata: { ...response.metadata, source: wrongSource } };
      }
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      throw new Error(`Unexpected source-validation request: ${request.kind}`);
    });

    await expect(
      establisher(workspaceState).establish(delegate, openRequest, undefined, undefined, hooks())
    ).resolves.toMatchObject({
      established: false,
      response: {
        kind: "error",
        code: "invalid_runtime_response",
        message: expect.stringContaining("immutable source")
      }
    });
    expect(requests.map((request) => request.kind)).toEqual(["openSession", "closeSession"]);
    expect(workspaceState.get).not.toHaveBeenCalled();
    expect(workspaceState.update).not.toHaveBeenCalled();
  });

  it.each([
    "newer plan",
    "source replacement",
    "stage failure",
    "final save failure",
    "cancel during choice",
    "cancel before commit",
    "cancel after commit",
    "decline reset",
    "thrown diagnostic",
    "mismatched diagnostic",
    "cancelled diagnostic"
  ] as const)("protects saved cleaning during an explicit recovery: %s", async (outcome) => {
    const directory = await mkdtemp(join(tmpdir(), "openwrangler-saved-recovery-"));
    const sourcePath = join(directory, "source.csv");
    await writeFile(sourcePath, "value\n1\n");
    const request = { ...openRequest, source: { ...openRequest.source, path: sourcePath } };
    const savedStep: TransformStep = {
      id: "saved-step",
      kind: "dropColumns",
      params: { columns: [{ id: "c:source:0", name: "missing" }] }
    };
    const saved = serializePersistedSession(
      persistedSessionState(
        { ...openedResponse().metadata, steps: [savedStep] },
        { columnWidths: new Map(), viewport: { firstVisibleRow: 0, scrollLeft: 0 } }
      )
    );
    if (!saved) throw new Error("Expected valid saved cleaning.");
    const key = persistenceKey(request.source, "polars");
    let stored: Record<string, unknown> = { [key]: saved };
    const cancellation = new vscode.CancellationTokenSource();
    let writes = 0;
    const workspaceState = {
      get: vi.fn((storageKey: string) => (storageKey === SESSION_STORAGE_KEY ? stored : undefined)),
      update: vi.fn(async (_key: string, value: Record<string, unknown>) => {
        writes += 1;
        if (writes === (outcome === "stage failure" ? 1 : outcome === "final save failure" ? 2 : -1)) {
          throw new Error("Recovery storage unavailable.");
        }
        stored = value;
        if (writes === 1 && outcome === "cancel before commit") cancellation.cancel();
        if (writes === 2 && outcome === "cancel after commit") cancellation.cancel();
      }),
      keys: vi.fn(() => [SESSION_STORAGE_KEY])
    } as unknown as Memento;
    let opens = 0;
    const order: string[] = [];
    let orderAtChoice: string[] = [];
    const declinesReset = outcome === "decline reset" || outcome.endsWith("diagnostic");
    const warning = vi
      .spyOn(vscode.window, "showWarningMessage")
      .mockImplementation(async (_message, _options, ...items) => {
        orderAtChoice = [...order];
        if (outcome === "cancel during choice") cancellation.cancel();
        if (outcome === "source replacement") {
          await rename(sourcePath, join(directory, "retained.csv"));
          await writeFile(sourcePath, "replacement\n2\n");
        }
        return declinesReset ? undefined : items[0];
      });
    const delegate = bridge(async (next): Promise<OpenWranglerResponse> => {
      if (next.kind === "openSession") {
        order.push(`open-${++opens}`);
        if (opens === 2 && outcome === "newer plan")
          stored = { [key]: { ...saved, cleaning: { steps: [{ ...savedStep, id: "newer" }] } } };
        const opened = openedResponse(`runtime-${opens}`);
        return { ...opened, metadata: { ...opened.metadata, source: request.source } };
      }
      if (next.kind === "previewStep") {
        order.push("preview-failed");
        if (outcome === "thrown diagnostic") throw new Error("UNTRUSTED_THROWN_CAUSE");
        if (outcome === "cancelled diagnostic")
          return { kind: "cancelled", targetRequestId: "UNTRUSTED_CANCELLED_CAUSE" };
        return {
          kind: "error",
          code: "engine_error",
          message:
            outcome === "mismatched diagnostic" ? "UNTRUSTED_OTHER_SESSION_CAUSE" : "Saved step cannot currently run.",
          detail: "PRIVATE_TRACEBACK",
          recoverable: true,
          sessionId: outcome === "mismatched diagnostic" ? "another-runtime" : next.sessionId
        };
      }
      if (next.kind === "closeSession") {
        order.push(`close-${next.sessionId}`);
        return { kind: "sessionClosed", sessionId: next.sessionId };
      }
      throw new Error(`Unexpected recovery request: ${next.kind}`);
    });
    try {
      const result = await establisher(workspaceState).establish(
        delegate,
        request,
        { cancellation: cancellation.token },
        undefined,
        hooks()
      );
      expect(orderAtChoice).toEqual(["open-1", "preview-failed", "close-runtime-1"]);
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining("replace its saved cleaning plan and draft"),
        { modal: true },
        "Open Original and Reset Plan"
      );
      const warningMessage = warning.mock.calls[0][0];
      if (!outcome.endsWith("diagnostic")) {
        expect(warningMessage).toContain("replay cleaning step 1");
        expect(warningMessage).toContain("Saved step cannot currently run.");
      }
      expect(warningMessage).not.toMatch(/UNTRUSTED_|PRIVATE_TRACEBACK/u);
      expect(result).toMatchObject({
        established: false,
        response: outcome.startsWith("cancel ")
          ? { kind: "cancelled" }
          : {
              kind: "error",
              code: outcome.endsWith("failure") ? "persistence_unavailable" : "saved_plan_restore_failed",
              recoverable: true
            }
      });
      if (outcome === "decline reset") {
        expect(result).toMatchObject({
          response: { message: expect.stringContaining("Saved step cannot currently run.") }
        });
      }
      expect(JSON.stringify(result)).not.toMatch(/UNTRUSTED_|PRIVATE_TRACEBACK/u);
      expect(order).toEqual([
        "open-1",
        "preview-failed",
        "close-runtime-1",
        ...(outcome === "cancel during choice" || declinesReset ? [] : ["open-2", "close-runtime-2"])
      ]);
      const expectedSteps =
        outcome === "cancel after commit"
          ? []
          : outcome === "newer plan"
            ? [{ ...savedStep, id: "newer" }]
            : [savedStep];
      expect(new SessionPersistenceStore(workspaceState).load(request.source, "polars")?.cleaning.steps).toEqual(
        expectedSteps
      );
      if (declinesReset || ["newer plan", "source replacement", "cancel during choice"].includes(outcome))
        expect(workspaceState.update).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
      cancellation.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["cleaning", "view"] as const)(
    "waits for detached saved %s before closing its unpublished runtime",
    async (phase) => {
      const step: TransformStep = {
        id: "saved-step",
        kind: "dropColumns",
        params: { columns: [{ id: "c:value", name: "value" }] }
      };
      const persisted = serializePersistedSession(
        persistedSessionState(
          { ...openedResponse().metadata, steps: phase === "cleaning" ? [step] : [] },
          {
            columnWidths: new Map(),
            viewport: { firstVisibleRow: 0, scrollLeft: 0 }
          }
        )
      );
      if (!persisted) throw new Error("Expected saved state to serialize.");
      const stored = { [persistenceKey(openRequest.source, "polars")]: persisted };
      const workspaceState = {
        get: vi.fn((key: string) => (key === SESSION_STORAGE_KEY ? stored : undefined)),
        update: vi.fn(async () => undefined),
        keys: vi.fn(() => [SESSION_STORAGE_KEY])
      } as unknown as Memento;
      let settle!: () => void;
      const settlement = new Promise<void>((resolve) => {
        settle = resolve;
      });
      let settled = false;
      const detached = new DetachedBridgeRequestError(
        "The saved view is still settling.",
        "timeout",
        true,
        settlement.then(() => {
          settled = true;
        })
      );
      const requests: OpenWranglerRequest[] = [];
      const delegate: OpenWranglerBridge = {
        onIdle: vi.fn(),
        request: async (request): Promise<OpenWranglerResponse> => {
          requests.push(request);
          if (request.kind === "openSession") return openedResponse("pending-view-runtime");
          if (request.kind === (phase === "cleaning" ? "previewStep" : "getPage")) throw detached;
          if (request.kind === "closeSession") {
            expect(settled).toBe(true);
            return { kind: "sessionClosed", sessionId: request.sessionId };
          }
          throw new Error(`Unexpected saved-view request: ${request.kind}`);
        }
      };
      const cleanup = new SessionRuntimeCleanup(() => false);
      const owner = new SessionRuntimeEstablisher(
        cleanup,
        new SessionRuntimeStateRestorer(),
        new SessionPersistenceStore(workspaceState)
      );
      try {
        await expect(owner.establish(delegate, openRequest, undefined, undefined, hooks())).resolves.toMatchObject({
          established: false,
          response: {
            kind: "error",
            code: phase === "cleaning" ? "saved_plan_restore_failed" : "saved_view_restore_failed"
          }
        });
        expect(requests.map((request) => request.kind)).toEqual([
          "openSession",
          phase === "cleaning" ? "previewStep" : "getPage"
        ]);
        cleanup.releaseIfIdle(delegate);
        expect(delegate.onIdle).not.toHaveBeenCalled();
        expect(workspaceState.update).not.toHaveBeenCalled();
        settle();
        await cleanup.waitForTracked();
        expect(requests).toHaveLength(3);
        expect(requests[2]).toEqual({ kind: "closeSession", sessionId: "pending-view-runtime", revision: 0 });
        expect(delegate.onIdle).toHaveBeenCalledOnce();
      } finally {
        settle();
        await cleanup.waitForTracked();
      }
    }
  );

  it.each([
    ["shutdown", "cleaning"],
    ["cancellation", "cleaning"],
    ["file cancellation", "cleaning"],
    ["origin", "cleaning"],
    ["shutdown", "view"],
    ["cancellation", "view"],
    ["origin", "view"]
  ] as const)("stops on %s during saved %s without reopening or falling back", async (retirement, phase) => {
    const document = { uri: vscode.Uri.parse("untitled:restore.ipynb"), isClosed: false } as NotebookDocument;
    setOpenNotebookDocuments(document);
    const file = retirement === "file cancellation";
    const cancelled = file || retirement === "cancellation";
    const source = file
      ? openRequest.source
      : { kind: "notebookVariable" as const, uri: document.uri.toString(), variableName: "df", label: "df" };
    const request = { ...openRequest, source };
    const opened = openedResponse();
    opened.metadata.source = source;
    const step: TransformStep = {
      id: "saved-step",
      kind: "dropColumns",
      params: { columns: [{ id: "c:value", name: "value" }] }
    };
    const persisted = serializePersistedSession(
      persistedSessionState(
        { ...opened.metadata, steps: phase === "cleaning" ? [step, { ...step, id: "second" }] : [] },
        { columnWidths: new Map(), viewport: { firstVisibleRow: 0, scrollLeft: 0 } }
      )
    );
    if (!persisted) throw new Error("Expected saved state to serialize.");
    const stored = { [persistenceKey(source, "polars")]: persisted };
    const workspaceState = {
      get: vi.fn((key: string) => (key === SESSION_STORAGE_KEY ? stored : undefined)),
      update: vi.fn(async () => undefined),
      keys: () => [SESSION_STORAGE_KEY]
    } as unknown as Memento;
    let available = true;
    const cancellation = new vscode.CancellationTokenSource();
    const warning = vi.spyOn(vscode.window, "showWarningMessage");
    const captureSource = vi.spyOn(sessionOrigin, "captureSessionSourceFiles");
    const requests: OpenWranglerRequest["kind"][] = [];
    const delegate = bridge(async (next): Promise<OpenWranglerResponse> => {
      requests.push(next.kind);
      if (next.kind === "openSession") return opened;
      if (next.kind === "closeSession") return { kind: "sessionClosed", sessionId: next.sessionId };
      if (retirement === "shutdown") available = false;
      else if (cancelled) cancellation.cancel();
      else setOpenNotebookDocuments();
      if (next.kind === "previewStep") {
        const preview = stepPreviewResponse(1, step);
        return { ...preview, metadata: { ...preview.metadata, source }, page: { ...preview.page, limit: next.limit } };
      }
      return { kind: "error", code: "engine_error", message: "The saved view is stale.", recoverable: true };
    });
    try {
      const result = await establisher(workspaceState).establish(
        delegate,
        request,
        { cancellation: cancellation.token },
        file ? undefined : { kind: "notebook", document },
        { ...hooks(), isCoordinatorAvailable: () => available }
      );
      expect(result).toMatchObject({
        established: false,
        response: cancelled
          ? { kind: "cancelled" }
          : { kind: "error", code: retirement === "shutdown" ? "coordinator_disposed" : "invalid_source_origin" }
      });
      expect(requests).toEqual(["openSession", phase === "cleaning" ? "previewStep" : "getPage", "closeSession"]);
      expect(workspaceState.update).not.toHaveBeenCalled();
      expect(warning).not.toHaveBeenCalled();
      expect(captureSource).toHaveBeenCalledOnce();
    } finally {
      captureSource.mockRestore();
      warning.mockRestore();
      cancellation.dispose();
      setOpenNotebookDocuments();
    }
  });

  it("does not dispatch an opening after its coordinator has already shut down", async () => {
    const request = vi.fn(async () => openedResponse());
    const result = await establisher().establish({ request }, openRequest, undefined, undefined, hooks(false));
    expect(result).toMatchObject({ established: false, response: { kind: "error", code: "coordinator_disposed" } });
    expect(request).not.toHaveBeenCalled();
  });

  it("closes an established runtime that cannot be published", async () => {
    let available = true;
    const requestKinds: OpenWranglerRequest["kind"][] = [];
    const delegate = bridge(async (request): Promise<OpenWranglerResponse> => {
      requestKinds.push(request.kind);
      if (request.kind === "openSession") {
        available = false;
        return openedResponse("late-runtime");
      }
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      throw new Error(`Unexpected late establishment request: ${request.kind}`);
    });

    const result = await establisher().establish(delegate, openRequest, undefined, undefined, {
      ...hooks(),
      isCoordinatorAvailable: () => available
    });

    expect(result).toMatchObject({ established: false, response: { kind: "error", code: "coordinator_disposed" } });
    expect(requestKinds).toEqual(["openSession", "closeSession"]);
  });
});

function establisher(workspaceState?: Memento): SessionRuntimeEstablisher {
  return new SessionRuntimeEstablisher(
    new SessionRuntimeCleanup(() => true),
    new SessionRuntimeStateRestorer(),
    new SessionPersistenceStore(workspaceState)
  );
}

function hooks(available = true): RuntimeEstablishmentHooks {
  return {
    isCoordinatorAvailable: () => available,
    executeSessionRequest: vi.fn(async () => {
      throw new Error("The establishment tests do not dispatch session-bound work.");
    })
  };
}

function bridge(request: OpenWranglerBridge["request"]): OpenWranglerBridge {
  return { request };
}
