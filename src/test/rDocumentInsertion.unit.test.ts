import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TextDocument } from "vscode";
import type { TextDocumentSessionOrigin } from "../extension/sessionCoordinator";

interface FakeDocument {
  readonly uri: { readonly fsPath: string; toString(): string };
  readonly eol: number;
  version: number;
  isClosed: boolean;
  text: string;
  getText(): string;
  positionAt(offset: number): { readonly offset: number };
}

interface CapturedInsertion {
  readonly uri: unknown;
  readonly position: { readonly offset: number };
  readonly text: string;
}

const mocks = vi.hoisted(() => ({
  textDocuments: [] as unknown[],
  changeListeners: new Set<(event: { document: unknown }) => void>(),
  openListeners: new Set<(document: unknown) => void>(),
  closeListeners: new Set<(document: unknown) => void>(),
  applyEdit: vi.fn<() => Promise<boolean>>(),
  captured: undefined as CapturedInsertion | undefined,
  onInsert: undefined as (() => void) | undefined
}));

vi.mock("vscode", () => {
  class WorkspaceEdit {
    insert(uri: unknown, position: { readonly offset: number }, text: string): void {
      mocks.captured = { uri, position, text };
      mocks.onInsert?.();
    }
  }
  return {
    EndOfLine: { LF: 1, CRLF: 2 },
    WorkspaceEdit,
    workspace: {
      get textDocuments() {
        return mocks.textDocuments;
      },
      applyEdit: mocks.applyEdit,
      onDidChangeTextDocument: (listener: (event: { document: unknown }) => void) => {
        mocks.changeListeners.add(listener);
        return { dispose: () => mocks.changeListeners.delete(listener) };
      },
      onDidOpenTextDocument: (listener: (document: unknown) => void) => {
        mocks.openListeners.add(listener);
        return { dispose: () => mocks.openListeners.delete(listener) };
      },
      onDidCloseTextDocument: (listener: (document: unknown) => void) => {
        mocks.closeListeners.add(listener);
        return { dispose: () => mocks.closeListeners.delete(listener) };
      }
    }
  };
});

import { insertGeneratedRDocumentCode } from "../extension/r/rDocumentInsertion";

describe("generated R source-document insertion", () => {
  beforeEach(() => {
    mocks.textDocuments.length = 0;
    mocks.changeListeners.clear();
    mocks.openListeners.clear();
    mocks.closeListeners.clear();
    mocks.applyEdit.mockReset();
    mocks.captured = undefined;
    mocks.onInsert = undefined;
  });

  afterEach(() => vi.useRealTimers());

  it("reports success only after the exact source contains the complete generated R", async () => {
    const document = fakeDocument("file:///workspace/orders.R", "orders <- data.frame(id = 1:2)\n");
    mocks.textDocuments.push(document);
    mocks.applyEdit.mockImplementationOnce(async () => {
      applyCapturedInsertion(document);
      fireChange(document);
      return true;
    });

    await expect(insert(origin(document), "open_wrangler_result <- orders\n")).resolves.toEqual({
      status: "applied"
    });

    expect(document.text).toBe("orders <- data.frame(id = 1:2)\n\nopen_wrangler_result <- orders\n");
    expect(mocks.applyEdit).toHaveBeenCalledOnce();
    expect(mocks.changeListeners.size).toBe(0);
  });

  it("keeps CRLF source documents consistent", async () => {
    const document = fakeDocument("file:///workspace/orders.R", "orders <- data.frame(id = 1:2)\r\n", 2);
    mocks.textDocuments.push(document);
    mocks.applyEdit.mockImplementationOnce(async () => {
      applyCapturedInsertion(document);
      fireChange(document);
      return true;
    });

    await expect(insert(origin(document), "first <- orders\nsecond <- first\n")).resolves.toEqual({
      status: "applied"
    });
    expect(document.text).toBe("orders <- data.frame(id = 1:2)\r\n\r\nfirst <- orders\r\nsecond <- first\r\n");
  });

  it("inserts generated R as an executable cell in R Markdown and Quarto", async () => {
    for (const extension of ["Rmd", "qmd"]) {
      const document = fakeDocument(`file:///workspace/orders.${extension}`, "# Orders\n");
      mocks.textDocuments.push(document);
      mocks.applyEdit.mockImplementationOnce(async () => {
        applyCapturedInsertion(document);
        fireChange(document);
        return true;
      });

      await expect(insert(origin(document), "open_wrangler_result <- orders\n")).resolves.toEqual({
        status: "applied"
      });
      expect(document.text).toBe("# Orders\n\n```{r}\nopen_wrangler_result <- orders\n```\n");
      mocks.textDocuments.splice(mocks.textDocuments.indexOf(document), 1);
    }
  });

  it("fails closed before dispatch when the captured source version changed", async () => {
    const document = fakeDocument("file:///workspace/orders.R", "orders <- data.frame(id = 1:2)\n");
    mocks.textDocuments.push(document);
    const captured = origin(document);
    document.version += 1;
    document.text += "# changed\n";

    await expect(insert(captured, "open_wrangler_result <- orders\n")).resolves.toEqual({ status: "stale" });
    expect(mocks.applyEdit).not.toHaveBeenCalled();
  });

  it("fails closed before dispatch when another document owns the same URI", async () => {
    const document = fakeDocument("file:///workspace/orders.R", "orders <- data.frame(id = 1:2)\n");
    const replacement = fakeDocument("file:///workspace/orders.R", "replacement <- TRUE\n");
    mocks.textDocuments.push(document, replacement);

    await expect(insert(origin(document), "open_wrangler_result <- orders\n")).resolves.toEqual({ status: "stale" });
    expect(mocks.applyEdit).not.toHaveBeenCalled();
    expect(replacement.text).toBe("replacement <- TRUE\n");
  });

  it("can prove the exact edit even when applyEdit never settles", async () => {
    const document = fakeDocument("file:///workspace/orders.R", "orders <- data.frame(id = 1:2)\n");
    mocks.textDocuments.push(document);
    mocks.applyEdit.mockImplementationOnce(() => {
      applyCapturedInsertion(document);
      fireChange(document);
      return new Promise<boolean>(() => undefined);
    });

    await expect(insert(origin(document), "open_wrangler_result <- orders\n")).resolves.toEqual({
      status: "applied"
    });
  });

  it("does not claim success for an accepted edit without exact-document proof", async () => {
    vi.useFakeTimers();
    const document = fakeDocument("file:///workspace/orders.R", "orders <- data.frame(id = 1:2)\n");
    mocks.textDocuments.push(document);
    mocks.applyEdit.mockResolvedValueOnce(true);

    const pending = insert(origin(document), "open_wrangler_result <- orders\n");
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(pending).resolves.toEqual({ status: "indeterminate" });
    expect(mocks.applyEdit).toHaveBeenCalledOnce();
  });

  it("does not dispatch a queued duplicate after an indeterminate edit", async () => {
    vi.useFakeTimers();
    const document = fakeDocument("file:///workspace/orders.R", "orders <- data.frame(id = 1:2)\n");
    mocks.textDocuments.push(document);
    mocks.applyEdit.mockImplementationOnce(() => new Promise<boolean>(() => undefined));
    const captured = origin(document);

    const first = insert(captured, "open_wrangler_result <- orders\n");
    const second = insert(captured, "open_wrangler_result <- orders\n");
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(first).resolves.toEqual({ status: "indeterminate" });
    await expect(second).resolves.toEqual({ status: "indeterminate" });
    expect(mocks.applyEdit).toHaveBeenCalledOnce();
  });
});

function insert(originValue: TextDocumentSessionOrigin, code: string) {
  return insertGeneratedRDocumentCode(originValue, code);
}

function origin(document: FakeDocument): TextDocumentSessionOrigin {
  return {
    kind: "textDocument",
    document: document as unknown as TextDocument,
    version: document.version
  };
}

function fakeDocument(uri: string, text: string, eol = 1): FakeDocument {
  const fsPath = new URL(uri).pathname;
  return {
    uri: { fsPath, toString: () => uri },
    eol,
    version: 1,
    isClosed: false,
    text,
    getText() {
      return this.text;
    },
    positionAt(offset: number) {
      return { offset };
    }
  };
}

function applyCapturedInsertion(document: FakeDocument): void {
  const insertion = mocks.captured;
  if (!insertion) throw new Error("No R source insertion was captured.");
  document.text =
    document.text.slice(0, insertion.position.offset) + insertion.text + document.text.slice(insertion.position.offset);
  document.version += 1;
}

function fireChange(document: FakeDocument): void {
  for (const listener of mocks.changeListeners) listener({ document });
}
