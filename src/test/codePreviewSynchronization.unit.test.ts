import { describe, expect, it } from "vitest";
import {
  CODE_PREVIEW_MAX_CODE_POINTS,
  CODE_PREVIEW_MAX_UTF8_BYTES,
  collectCodePreviewText,
  validateCodePreviewText
} from "../shared/codePreviewLimits";
import {
  CodePreviewEditCoalescer,
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
    expect(coalescer.acceptHostState(7, 0)).toBe(true);

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

    expect(coalescer.acceptHostState(1, 0)).toBe(true);
    coalescer.schedule();
    expect(coalescer.acceptHostState(1, 0)).toBe(false);
    scheduler.advance(100);
    expect(coalescer.hasUnacknowledgedEdit()).toBe(true);
    expect(coalescer.acceptHostState(1, 0)).toBe(false);

    code = `${"é".repeat(CODE_PREVIEW_MAX_UTF8_BYTES / 2)}é`;
    coalescer.schedule();
    scheduler.advance(100);
    expect(messages.at(-1)).toEqual({ kind: "codeInvalid", generation: 1, sequence: 2, reason: "utf8Bytes" });
    expect(coalescer.acceptHostState(1, 1)).toBe(false);
    expect(coalescer.acceptHostState(1, 2)).toBe(true);
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
    expect(coalescer.acceptHostState(3, 1)).toBe(true);
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
    expect(coalescer.acceptHostState(1, 0)).toBe(false);
    scheduler.advance(100);
    expect(messages.at(-1)).toEqual({ kind: "codeChanged", generation: 2, sequence: 1, code: "old" });

    code = "new";
    coalescer.schedule();
    expect(coalescer.acceptHostState(3, 0)).toBe(true);
    scheduler.advance(100);
    expect(messages.at(-1)).not.toMatchObject({ code: "new" });
  });

  it("invalidates pending edits on page disposal and explicitly rejects later snapshots", () => {
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
      { kind: "codePreviewUnavailable", generation: 4, reason: "disposed" },
      { kind: "codeSnapshotUnavailable", generation: 4, requestId: REQUEST_ID, reason: "disposed" }
    ]);
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
