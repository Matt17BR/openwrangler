import * as vscode from "vscode";
import { describe, expect, it, vi } from "vitest";
import type { GridPage } from "../shared/protocol";
import {
  RKernelDataFrameSession,
  RProviderOperationError,
  type RKernelProviderDispatcher
} from "../extension/r/rKernelDataFrameSession";
import { KernelRequestCancelledError } from "../extension/notebooks/kernelLifecycle";
import type {
  RProviderRequest,
  RProviderResponseEnvelope,
  RProviderSessionIdentity,
  RProviderSessionMetadata
} from "../extension/r/rProviderProtocol";

const metadata: RProviderSessionMetadata = {
  providerProtocolVersion: 2,
  sessionId: "r-session",
  backend: "r",
  mode: "viewing",
  source: { kind: "notebookVariable", label: "orders", variableName: "orders", discoveryId: "d:1:1" },
  sourceClass: "data.frame",
  shape: { rows: 2, columns: 1 },
  schema: [{ id: "r:c:0", name: "count", position: 0, rawType: "integer<integer>", type: "integer", nullable: false }]
};

const initialPage: GridPage = {
  offset: 0,
  limit: 1,
  totalRows: 2,
  columnIds: ["r:c:0"],
  rows: [
    {
      id: "r:row:0",
      rowNumber: 0,
      values: [{ kind: "integer", raw: "1", display: "1", isNull: false, isNaN: false }]
    }
  ]
};

const secondPage: GridPage = {
  offset: 1,
  limit: 1,
  totalRows: 2,
  columnIds: ["r:c:0"],
  rows: [
    {
      id: "r:row:1",
      rowNumber: 1,
      values: [{ kind: "integer", raw: "2", display: "2", isNull: false, isNaN: false }]
    }
  ]
};

describe("native R exact-kernel dataframe session", () => {
  it("adopts a correlated open, pages with confirmed state, and closes at most once", async () => {
    const calls: Array<{ request: RProviderRequest; session?: RProviderSessionIdentity }> = [];
    const transport: RKernelProviderDispatcher = {
      async dispatch(request, _token, session) {
        calls.push({ request, session });
        if (request.kind === "openSession") return envelope({ kind: "sessionOpened", metadata, page: initialPage });
        if (request.kind === "getPage") {
          return envelope({
            kind: "page",
            sessionId: "r-session",
            revision: 0,
            viewRequestId: request.viewRequestId,
            page: secondPage
          });
        }
        if (request.kind === "closeSession") {
          return envelope({ kind: "sessionClosed", sessionId: "r-session" });
        }
        throw new Error(`Unexpected request ${request.kind}`);
      }
    };
    const tokenSource = new vscode.CancellationTokenSource();
    const opened = await RKernelDataFrameSession.open(
      transport,
      { label: "orders", variableName: "orders", discoveryId: "d:1:1", pageSize: 1, columnOffset: 0, columnLimit: 1 },
      tokenSource.token,
      () => "r-session"
    );

    expect(opened.page).toEqual(initialPage);
    expect(opened.session.metadata).toEqual(metadata);
    expect(opened.session.metadata).not.toBe(metadata);
    expect(Object.isFrozen(opened.session.metadata)).toBe(true);
    expect(Object.isFrozen(opened.session.metadata.schema)).toBe(true);
    expect(Object.isFrozen(opened.session.metadata.schema[0])).toBe(true);
    await expect(
      opened.session.getPage(
        { viewRequestId: "view-2", offset: 1, limit: 1, columnOffset: 0, columnLimit: 1 },
        tokenSource.token
      )
    ).resolves.toEqual(secondPage);
    const firstClose = opened.session.close(tokenSource.token);
    const secondClose = opened.session.close(tokenSource.token);
    expect(secondClose).toBe(firstClose);
    await firstClose;
    await expect(
      opened.session.getPage(
        { viewRequestId: "late", offset: 0, limit: 1, columnOffset: 0, columnLimit: 1 },
        tokenSource.token
      )
    ).rejects.toThrow("closing or already closed");

    expect(calls.map(({ request }) => request.kind)).toEqual(["openSession", "getPage", "closeSession"]);
    expect(calls[0]?.request).toMatchObject({
      kind: "openSession",
      source: {
        kind: "notebookVariable",
        variableName: "orders",
        discoveryId: "d:1:1"
      }
    });
    expect(calls[1]?.session).toMatchObject({
      sessionId: "r-session",
      revision: 0,
      shape: metadata.shape,
      schema: metadata.schema
    });
    tokenSource.dispose();
  });

  it("cancels a queued page before terminal close and rejects later pages", async () => {
    const kinds: string[] = [];
    const transport: RKernelProviderDispatcher = {
      async dispatch(request) {
        kinds.push(request.kind);
        if (request.kind === "openSession") return envelope({ kind: "sessionOpened", metadata, page: initialPage });
        if (request.kind === "getPage") throw new Error("A terminally cancelled page must not dispatch.");
        if (request.kind === "closeSession") return envelope({ kind: "sessionClosed", sessionId: "r-session" });
        throw new Error(`Unexpected request ${request.kind}`);
      }
    };
    const tokenSource = new vscode.CancellationTokenSource();
    const { session } = await RKernelDataFrameSession.open(
      transport,
      { label: "orders", variableName: "orders", discoveryId: "d:1:1", pageSize: 1, columnOffset: 0, columnLimit: 1 },
      tokenSource.token,
      () => "r-session"
    );
    const page = session.getPage(
      { viewRequestId: "view-2", offset: 1, limit: 1, columnOffset: 0, columnLimit: 1 },
      tokenSource.token
    );
    const pageCancellation = expect(page).rejects.toBeInstanceOf(KernelRequestCancelledError);
    const close = session.close(tokenSource.token);
    await pageCancellation;
    await expect(close).resolves.toBeUndefined();
    expect(kinds).toEqual(["openSession", "closeSession"]);
    await expect(
      session.getPage(
        { viewRequestId: "late", offset: 0, limit: 1, columnOffset: 0, columnLimit: 1 },
        tokenSource.token
      )
    ).rejects.toThrow("closing or already closed");
    tokenSource.dispose();
  });

  it("times out a never-settling open and closes its host-known candidate with a fresh token", async () => {
    vi.useFakeTimers();
    try {
      const calls: Array<{ request: RProviderRequest; token: vscode.CancellationToken }> = [];
      const transport: RKernelProviderDispatcher = {
        dispatch(request, token) {
          calls.push({ request, token });
          if (request.kind === "openSession") return new Promise<RProviderResponseEnvelope>(() => undefined);
          if (request.kind === "closeSession") {
            return Promise.resolve(
              envelope({ kind: "error", code: "unknown_session", message: "unknown", recoverable: true })
            );
          }
          return Promise.reject(new Error(`Unexpected request ${request.kind}`));
        }
      };
      const tokenSource = new vscode.CancellationTokenSource();
      const opening = RKernelDataFrameSession.open(
        transport,
        { label: "orders", variableName: "orders", discoveryId: "d:1:1", pageSize: 1, columnOffset: 0, columnLimit: 1 },
        tokenSource.token,
        () => "candidate",
        { openMs: 10, failedOpenCleanupMs: 10 }
      );
      const openingFailure = expect(opening).rejects.toThrow("timed out after 10 ms");

      await vi.advanceTimersByTimeAsync(11);
      await openingFailure;
      expect(calls.map(({ request }) => request.kind)).toEqual(["openSession", "closeSession"]);
      expect(calls[0]?.token.isCancellationRequested).toBe(true);
      expect(calls[1]?.token).not.toBe(calls[0]?.token);
      expect(calls[1]?.token.isCancellationRequested).toBe(false);
      tokenSource.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("detaches a never-settling page at its deadline so terminal close can advance safely", async () => {
    vi.useFakeTimers();
    try {
      let resolveLatePage!: (value: RProviderResponseEnvelope) => void;
      const latePage = new Promise<RProviderResponseEnvelope>((resolve) => {
        resolveLatePage = resolve;
      });
      const kinds: string[] = [];
      const transport: RKernelProviderDispatcher = {
        dispatch(request) {
          kinds.push(request.kind);
          if (request.kind === "openSession") {
            return Promise.resolve(envelope({ kind: "sessionOpened", metadata, page: initialPage }));
          }
          if (request.kind === "getPage") return latePage;
          if (request.kind === "closeSession") {
            return Promise.resolve(envelope({ kind: "sessionClosed", sessionId: "r-session" }));
          }
          return Promise.reject(new Error(`Unexpected request ${request.kind}`));
        }
      };
      const tokenSource = new vscode.CancellationTokenSource();
      const { session } = await RKernelDataFrameSession.open(
        transport,
        { label: "orders", variableName: "orders", discoveryId: "d:1:1", pageSize: 1, columnOffset: 0, columnLimit: 1 },
        tokenSource.token,
        () => "r-session",
        { pageMs: 10, closeMs: 10 }
      );
      const page = session.getPage(
        { viewRequestId: "hung-page", offset: 1, limit: 1, columnOffset: 0, columnLimit: 1 },
        tokenSource.token
      );
      const pageFailure = expect(page).rejects.toThrow("timed out after 10 ms");

      await vi.advanceTimersByTimeAsync(11);
      await pageFailure;
      const close = session.close(tokenSource.token);
      await expect(close).resolves.toBeUndefined();
      expect(kinds).toEqual(["openSession", "getPage", "closeSession"]);

      resolveLatePage(
        envelope({
          kind: "page",
          sessionId: "r-session",
          revision: 0,
          viewRequestId: "hung-page",
          page: secondPage
        })
      );
      await Promise.resolve();
      await expect(
        session.getPage(
          { viewRequestId: "after-close", offset: 0, limit: 1, columnOffset: 0, columnLimit: 1 },
          tokenSource.token
        )
      ).rejects.toThrow("closing or already closed");
      tokenSource.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels an active never-settling page before dispatching terminal close", async () => {
    const kinds: string[] = [];
    const transport: RKernelProviderDispatcher = {
      dispatch(request) {
        kinds.push(request.kind);
        if (request.kind === "openSession") {
          return Promise.resolve(envelope({ kind: "sessionOpened", metadata, page: initialPage }));
        }
        if (request.kind === "getPage") return new Promise<RProviderResponseEnvelope>(() => undefined);
        if (request.kind === "closeSession") {
          return Promise.resolve(envelope({ kind: "sessionClosed", sessionId: "r-session" }));
        }
        return Promise.reject(new Error(`Unexpected request ${request.kind}`));
      }
    };
    const tokenSource = new vscode.CancellationTokenSource();
    const { session } = await RKernelDataFrameSession.open(
      transport,
      { label: "orders", variableName: "orders", discoveryId: "d:1:1", pageSize: 1, columnOffset: 0, columnLimit: 1 },
      tokenSource.token,
      () => "r-session"
    );
    const page = session.getPage(
      { viewRequestId: "hung-page", offset: 1, limit: 1, columnOffset: 0, columnLimit: 1 },
      tokenSource.token
    );
    const pageCancellation = expect(page).rejects.toBeInstanceOf(KernelRequestCancelledError);
    await Promise.resolve();
    expect(kinds).toEqual(["openSession", "getPage"]);

    const close = session.close(tokenSource.token);
    await pageCancellation;
    await expect(close).resolves.toBeUndefined();
    expect(kinds).toEqual(["openSession", "getPage", "closeSession"]);
    tokenSource.dispose();
  });

  it("gives terminal close a fresh bounded token even when the caller token is already cancelled", async () => {
    const closeTokens: vscode.CancellationToken[] = [];
    const transport: RKernelProviderDispatcher = {
      async dispatch(request, token) {
        if (request.kind === "openSession") return envelope({ kind: "sessionOpened", metadata, page: initialPage });
        if (request.kind === "closeSession") {
          closeTokens.push(token);
          return envelope({ kind: "sessionClosed", sessionId: "r-session" });
        }
        throw new Error(`Unexpected request ${request.kind}`);
      }
    };
    const tokenSource = new vscode.CancellationTokenSource();
    const { session } = await RKernelDataFrameSession.open(
      transport,
      { label: "orders", variableName: "orders", discoveryId: "d:1:1", pageSize: 1, columnOffset: 0, columnLimit: 1 },
      tokenSource.token,
      () => "r-session"
    );
    tokenSource.cancel();

    await expect(session.close(tokenSource.token)).resolves.toBeUndefined();
    expect(closeTokens).toHaveLength(1);
    expect(closeTokens[0]).not.toBe(tokenSource.token);
    expect(closeTokens[0]?.isCancellationRequested).toBe(false);
    tokenSource.dispose();
  });

  it("bounds a never-settling terminal close without dispatching a second close", async () => {
    vi.useFakeTimers();
    try {
      const closeTokens: vscode.CancellationToken[] = [];
      const transport: RKernelProviderDispatcher = {
        dispatch(request, token) {
          if (request.kind === "openSession") {
            return Promise.resolve(envelope({ kind: "sessionOpened", metadata, page: initialPage }));
          }
          if (request.kind === "closeSession") {
            closeTokens.push(token);
            return new Promise<RProviderResponseEnvelope>(() => undefined);
          }
          return Promise.reject(new Error(`Unexpected request ${request.kind}`));
        }
      };
      const tokenSource = new vscode.CancellationTokenSource();
      const { session } = await RKernelDataFrameSession.open(
        transport,
        { label: "orders", variableName: "orders", discoveryId: "d:1:1", pageSize: 1, columnOffset: 0, columnLimit: 1 },
        tokenSource.token,
        () => "r-session",
        { closeMs: 10 }
      );
      tokenSource.cancel();
      const firstClose = session.close(tokenSource.token);
      const secondClose = session.close(tokenSource.token);
      const closeFailure = expect(firstClose).rejects.toThrow("timed out after 10 ms");

      expect(secondClose).toBe(firstClose);
      await vi.advanceTimersByTimeAsync(11);
      await closeFailure;
      expect(closeTokens).toHaveLength(1);
      expect(closeTokens[0]).not.toBe(tokenSource.token);
      expect(closeTokens[0]?.isCancellationRequested).toBe(true);
      tokenSource.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses a fresh bounded close for the host-known candidate after a failed open", async () => {
    const originalTokenSource = new vscode.CancellationTokenSource();
    const calls: Array<{
      request: RProviderRequest;
      token: vscode.CancellationToken;
      session?: RProviderSessionIdentity;
    }> = [];
    const transport: RKernelProviderDispatcher = {
      async dispatch(request, token, session) {
        calls.push({ request, token, session });
        if (request.kind === "openSession") {
          return envelope({ kind: "error", code: "unsupported_column", message: "unsupported", recoverable: false });
        }
        if (request.kind === "closeSession") {
          return envelope({ kind: "error", code: "unknown_session", message: "unknown", recoverable: true });
        }
        throw new Error(`Unexpected request ${request.kind}`);
      }
    };

    const opening = RKernelDataFrameSession.open(
      transport,
      { label: "orders", variableName: "orders", discoveryId: "d:1:1", pageSize: 1, columnOffset: 0, columnLimit: 1 },
      originalTokenSource.token,
      () => "candidate"
    );
    await expect(opening).rejects.toBeInstanceOf(RProviderOperationError);
    await expect(opening).rejects.toMatchObject({ code: "unsupported_column", recoverable: false });

    expect(calls.map(({ request }) => request.kind)).toEqual(["openSession", "closeSession"]);
    expect(calls[1]?.token).not.toBe(originalTokenSource.token);
    expect(calls[1]?.token.isCancellationRequested).toBe(false);
    expect(calls[1]?.session).toEqual({ sessionId: "candidate", revision: 0 });
    originalTokenSource.dispose();
  });

  it("preserves the original open failure when bounded candidate cleanup also fails", async () => {
    const originalError = new Error("open output was malformed");
    const transport: RKernelProviderDispatcher = {
      async dispatch(request) {
        if (request.kind === "openSession") throw originalError;
        throw new Error("cleanup kernel unavailable");
      }
    };
    const tokenSource = new vscode.CancellationTokenSource();

    await expect(
      RKernelDataFrameSession.open(
        transport,
        { label: "orders", variableName: "orders", discoveryId: "d:1:1", pageSize: 1, columnOffset: 0, columnLimit: 1 },
        tokenSource.token,
        () => "candidate",
        { failedOpenCleanupMs: 10 }
      )
    ).rejects.toBe(originalError);
    tokenSource.dispose();
  });
});

function envelope(response: RProviderResponseEnvelope["response"]): RProviderResponseEnvelope {
  return { protocolVersion: 2, requestId: "validated-by-transport", response };
}
