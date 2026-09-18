import { Writable } from "node:stream";
import { mkdtemp, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DetachedBridgeRequestError } from "../extension/dataBridge";
import { RProcessSessionTransport } from "../extension/r/rProcessTransport";
import { R_KERNEL_TRANSPORT_VERSION, type RKernelRequest } from "../extension/r/rKernelProtocol";

const sessionId = "11111111-1111-4111-8111-111111111111";
const secondSessionId = "22222222-2222-4222-8222-222222222222";
const view = { filters: [], sorts: [] } as const;
const page = { rowOffset: 0, rowLimit: 1, columnOffset: 0, columnLimit: 1, view };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("managed R profile dispatch ownership", () => {
  it("admits a queued page before another dataset-statistics batch", async () => {
    const f = await fixture();
    const work = f.transport.getDatasetStats(sessionId, view);
    const begin = await f.next();
    expect(begin.request.kind).toBe("beginDatasetStats");
    const paging = f.transport.getPage(sessionId, page);
    await begin.pending();
    const read = await f.next();
    expect(read.request.kind).toBe("getPage");
    await read.respond({ kind: "page", sessionId, page: framePage });
    await paging;
    const advance = await f.next();
    expect(advance.request).toMatchObject({
      kind: "continueDatasetStats",
      payload: { sessionId, statsId: begin.request.payload.statsId, revision: 4 }
    });
    await advance.complete();
    await expect(work).resolves.toEqual({ totalRows: 1, stats });
    expect(f.requests.map((request) => request.kind)).toEqual(["beginDatasetStats", "getPage", "continueDatasetStats"]);
  });

  it("keeps two same-session reads independently owned while a page passes between their batches", async () => {
    const f = await fixture();
    const firstWork = f.transport.getDatasetStats(sessionId, view);
    const first = await f.next();
    const secondWork = f.transport.getSummary(sessionId, [{ id: "r:c:0", name: "value" }], view);
    const paging = f.transport.getPage(sessionId, page);
    await first.pending();
    const second = await f.next();
    expect(second.request.kind).toBe("beginSummary");
    expect(second.request.payload.summaryId).not.toBe(first.request.payload.statsId);
    await second.pending();
    const read = await f.next();
    expect(read.request.kind).toBe("getPage");
    await read.respond({ kind: "page", sessionId, page: framePage });
    await paging;
    const statsAdvance = await f.next();
    expect(statsAdvance.request).toMatchObject({
      kind: "continueDatasetStats",
      payload: { statsId: first.request.payload.statsId, revision: 4 }
    });
    await statsAdvance.complete();
    await firstWork;
    const summaryAdvance = await f.next();
    expect(summaryAdvance.request).toMatchObject({
      kind: "continueSummary",
      payload: { summaryId: second.request.payload.summaryId, revision: 4 }
    });
    await summaryAdvance.complete();
    await expect(secondWork).resolves.toEqual([summary]);
    expect(f.requests.some((request) => request.kind.startsWith("close"))).toBe(false);
  });

  it.each(["session", "id", "revision"] as const)(
    "closes only the original summary after a mismatched %s receipt",
    async (mismatch) => {
      const f = await fixture();
      const work = f.transport
        .getSummary(sessionId, [{ id: "r:c:0", name: "value" }], view)
        .catch((error: unknown) => error);
      const begin = await f.next();
      await begin.pending();
      const advance = await f.next();
      await advance.respond({
        kind: "summaryComplete",
        sessionId: mismatch === "session" ? secondSessionId : sessionId,
        summaryId: mismatch === "id" ? secondSessionId : begin.request.payload.summaryId,
        revision: mismatch === "revision" ? 5 : 4,
        summaries: [summary]
      });
      const close = await f.next();
      expect(close.request).toMatchObject({
        kind: "closeSummary",
        payload: { sessionId, summaryId: begin.request.payload.summaryId }
      });
      await close.closed();
      expect(await work).toMatchObject({ message: "The R process returned a mismatched summary continuation." });
      expect(f.requests.filter((request) => request.kind === "closeSummary")).toHaveLength(1);
    }
  );

  it("invalidates and disposes the captured process when a close receipt is unverifiable", async () => {
    const f = await fixture();
    const invalidate = vi.fn();
    f.transport.onDidInvalidateKernel(invalidate);
    const start = vi.spyOn(f.transport as unknown as { ensureStarted(): Promise<unknown> }, "ensureStarted");
    const dispose = vi.spyOn(f.transport, "dispose");
    let current = true;
    const work = f.transport
      .getDatasetStats(sessionId, view, { isCurrentRead: () => current })
      .catch((error: unknown) => error);
    const begin = await f.next();
    current = false;
    await begin.pending();
    const close = await f.next();
    await close.respond({
      kind: "datasetStatsClosed",
      sessionId: secondSessionId,
      statsId: begin.request.payload.statsId
    });
    f.exit();
    const error = await work;
    await (error as DetachedBridgeRequestError).settlement;
    expect(invalidate).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
    expect(f.transport.isSessionMapped(sessionId)).toBe(false);
    expect(f.transport.isSessionMapped(secondSessionId)).toBe(false);
  });

  it("spends the original profile deadline while awaiting exclusive admission without dispatching begin", async () => {
    const f = await fixture();
    const edit = f.transport.undoStep(secondSessionId, 0, page).catch((error: unknown) => error);
    const mutation = await f.next();
    const work = f.transport.getDatasetStats(sessionId, view, { timeoutMs: 10 }).catch((error: unknown) => error);
    const error = await work;
    expect(error).toMatchObject({ reason: "timeout", dispatched: false });
    let settled = false;
    void (error as DetachedBridgeRequestError).settlement.then(() => {
      settled = true;
    });
    await tick();
    expect(settled).toBe(false);
    expect(f.requests).toHaveLength(1);
    await mutation.fail();
    await edit;
    await (error as DetachedBridgeRequestError).settlement;
    expect(f.requests).toHaveLength(1);
  });

  it("keeps script and multi-column summary requests synchronous", async () => {
    const scripted = await fixture(false);
    const scriptWork = scripted.transport.getDatasetStats(sessionId, view);
    const direct = await scripted.next();
    expect(direct.request.kind).toBe("getDatasetStats");
    await direct.respond({ kind: "datasetStats", sessionId, totalRows: 1, stats });
    await scriptWork;
    const managed = await fixture();
    const work = managed.transport.getSummary(
      sessionId,
      [
        { id: "r:c:0", name: "value" },
        { id: "r:c:1", name: "other" }
      ],
      view
    );
    const summary = await managed.next();
    expect(summary.request.kind).toBe("getSummary");
    await summary.fail();
    await expect(work).rejects.toThrow("Controlled native refusal");
  });

  it("closes a cancelled begin after its exact receipt without issuing an advance", async () => {
    const f = await fixture();
    const cancellation = token();
    const work = f.transport.getDatasetStats(sessionId, view, { cancellation }).catch((error: unknown) => error);
    const begin = await f.next();
    cancellation.cancel();
    const error = await work;
    expect(error).toBeInstanceOf(DetachedBridgeRequestError);
    let settled = false;
    void (error as DetachedBridgeRequestError).settlement.then(() => {
      settled = true;
    });
    await tick();
    expect(settled).toBe(false);
    expect(f.requests).toHaveLength(1);
    await begin.pending();
    const close = await f.next();
    expect(close.request).toMatchObject({
      kind: "closeDatasetStats",
      payload: { sessionId, statsId: begin.request.payload.statsId }
    });
    expect(close.request.payload).not.toHaveProperty("revision");
    await close.closed();
    await (error as DetachedBridgeRequestError).settlement;
    expect(f.requests.map((request) => request.kind)).toEqual(["beginDatasetStats", "closeDatasetStats"]);
  });

  it("keeps a cancelled profile cleanup behind a valid page beyond five seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = await fixture();
    const invalidate = vi.fn();
    f.transport.onDidInvalidateKernel(invalidate);
    const realDispose = f.transport.dispose.bind(f.transport);
    const dispose = vi.spyOn(f.transport, "dispose").mockImplementation(async () => {
      f.exit();
      await realDispose();
    });
    const cancellation = token();
    const work = f.transport.getDatasetStats(sessionId, view, { cancellation }).catch((error: unknown) => error);
    const begin = await f.next();
    const paging = f.transport.getPage(secondSessionId, page).catch((error: unknown) => error);
    cancellation.cancel();
    const error = await work;
    expect(error).toBeInstanceOf(DetachedBridgeRequestError);
    let settled = false;
    void (error as DetachedBridgeRequestError).settlement.then(() => {
      settled = true;
    });
    await begin.pending();
    await vi.waitFor(() => expect(f.requests.at(-1)?.kind).toBe("getPage"), { interval: 10 });
    const read = await f.next();
    await vi.advanceTimersByTimeAsync(5_001);
    expect(settled).toBe(false);
    expect(invalidate).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    expect(f.requests.map((request) => request.kind)).toEqual(["beginDatasetStats", "getPage"]);
    await read.respond({ kind: "page", sessionId: secondSessionId, page: framePage });
    await vi.waitFor(() => expect(f.requests.at(-1)?.kind).toBe("closeDatasetStats"), { interval: 10 });
    await expect(paging).resolves.toEqual(framePage);
    const close = await f.next();
    expect(close.request.payload).toEqual({ sessionId, statsId: begin.request.payload.statsId });
    await close.closed();
    await vi.waitFor(() => expect(settled).toBe(true), { interval: 10 });
    expect(invalidate).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    expect(f.transport.isSessionMapped(secondSessionId)).toBe(true);
  });

  it("retires the exact process when a dispatched profile close exceeds five seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = await fixture();
    const invalidate = vi.fn();
    f.transport.onDidInvalidateKernel(invalidate);
    const realDispose = f.transport.dispose.bind(f.transport);
    const dispose = vi.spyOn(f.transport, "dispose").mockImplementation(async () => {
      f.exit();
      await realDispose();
    });
    const cancellation = token();
    const work = f.transport.getDatasetStats(sessionId, view, { cancellation }).catch((error: unknown) => error);
    const begin = await f.next();
    cancellation.cancel();
    const error = await work;
    expect(error).toBeInstanceOf(DetachedBridgeRequestError);
    let settled = false;
    void (error as DetachedBridgeRequestError).settlement.then(() => {
      settled = true;
    });
    await begin.pending();
    await vi.waitFor(() => expect(f.requests.at(-1)?.kind).toBe("closeDatasetStats"), { interval: 10 });
    const close = await f.next();
    expect(close.request.payload).toEqual({ sessionId, statsId: begin.request.payload.statsId });
    await tick();
    expect(invalidate).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(5_001);
    await vi.waitFor(() => expect(settled).toBe(true), { interval: 10 });
    expect(invalidate).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(f.transport.isSessionMapped(sessionId)).toBe(false);
    expect(f.transport.isSessionMapped(secondSessionId)).toBe(false);
  });

  it("checks view ownership after a queued advance waits behind a page", async () => {
    const f = await fixture();
    let current = true;
    const work = f.transport
      .getDatasetStats(sessionId, view, { isCurrentRead: () => current })
      .catch((error: unknown) => error);
    const begin = await f.next();
    const paging = f.transport.getPage(sessionId, page);
    await begin.pending();
    const read = await f.next();
    expect(read.request.kind).toBe("getPage");
    current = false;
    await read.respond({ kind: "page", sessionId, page: framePage });
    await paging;
    const close = await f.next();
    expect(close.request.kind).toBe("closeDatasetStats");
    await close.closed();
    const error = await work;
    expect(error).toBeInstanceOf(DetachedBridgeRequestError);
    await (error as DetachedBridgeRequestError).settlement;
    expect(f.requests.some((request) => request.kind === "continueDatasetStats")).toBe(false);
  });

  it("does not renew the original deadline between batches", async () => {
    let clock = 10;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const f = await fixture();
    const work = f.transport.getDatasetStats(sessionId, view, { timeoutMs: 100 }).catch((error: unknown) => error);
    const begin = await f.next();
    clock += 101;
    await begin.pending();
    const close = await f.next();
    expect(close.request.kind).toBe("closeDatasetStats");
    await close.closed();
    const error = await work;
    expect(error).toMatchObject({ reason: "timeout", dispatched: true });
    await (error as DetachedBridgeRequestError).settlement;
    expect(f.requests).toHaveLength(2);
  });

  it("lets existing reads finish while a cross-panel edit holds later begins and pages", async () => {
    const f = await fixture();
    const firstWork = f.transport.getDatasetStats(sessionId, view);
    const first = await f.next();
    const edit = f.transport.undoStep(secondSessionId, 0, page).catch((error: unknown) => error);
    const laterWork = f.transport.getDatasetStats(secondSessionId, view);
    const paging = f.transport.getPage(sessionId, page);
    await first.pending();
    const advance = await f.next();
    expect(advance.request.kind).toBe("continueDatasetStats");
    await advance.complete();
    await firstWork;
    const mutation = await f.next();
    expect(mutation.request.kind).toBe("undoStep");
    await tick();
    expect(f.requests).toHaveLength(3);
    await mutation.fail();
    expect(await edit).toBeInstanceOf(Error);
    const later = await f.next();
    expect(later.request).toMatchObject({ kind: "beginDatasetStats", payload: { sessionId: secondSessionId } });
    await later.complete();
    await laterWork;
    const read = await f.next();
    expect(read.request.kind).toBe("getPage");
    await read.respond({ kind: "page", sessionId, page: framePage });
    await paging;
  });

  it("does not release exclusive ordering when a later exclusive waiter times out", async () => {
    const f = await fixture();
    const profile = f.transport.getDatasetStats(sessionId, view);
    const begin = await f.next();
    const firstEdit = f.transport.undoStep(secondSessionId, 0, page).catch((error: unknown) => error);
    const timedOutEdit = f.transport
      .discardDraft(secondSessionId, 0, page, { timeoutMs: 0 })
      .catch((error: unknown) => error);
    const paging = f.transport.getPage(sessionId, page);
    expect(await timedOutEdit).toBeInstanceOf(Error);
    await begin.complete();
    await profile;
    const edit = await f.next();
    expect(edit.request.kind).toBe("undoStep");
    await tick();
    expect(f.requests).toHaveLength(2);
    await edit.fail();
    await firstEdit;
    const read = await f.next();
    expect(read.request.kind).toBe("getPage");
    await read.respond({ kind: "page", sessionId, page: framePage });
    await paging;
    expect(f.requests.some((request) => request.kind === "discardDraft")).toBe(false);
  });

  it("allows session close to retire its pending read while another panel has an exclusive waiter", async () => {
    const f = await fixture();
    const work = f.transport.getDatasetStats(sessionId, view).catch((error: unknown) => error);
    const begin = await f.next();
    const editWork = f.transport.undoStep(secondSessionId, 0, page).catch((error: unknown) => error);
    const closing = f.transport.close(sessionId);
    await begin.pending();
    const sessionClose = await f.next();
    expect(sessionClose.request.kind).toBe("closeSession");
    await sessionClose.respond({ kind: "closed", sessionId });
    await closing;
    const cleanup = await f.next();
    expect(cleanup.request.kind).toBe("closeDatasetStats");
    await cleanup.closed();
    expect(await work).toBeInstanceOf(Error);
    const edit = await f.next();
    expect(edit.request.kind).toBe("undoStep");
    await edit.fail();
    await editWork;
  });
});

const stats = {
  missingCells: 0,
  missingRows: 0,
  duplicateRows: 0,
  missingValuesByColumn: [{ column: "value", count: 0 }]
};
const summary = {
  columnId: "r:c:0",
  column: "value",
  type: "integer",
  rawType: "integer",
  totalCount: 1,
  nullCount: 0,
  nanCount: 0,
  distinctCount: 1,
  numeric: {
    min: 1,
    max: 1,
    mean: 1,
    median: 1,
    exactMin: { kind: "integer", raw: 1, display: "1", isNull: false, isNaN: false },
    exactMax: { kind: "integer", raw: 1, display: "1", isNull: false, isNaN: false }
  },
  visualization: { kind: "numeric", bins: [{ min: 1, max: 1, count: 1 }] },
  topValues: [{ value: "1", count: 1 }]
};
const framePage = {
  contractVersion: 7,
  dataframeFlavor: "r.data.frame",
  shape: { rows: 1, columns: 1 },
  frameSemantics: { classes: ["data.frame"], rowNames: "positional", keyColumnIds: [] },
  schema: [
    {
      id: "r:c:0",
      name: "value",
      position: 0,
      rawType: "integer",
      type: "integer",
      nullable: false,
      semantics: { kind: "integer", storageMode: "integer", classes: ["integer"] }
    }
  ],
  page: {
    offset: 0,
    limit: 1,
    totalRows: 1,
    columnOffset: 0,
    columnLimit: 1,
    columnIds: ["r:c:0"],
    rows: [
      { id: "r:r:0", rowNumber: 0, values: [{ kind: "integer", raw: "1", display: "1", isNull: false, isNaN: false }] }
    ]
  }
};

function token() {
  let isCancellationRequested = false;
  const listeners = new Set<() => void>();
  return {
    get isCancellationRequested() {
      return isCancellationRequested;
    },
    onCancellationRequested(listener: () => void) {
      listeners.add(listener);
      return {
        dispose: () => {
          listeners.delete(listener);
        }
      };
    },
    cancel() {
      isCancellationRequested = true;
      for (const listener of listeners) listener();
    }
  };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function fixture(managed = true) {
  const root = await mkdtemp(join(tmpdir(), "ow-profile-mailbox-"));
  const transport = new RProcessSessionTransport({
    runtimeRoot: root,
    rscriptPath: join(root, "Rscript"),
    workingDirectory: root,
    ...(managed
      ? { fileSource: { path: join(root, "source.parquet"), format: "parquet" as const } }
      : { documentText: "data <- data.frame(value = 1L)" })
  });
  const requests: RKernelRequest[] = [];
  type Delivery = ReturnType<typeof deliver>;
  const unread: Delivery[] = [];
  const waiters: ((delivery: Delivery) => void)[] = [];
  function deliver(request: RKernelRequest) {
    const payload: { sessionId: string; statsId?: string; summaryId?: string } = request.payload;
    const respond = async (body: Record<string, unknown>) => {
      const destination = join(root, `${request.requestId}.json`);
      await writeFile(
        `${destination}.tmp`,
        JSON.stringify({ transportVersion: R_KERNEL_TRANSPORT_VERSION, requestId: request.requestId, ...body }),
        { mode: 0o600 }
      );
      await rename(`${destination}.tmp`, destination);
    };
    const isSummary = "summaryId" in payload;
    const identity = {
      sessionId: payload.sessionId,
      ...(isSummary ? { summaryId: payload.summaryId } : { statsId: payload.statsId })
    };
    const prefix = isSummary ? "summary" : "datasetStats";
    return {
      request: request as RKernelRequest & { payload: typeof payload },
      respond,
      pending: () => respond({ kind: `${prefix}Pending`, ...identity, revision: 4 }),
      complete: () =>
        respond({
          kind: `${prefix}Complete`,
          ...identity,
          revision: 4,
          ...(isSummary ? { summaries: [summary] } : { totalRows: 1, stats })
        }),
      closed: () => respond({ kind: `${prefix}Closed`, ...identity }),
      fail: () =>
        respond({ kind: "error", code: "runtime_error", message: "Controlled native refusal", recoverable: false })
    };
  }

  const child = {
    stdin: new Writable({
      write(chunk: Buffer, _encoding, done) {
        const request = JSON.parse(
          chunk.subarray(4).toString("utf8").split("\n").slice(1).join("\n")
        ) as RKernelRequest;
        requests.push(request);
        const delivery = deliver(request);
        const waiter = waiters.shift();
        if (waiter) waiter(delivery);
        else unread.push(delivery);
        done();
      }
    })
  };
  let resolveClosed!: (result: { code: number; signal: null }) => void;
  const owned = {
    child,
    root,
    responseRoot: root,
    exportRoot: root,
    rootCleanupSafe: true,
    closed: new Promise<{ code: number; signal: null }>((resolve) => {
      resolveClosed = resolve;
    }),
    closeState: undefined as { code: number; signal: null } | undefined
  };
  // Inject only an already-started child. Real queue, framing, private mailbox,
  // response validation and cleanup execute unchanged; native startup has its cross-test owner.
  Object.assign(transport, {
    owned,
    startPromise: Promise.resolve({ owned, discovery: { variables: [], truncated: false } }),
    mappedSessions: new Set([sessionId, secondSessionId])
  });
  const exit = () => {
    owned.closeState = { code: 0, signal: null };
    resolveClosed(owned.closeState);
  };
  cleanups.push(async () => {
    exit();
    await (transport as unknown as { queueTail: Promise<void> }).queueTail;
    await transport.dispose();
  });
  return {
    transport,
    requests,
    owned,
    exit,
    next: async () => unread.shift() ?? new Promise<Delivery>((resolve) => waiters.push(resolve))
  };
}
