import { history, isolateHistory, undo, undoDepth } from "@codemirror/commands";
import { EditorState, StateEffect, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import {
  CODE_PREVIEW_HISTORY_MAX_LOCAL_EDITS,
  CODE_PREVIEW_HISTORY_MAX_RETAINED_UTF8_BYTES,
  CODE_PREVIEW_HISTORY_MAX_VALID_EDIT_TRANSIENT_UTF8_BYTES,
  CODE_PREVIEW_INVALID_PLACEHOLDER,
  CODE_PREVIEW_MAX_CODE_POINTS,
  CODE_PREVIEW_MAX_UTF8_BYTES,
  collectCodePreviewText,
  validateCodePreviewText
} from "../shared/codePreviewLimits";
import {
  CodePreviewEditCoalescer,
  CodePreviewHistoryBudget,
  type CodePreviewEditScheduler,
  type CodePreviewWebviewMessage,
  isCodePreviewHostMessage,
  isCodePreviewWebviewMessage,
  nextCodePreviewGeneration
} from "../shared/codePreviewMessages";

const REQUEST_ID = "00000000-0000-4000-8000-000000000001";

class FakeScheduler implements CodePreviewEditScheduler {
  private now = 0;
  private nextId = 1;
  private readonly pending = new Map<number, { readonly at: number; readonly callback: () => void }>();

  schedule(callback: () => void, delayMs: number): unknown {
    const id = this.nextId;
    this.nextId += 1;
    this.pending.set(id, { at: this.now + delayMs, callback });
    return id;
  }

  cancel(handle: unknown): void {
    if (typeof handle === "number") this.pending.delete(handle);
  }

  advance(milliseconds: number): void {
    const target = this.now + milliseconds;
    while (true) {
      const next = [...this.pending.entries()]
        .filter(([, task]) => task.at <= target)
        .sort(([leftId, left], [rightId, right]) => left.at - right.at || leftId - rightId)[0];
      if (!next) break;
      this.pending.delete(next[0]);
      this.now = next[1].at;
      next[1].callback();
    }
    this.now = target;
  }
}

describe("Code Preview text limits", () => {
  it("accepts exact code-point and UTF-8 boundaries without a second full encoding", () => {
    const exactAscii = "x".repeat(CODE_PREVIEW_MAX_CODE_POINTS);
    expect(validateCodePreviewText(exactAscii)).toEqual({
      valid: true,
      code: exactAscii,
      codePoints: CODE_PREVIEW_MAX_CODE_POINTS,
      utf8Bytes: CODE_PREVIEW_MAX_UTF8_BYTES
    });

    const exactMultibyte = "é".repeat(CODE_PREVIEW_MAX_UTF8_BYTES / 2);
    expect(validateCodePreviewText(exactMultibyte)).toEqual({
      valid: true,
      code: exactMultibyte,
      codePoints: CODE_PREVIEW_MAX_CODE_POINTS / 2,
      utf8Bytes: CODE_PREVIEW_MAX_UTF8_BYTES
    });
  });

  it("fails closed before joining oversized or malformed chunks", () => {
    expect(collectCodePreviewText(["x".repeat(CODE_PREVIEW_MAX_CODE_POINTS), "x"])).toEqual({
      valid: false,
      reason: "codePoints"
    });
    expect(collectCodePreviewText(["é".repeat(CODE_PREVIEW_MAX_UTF8_BYTES / 2), "é"])).toEqual({
      valid: false,
      reason: "utf8Bytes"
    });
    expect(collectCodePreviewText(["\ud83d", "\ude00"])).toEqual({
      valid: true,
      code: "😀",
      codePoints: 1,
      utf8Bytes: 4
    });
    expect(validateCodePreviewText("\ud83d")).toEqual({ valid: false, reason: "invalidUnicode" });
    expect(validateCodePreviewText("\ude00")).toEqual({ valid: false, reason: "invalidUnicode" });
  });

  it("applies the same bound in both protocol directions without echoing rejected text", () => {
    const oversized = `${"é".repeat(CODE_PREVIEW_MAX_UTF8_BYTES / 2)}é`;
    const runtimeIdentity = {
      runtimeLanguage: "python" as const,
      dataframeFlavor: "pandas" as const,
      codeDialect: "python.pandas" as const
    };

    expect(
      isCodePreviewHostMessage({
        kind: "codePreview",
        generation: 1,
        acknowledgedSequence: 0,
        code: oversized,
        editable: true,
        runtimeIdentity
      })
    ).toBe(false);
    expect(isCodePreviewWebviewMessage({ kind: "codeChanged", generation: 1, sequence: 1, code: oversized })).toBe(
      false
    );
    expect(
      isCodePreviewHostMessage({
        kind: "codePreviewInvalid",
        generation: 1,
        acknowledgedSequence: 0,
        reason: "utf8Bytes",
        editable: true,
        runtimeIdentity
      })
    ).toBe(true);
    expect(isCodePreviewWebviewMessage({ kind: "codeInvalid", generation: 1, sequence: 1, reason: "utf8Bytes" })).toBe(
      true
    );
  });
});

describe("Code Preview edit coalescing", () => {
  it("marks a burst pending immediately, then publishes one latest bounded message and one document read", () => {
    const scheduler = new FakeScheduler();
    const messages: CodePreviewWebviewMessage[] = [];
    let reads = 0;
    let code = "initial";
    const coalescer = new CodePreviewEditCoalescer(
      () => {
        reads += 1;
        return validateCodePreviewText(code);
      },
      (message) => messages.push(message),
      scheduler
    );
    expect(coalescer.acceptHostState(7, 0)).toBe("newGeneration");

    for (let index = 0; index < 10_000; index += 1) {
      code = `edit-${index}`;
      coalescer.schedule();
    }
    expect(messages).toEqual([{ kind: "codePending", generation: 7, sequence: 1 }]);
    expect(reads).toBe(0);

    scheduler.advance(100);
    expect(reads).toBe(1);
    expect(messages).toEqual([
      { kind: "codePending", generation: 7, sequence: 1 },
      { kind: "codeChanged", generation: 7, sequence: 1, code: "edit-9999" }
    ]);
  });

  it("bounds sustained edit traffic to the fixed coalescing cadence", () => {
    const scheduler = new FakeScheduler();
    const messages: CodePreviewWebviewMessage[] = [];
    let code = "";
    let reads = 0;
    const coalescer = new CodePreviewEditCoalescer(
      () => {
        reads += 1;
        return validateCodePreviewText(code);
      },
      (message) => messages.push(message),
      scheduler
    );
    coalescer.acceptHostState(1, 0);

    for (let index = 0; index < 1_000; index += 1) {
      code = `sustained-${index}`;
      coalescer.schedule();
      scheduler.advance(1);
    }
    scheduler.advance(100);

    expect(messages.length).toBeLessThanOrEqual(22);
    expect(reads).toBe(messages.filter(({ kind }) => kind === "codeChanged" || kind === "codeInvalid").length);
    expect(messages.at(-1)).toMatchObject({ kind: "codeChanged", code: "sustained-999" });
  });

  it("publishes no raw oversize text and recovers on the next valid edit", () => {
    const scheduler = new FakeScheduler();
    const messages: CodePreviewWebviewMessage[] = [];
    let code = `${"é".repeat(CODE_PREVIEW_MAX_UTF8_BYTES / 2)}é`;
    const coalescer = new CodePreviewEditCoalescer(
      () => validateCodePreviewText(code),
      (message) => messages.push(message),
      scheduler
    );
    coalescer.acceptHostState(2, 0);
    coalescer.schedule();
    scheduler.advance(100);

    expect(messages).toEqual([
      { kind: "codePending", generation: 2, sequence: 1 },
      { kind: "codeInvalid", generation: 2, sequence: 1, reason: "utf8Bytes" }
    ]);
    expect("code" in (messages[1] ?? {})).toBe(false);

    code = "recovered <- true";
    coalescer.schedule();
    scheduler.advance(100);
    expect(messages.at(-1)).toEqual({
      kind: "codeChanged",
      generation: 2,
      sequence: 2,
      code: "recovered <- true"
    });
  });

  it("preserves pending ownership across same-generation host renders and releases it only on acknowledgement", () => {
    const scheduler = new FakeScheduler();
    const messages: CodePreviewWebviewMessage[] = [];
    let code = "valid-local-edit";
    const coalescer = new CodePreviewEditCoalescer(
      () => validateCodePreviewText(code),
      (message) => messages.push(message),
      scheduler
    );

    expect(coalescer.acceptHostState(1, 0)).toBe("newGeneration");
    coalescer.schedule();
    expect(coalescer.acceptHostState(1, 0)).toBe("rejected");
    scheduler.advance(100);
    expect(coalescer.hasUnacknowledgedEdit()).toBe(true);
    expect(coalescer.acceptHostState(1, 0)).toBe("rejected");

    code = `${"é".repeat(CODE_PREVIEW_MAX_UTF8_BYTES / 2)}é`;
    coalescer.schedule();
    scheduler.advance(100);
    expect(messages.at(-1)).toEqual({ kind: "codeInvalid", generation: 1, sequence: 2, reason: "utf8Bytes" });
    expect(coalescer.acceptHostState(1, 1)).toBe("rejected");
    expect(coalescer.acceptHostState(1, 2)).toBe("sameGeneration");
    expect(coalescer.hasUnacknowledgedEdit()).toBe(false);
  });

  it("answers an action snapshot from the latest pending document and cancels the delayed duplicate", () => {
    const scheduler = new FakeScheduler();
    const messages: CodePreviewWebviewMessage[] = [];
    let code = "initial";
    let reads = 0;
    const coalescer = new CodePreviewEditCoalescer(
      () => {
        reads += 1;
        return validateCodePreviewText(code);
      },
      (message) => messages.push(message),
      scheduler
    );
    coalescer.acceptHostState(3, 0);
    code = "latest unsent edit";
    coalescer.schedule();

    coalescer.respondToSnapshotRequest(3, REQUEST_ID);
    scheduler.advance(200);

    expect(reads).toBe(1);
    expect(messages).toEqual([
      { kind: "codePending", generation: 3, sequence: 1 },
      {
        kind: "codeSnapshot",
        generation: 3,
        sequence: 1,
        requestId: REQUEST_ID,
        code: "latest unsent edit"
      }
    ]);
    expect(coalescer.hasUnacknowledgedEdit()).toBe(true);
    expect(coalescer.acceptHostState(3, 1)).toBe("sameGeneration");
  });

  it("distinguishes an accepted invalid placeholder from a newer local document before its marker arrives", () => {
    const scheduler = new FakeScheduler();
    const messages: CodePreviewWebviewMessage[] = [];
    const code = "recovered locally";
    let reads = 0;
    const coalescer = new CodePreviewEditCoalescer(
      () => {
        reads += 1;
        return validateCodePreviewText(code);
      },
      (message) => messages.push(message),
      scheduler
    );

    expect(coalescer.acceptHostState(6, 0, "invalidUnicode")).toBe("newGeneration");
    coalescer.respondToSnapshotRequest(6, REQUEST_ID);
    expect(reads).toBe(0);
    expect(messages).toEqual([
      {
        kind: "codeSnapshotInvalid",
        generation: 6,
        sequence: 0,
        requestId: REQUEST_ID,
        reason: "invalidUnicode"
      }
    ]);

    coalescer.schedule();
    coalescer.respondToSnapshotRequest(6, "00000000-0000-4000-8000-000000000002");
    expect(reads).toBe(1);
    expect(messages.at(-1)).toEqual({
      kind: "codeSnapshot",
      generation: 6,
      sequence: 1,
      requestId: "00000000-0000-4000-8000-000000000002",
      code
    });
  });

  it("does not let delayed lower generations roll the document back", () => {
    const scheduler = new FakeScheduler();
    const messages: CodePreviewWebviewMessage[] = [];
    let code = "old";
    const coalescer = new CodePreviewEditCoalescer(
      () => validateCodePreviewText(code),
      (message) => messages.push(message),
      scheduler
    );
    coalescer.acceptHostState(2, 0);
    coalescer.schedule();
    expect(coalescer.acceptHostState(1, 0)).toBe("rejected");
    scheduler.advance(100);
    expect(messages.at(-1)).toEqual({ kind: "codeChanged", generation: 2, sequence: 1, code: "old" });

    code = "new";
    coalescer.schedule();
    expect(coalescer.acceptHostState(3, 0)).toBe("newGeneration");
    scheduler.advance(100);
    expect(messages.at(-1)).not.toMatchObject({ code: "new" });
  });

  it("publishes the final valid edit before page disposal and explicitly rejects later snapshots", () => {
    const scheduler = new FakeScheduler();
    const messages: CodePreviewWebviewMessage[] = [];
    const coalescer = new CodePreviewEditCoalescer(
      () => validateCodePreviewText("latest"),
      (message) => messages.push(message),
      scheduler
    );
    coalescer.acceptHostState(4, 0);
    coalescer.schedule();
    coalescer.dispose();
    scheduler.advance(200);
    coalescer.respondToSnapshotRequest(4, REQUEST_ID);

    expect(messages).toEqual([
      { kind: "codePending", generation: 4, sequence: 1 },
      { kind: "codeChanged", generation: 4, sequence: 1, code: "latest" },
      { kind: "codePreviewUnavailable", generation: 4, reason: "disposed" },
      { kind: "codeSnapshotUnavailable", generation: 4, requestId: REQUEST_ID, reason: "disposed" }
    ]);
  });

  it("publishes a final invalid edit without its text before page disposal and never publishes it late", () => {
    const scheduler = new FakeScheduler();
    const messages: CodePreviewWebviewMessage[] = [];
    const coalescer = new CodePreviewEditCoalescer(
      () => ({ valid: false, reason: "utf8Bytes" }),
      (message) => messages.push(message),
      scheduler
    );
    coalescer.acceptHostState(5, 0);
    coalescer.schedule();
    coalescer.dispose();
    scheduler.advance(1_000);

    expect(messages).toEqual([
      { kind: "codePending", generation: 5, sequence: 1 },
      { kind: "codeInvalid", generation: 5, sequence: 1, reason: "utf8Bytes" },
      { kind: "codePreviewUnavailable", generation: 5, reason: "disposed" }
    ]);
    expect(messages.some((message) => "code" in message)).toBe(false);
  });

  it("uses monotonic non-reusable generations and fails closed at exhaustion", () => {
    expect(nextCodePreviewGeneration(0)).toEqual({ available: true, generation: 1 });
    expect(nextCodePreviewGeneration(Number.MAX_SAFE_INTEGER - 2)).toEqual({
      available: true,
      generation: Number.MAX_SAFE_INTEGER - 1
    });
    expect(nextCodePreviewGeneration(Number.MAX_SAFE_INTEGER - 1)).toEqual({
      available: false,
      generation: Number.MAX_SAFE_INTEGER
    });
    expect(nextCodePreviewGeneration(Number.MAX_SAFE_INTEGER)).toEqual({
      available: false,
      generation: Number.MAX_SAFE_INTEGER
    });
  });
});

describe("Code Preview undo ownership", () => {
  it("preserves local undo within one generation but cannot resurrect a replaced host generation", () => {
    let state = EditorState.create({ doc: "host generation one", extensions: [history()] });
    const target = {
      get state() {
        return state;
      },
      dispatch(transaction: Transaction) {
        state = transaction.state;
      }
    };

    target.dispatch(state.update({ changes: { from: state.doc.length, insert: " + local edit" } }));
    target.dispatch(state.update({ effects: StateEffect.reconfigure.of([history()]) }));
    expect(undoDepth(state)).toBe(1);
    expect(undo(target)).toBe(true);
    expect(state.doc.toString()).toBe("host generation one");

    target.dispatch(state.update({ changes: { from: state.doc.length, insert: " + stale undo entry" } }));
    expect(undoDepth(state)).toBe(1);
    state = EditorState.create({ doc: "host generation two", extensions: [history()] });
    expect(undoDepth(state)).toBe(0);
    expect(undo(target)).toBe(false);
    expect(state.doc.toString()).toBe("host generation two");
  });

  it("bounds retained undo history by both edit count and charged UTF-8 bytes", () => {
    const countBudget = new CodePreviewHistoryBudget();
    countBudget.acceptGeneration(7);
    countBudget.completeReset();
    for (let index = 0; index < CODE_PREVIEW_HISTORY_MAX_LOCAL_EDITS; index += 1) {
      expect(countBudget.recordEdit(1_024, 1_024)).toBe("retain");
    }
    expect(countBudget.receipt()).toEqual({
      generation: 7,
      localEdits: CODE_PREVIEW_HISTORY_MAX_LOCAL_EDITS,
      retainedUtf8Bytes: CODE_PREVIEW_HISTORY_MAX_LOCAL_EDITS * 2_048,
      resetPending: false
    });
    expect(countBudget.recordEdit(1_024, 1_024)).toBe("reset");
    expect(countBudget.receipt()).toEqual({
      generation: 7,
      localEdits: CODE_PREVIEW_HISTORY_MAX_LOCAL_EDITS,
      retainedUtf8Bytes: CODE_PREVIEW_HISTORY_MAX_LOCAL_EDITS * 2_048,
      resetPending: true
    });
    expect(countBudget.recordEdit(1, 1)).toBe("reset");
    expect(countBudget.receipt().localEdits).toBe(CODE_PREVIEW_HISTORY_MAX_LOCAL_EDITS);
    countBudget.completeReset();
    expect(countBudget.receipt()).toEqual({ generation: 7, localEdits: 0, retainedUtf8Bytes: 0, resetPending: false });

    const byteBudget = new CodePreviewHistoryBudget();
    byteBudget.acceptGeneration(9);
    byteBudget.completeReset();
    for (
      let index = 0;
      index < CODE_PREVIEW_HISTORY_MAX_RETAINED_UTF8_BYTES / CODE_PREVIEW_MAX_UTF8_BYTES / 2;
      index += 1
    ) {
      expect(byteBudget.recordEdit(CODE_PREVIEW_MAX_UTF8_BYTES, CODE_PREVIEW_MAX_UTF8_BYTES)).toBe("retain");
    }
    expect(byteBudget.receipt().retainedUtf8Bytes).toBe(CODE_PREVIEW_HISTORY_MAX_RETAINED_UTF8_BYTES);
    expect(byteBudget.recordEdit(1, 1)).toBe("reset");
    expect(byteBudget.receipt()).toEqual({
      generation: 9,
      localEdits: 2,
      retainedUtf8Bytes: CODE_PREVIEW_HISTORY_MAX_RETAINED_UTF8_BYTES,
      resetPending: true
    });
    expect(byteBudget.recordEdit(64, 64)).toBe("reset");
    expect(byteBudget.receipt().retainedUtf8Bytes).toBe(CODE_PREVIEW_HISTORY_MAX_RETAINED_UTF8_BYTES);
    expect(CODE_PREVIEW_HISTORY_MAX_RETAINED_UTF8_BYTES + CODE_PREVIEW_MAX_UTF8_BYTES * 2).toBe(
      CODE_PREVIEW_HISTORY_MAX_VALID_EDIT_TRANSIENT_UTF8_BYTES
    );

    byteBudget.completeReset();
    expect(byteBudget.recordEdit(64, 64)).toBe("retain");
    expect(byteBudget.recordEdit(64, CODE_PREVIEW_MAX_UTF8_BYTES + 1)).toBe("reset");
    expect(byteBudget.receipt()).toEqual({
      generation: 9,
      localEdits: 1,
      retainedUtf8Bytes: 128,
      resetPending: true
    });

    byteBudget.completeReset();
    byteBudget.recordEdit(64, 64);
    byteBudget.acceptGeneration(10);
    expect(byteBudget.receipt()).toEqual({
      generation: 10,
      localEdits: 1,
      retainedUtf8Bytes: 128,
      resetPending: true
    });
    byteBudget.completeReset();
    expect(byteBudget.receipt()).toEqual({ generation: 10, localEdits: 0, retainedUtf8Bytes: 0, resetPending: false });
  });
});

const TEST_RUNTIME_IDENTITY = {
  runtimeLanguage: "python" as const,
  dataframeFlavor: "pandas" as const,
  codeDialect: "python.pandas" as const
};

async function startProductionCodePreview(code = "host generation one"): Promise<{
  readonly view: EditorView;
  readonly posted: CodePreviewWebviewMessage[];
  send(message: unknown): void;
  dispose(): void;
}> {
  document.body.innerHTML = '<div id="root"></div>';
  const posted: CodePreviewWebviewMessage[] = [];
  vi.stubGlobal("acquireVsCodeApi", () => ({
    postMessage(message: CodePreviewWebviewMessage) {
      posted.push(message);
    }
  }));
  vi.resetModules();
  await import("../webviews/codePreviewMain");
  const element = document.querySelector<HTMLElement>(".cm-editor");
  if (!element) throw new Error("Expected the production Code Preview editor.");
  const view = EditorView.findFromDOM(element);
  if (!view) throw new Error("Expected the production CodeMirror view.");
  const send = (message: unknown): void => {
    window.dispatchEvent(new MessageEvent("message", { data: message, origin: window.location.origin }));
  };
  send({
    kind: "codePreview",
    generation: 1,
    acknowledgedSequence: 0,
    code,
    editable: true,
    runtimeIdentity: TEST_RUNTIME_IDENTITY
  });
  return {
    view,
    posted,
    send,
    dispose() {
      window.dispatchEvent(new Event("pagehide"));
      view.destroy();
      vi.unstubAllGlobals();
      document.body.replaceChildren();
    }
  };
}

describe("production Code Preview lifecycle wiring", () => {
  it("clears actual CodeMirror undo through generation, edit-count, and byte-budget reset paths", async () => {
    vi.useFakeTimers();
    const preview = await startProductionCodePreview();
    try {
      preview.view.dispatch({ changes: { from: preview.view.state.doc.length, insert: " + local" } });
      expect(undoDepth(preview.view.state)).toBeGreaterThan(0);

      preview.send({
        kind: "codePreview",
        generation: 2,
        acknowledgedSequence: 0,
        code: "host generation two",
        editable: true,
        runtimeIdentity: TEST_RUNTIME_IDENTITY
      });
      expect(preview.view.state.doc.toString()).toBe("host generation two");
      expect(undoDepth(preview.view.state)).toBe(0);
      expect(undo(preview.view)).toBe(false);

      for (let index = 0; index <= CODE_PREVIEW_HISTORY_MAX_LOCAL_EDITS; index += 1) {
        preview.view.dispatch({ changes: { from: preview.view.state.doc.length, insert: String(index % 10) } });
      }
      await Promise.resolve();
      expect(undoDepth(preview.view.state)).toBe(0);

      const capScaledDocument = "x".repeat(CODE_PREVIEW_MAX_UTF8_BYTES / 2);
      preview.send({
        kind: "codePreview",
        generation: 3,
        acknowledgedSequence: 0,
        code: capScaledDocument,
        editable: true,
        runtimeIdentity: TEST_RUNTIME_IDENTITY
      });
      for (let index = 0; index < 5; index += 1) {
        preview.view.dispatch({
          changes: { from: 0, to: 1, insert: index % 2 === 0 ? "y" : "x" },
          annotations: isolateHistory.of("full")
        });
      }
      const depthAtOverflow = undoDepth(preview.view.state);
      expect(depthAtOverflow).toBe(5);
      for (let index = 5; index < 12; index += 1) {
        preview.view.dispatch({
          changes: { from: 0, to: 1, insert: index % 2 === 0 ? "y" : "x" },
          annotations: isolateHistory.of("full")
        });
      }
      expect(undoDepth(preview.view.state)).toBe(depthAtOverflow);
      expect(preview.view.state.doc.sliceString(0, 1)).toBe("x");
      await Promise.resolve();
      expect(preview.view.state.doc.length).toBe(CODE_PREVIEW_MAX_UTF8_BYTES / 2);
      expect(preview.view.state.doc.sliceString(0, 1)).toBe("x");
      expect(undoDepth(preview.view.state)).toBe(0);
    } finally {
      preview.dispose();
      vi.useRealTimers();
    }
  });

  it("flushes a final valid document through the actual pagehide listener without a late duplicate", async () => {
    vi.useFakeTimers();
    const preview = await startProductionCodePreview("initial");
    try {
      preview.view.dispatch({ changes: { from: preview.view.state.doc.length, insert: " latest" } });
      window.dispatchEvent(new Event("pagehide"));
      await vi.advanceTimersByTimeAsync(1_000);

      expect(preview.posted.filter(({ kind }) => kind === "codeChanged")).toEqual([
        { kind: "codeChanged", generation: 1, sequence: 1, code: "initial latest" }
      ]);
      expect(preview.posted.filter(({ kind }) => kind === "codePreviewUnavailable")).toEqual([
        { kind: "codePreviewUnavailable", generation: 1, reason: "disposed" }
      ]);
    } finally {
      preview.dispose();
      vi.useRealTimers();
    }
  });

  it("renders malformed Unicode truthfully and flushes a final invalid document without its text", async () => {
    vi.useFakeTimers();
    const preview = await startProductionCodePreview("initial");
    try {
      preview.send({
        kind: "codePreviewInvalid",
        generation: 2,
        acknowledgedSequence: 0,
        reason: "invalidUnicode",
        editable: true,
        runtimeIdentity: TEST_RUNTIME_IDENTITY
      });
      expect(preview.view.state.doc.toString()).toBe(CODE_PREVIEW_INVALID_PLACEHOLDER);

      preview.send({
        kind: "codePreview",
        generation: 3,
        acknowledgedSequence: 0,
        code: "valid before terminal edit",
        editable: true,
        runtimeIdentity: TEST_RUNTIME_IDENTITY
      });
      preview.view.dispatch({
        changes: { from: 0, to: preview.view.state.doc.length, insert: "\ud83d" }
      });
      window.dispatchEvent(new Event("pagehide"));
      await vi.advanceTimersByTimeAsync(1_000);

      expect(preview.posted.filter(({ kind }) => kind === "codeInvalid")).toEqual([
        { kind: "codeInvalid", generation: 3, sequence: 1, reason: "invalidUnicode" }
      ]);
      expect(preview.posted.some((message) => message.kind === "codeChanged" && "code" in message)).toBe(false);
      expect(preview.posted.filter(({ kind }) => kind === "codePreviewUnavailable").at(-1)).toEqual({
        kind: "codePreviewUnavailable",
        generation: 3,
        reason: "disposed"
      });
    } finally {
      preview.dispose();
      vi.useRealTimers();
    }
  });
});
