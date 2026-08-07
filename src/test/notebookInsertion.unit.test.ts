import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotebookDocument } from "vscode";

interface CapturedCellData {
  readonly kind: number;
  readonly value: string;
  readonly languageId: string;
  metadata: Record<string, unknown>;
}

interface CapturedCellEdit {
  readonly index: number;
  readonly newCells: CapturedCellData[];
}

interface FakeCell {
  readonly kind: number;
  readonly document: { readonly languageId: string; getText(): string };
  readonly metadata: Record<string, unknown>;
}

interface FakeNotebook {
  readonly uri: { toString(): string };
  version: number;
  isClosed: boolean;
  readonly cellCount: number;
  readonly cells: FakeCell[];
  cellAt(index: number): FakeCell;
}

const insertionMocks = vi.hoisted(() => ({
  notebookDocuments: [] as unknown[],
  notebookChangeListeners: new Set<(event: { notebook: unknown }) => void>(),
  notebookOpenListeners: new Set<(notebook: unknown) => void>(),
  notebookCloseListeners: new Set<(notebook: unknown) => void>(),
  applyEdit: vi.fn<() => Promise<boolean>>(),
  onSet: undefined as (() => void) | undefined,
  capturedEdit: undefined as CapturedCellEdit | undefined
}));

vi.mock("vscode", () => {
  class NotebookCellData {
    metadata: Record<string, unknown> = {};
    constructor(
      readonly kind: number,
      readonly value: string,
      readonly languageId: string
    ) {}
  }

  class WorkspaceEdit {
    set(_uri: unknown, edits: CapturedCellEdit[]): void {
      insertionMocks.capturedEdit = edits[0];
      insertionMocks.onSet?.();
    }
  }

  return {
    NotebookCellKind: { Code: 2 },
    NotebookCellData,
    NotebookEdit: {
      insertCells: (index: number, newCells: CapturedCellData[]): CapturedCellEdit => ({ index, newCells })
    },
    WorkspaceEdit,
    workspace: {
      get notebookDocuments() {
        return insertionMocks.notebookDocuments;
      },
      onDidChangeNotebookDocument: (listener: (event: { notebook: unknown }) => void) => {
        insertionMocks.notebookChangeListeners.add(listener);
        return { dispose: () => insertionMocks.notebookChangeListeners.delete(listener) };
      },
      onDidOpenNotebookDocument: (listener: (notebook: unknown) => void) => {
        insertionMocks.notebookOpenListeners.add(listener);
        return { dispose: () => insertionMocks.notebookOpenListeners.delete(listener) };
      },
      onDidCloseNotebookDocument: (listener: (notebook: unknown) => void) => {
        insertionMocks.notebookCloseListeners.add(listener);
        return { dispose: () => insertionMocks.notebookCloseListeners.delete(listener) };
      },
      applyEdit: insertionMocks.applyEdit
    }
  };
});

import { insertGeneratedNotebookCell } from "../extension/notebooks/notebookInsertion";

describe("generated notebook insertion", () => {
  beforeEach(() => {
    insertionMocks.notebookDocuments.length = 0;
    insertionMocks.notebookChangeListeners.clear();
    insertionMocks.notebookOpenListeners.clear();
    insertionMocks.notebookCloseListeners.clear();
    insertionMocks.applyEdit.mockReset();
    insertionMocks.onSet = undefined;
    insertionMocks.capturedEdit = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports applied only after the exact document contains the marked generated cell", async () => {
    const notebook = fakeNotebook("file:///workspace/origin.ipynb");
    insertionMocks.notebookDocuments.push(notebook);
    insertionMocks.applyEdit.mockImplementationOnce(async () => {
      applyCapturedEdit(notebook);
      return true;
    });

    await expect(insert(notebook)).resolves.toEqual({ status: "applied" });

    expect(notebook.version).toBe(2);
    expect(notebook.cellCount).toBe(1);
    expect(notebook.cellAt(0).metadata.openWrangler).toEqual({
      source: "frame",
      backend: "polars",
      languageId: "python",
      generated: true,
      insertionId: expect.any(String)
    });
    expect(notebook.cellAt(0).document.languageId).toBe("python");
  });

  it("inserts and proves an R cell with an R-specific marker", async () => {
    const notebook = fakeNotebook("file:///workspace/origin.ipynb");
    insertionMocks.notebookDocuments.push(notebook);
    insertionMocks.applyEdit.mockImplementationOnce(async () => {
      applyCapturedEdit(notebook);
      return true;
    });

    await expect(insertR(notebook)).resolves.toEqual({ status: "applied" });

    expect(notebook.cellAt(0).document.languageId).toBe("r");
    expect(notebook.cellAt(0).document.getText()).toBe("open_wrangler_result <- frame\n");
    expect(notebook.cellAt(0).metadata.openWrangler).toEqual({
      source: "frame",
      backend: "r",
      languageId: "r",
      generated: true,
      insertionId: expect.any(String)
    });
  });

  it("does not prove an insertion whose resulting cell has a different language", async () => {
    vi.useFakeTimers();
    const notebook = fakeNotebook("file:///workspace/origin.ipynb");
    insertionMocks.notebookDocuments.push(notebook);
    insertionMocks.applyEdit.mockImplementationOnce(async () => {
      applyCapturedEdit(notebook, "python");
      fireNotebookChange(notebook);
      return true;
    });

    const pending = insertR(notebook);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(pending).resolves.toEqual({ status: "indeterminate" });
    expect(insertionMocks.applyEdit).toHaveBeenCalledOnce();
    expect(notebook.cellCount).toBe(1);
  });

  it("rejects unsupported cell languages before building or dispatching an edit", async () => {
    const notebook = fakeNotebook("file:///workspace/origin.ipynb");
    insertionMocks.notebookDocuments.push(notebook);

    await expect(
      insertGeneratedNotebookCell(notebook as unknown as NotebookDocument, 0, "1 + 1\n", {
        source: "frame",
        backend: "r",
        languageId: "julia" as never
      })
    ).rejects.toThrow("support only Python or R");

    expect(insertionMocks.capturedEdit).toBeUndefined();
    expect(insertionMocks.applyEdit).not.toHaveBeenCalled();
  });

  it("proves an exact insertion even when applyEdit itself never settles", async () => {
    const notebook = fakeNotebook("file:///workspace/origin.ipynb");
    insertionMocks.notebookDocuments.push(notebook);
    insertionMocks.applyEdit.mockImplementationOnce(() => {
      applyCapturedEdit(notebook);
      fireNotebookChange(notebook);
      return new Promise<boolean>(() => undefined);
    });

    await expect(insert(notebook)).resolves.toEqual({ status: "applied" });

    expect(insertionMocks.applyEdit).toHaveBeenCalledOnce();
    expect(insertionMocks.notebookChangeListeners.size).toBe(0);
    expect(insertionMocks.notebookOpenListeners.size).toBe(0);
    expect(insertionMocks.notebookCloseListeners.size).toBe(0);
  });

  it("bounds a never-settling edit without retrying or reporting success", async () => {
    vi.useFakeTimers();
    const notebook = fakeNotebook("file:///workspace/origin.ipynb");
    insertionMocks.notebookDocuments.push(notebook);
    insertionMocks.applyEdit.mockImplementationOnce(() => new Promise<boolean>(() => undefined));

    const pending = insert(notebook);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(pending).resolves.toEqual({ status: "indeterminate" });
    expect(insertionMocks.applyEdit).toHaveBeenCalledOnce();
    expect(notebook.cellCount).toBe(0);
    expect(insertionMocks.notebookChangeListeners.size).toBe(0);
  });

  it("does not dispatch a queued duplicate after the first edit becomes indeterminate", async () => {
    vi.useFakeTimers();
    const notebook = fakeNotebook("file:///workspace/origin.ipynb");
    insertionMocks.notebookDocuments.push(notebook);
    insertionMocks.applyEdit.mockImplementationOnce(() => new Promise<boolean>(() => undefined));

    const first = insert(notebook);
    const queued = insert(notebook);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(first).resolves.toEqual({ status: "indeterminate" });
    await expect(queued).resolves.toEqual({ status: "indeterminate" });
    expect(insertionMocks.applyEdit).toHaveBeenCalledOnce();
  });

  it("bounds an accepted edit that never publishes exact-document proof", async () => {
    vi.useFakeTimers();
    const notebook = fakeNotebook("file:///workspace/origin.ipynb");
    insertionMocks.notebookDocuments.push(notebook);
    insertionMocks.applyEdit.mockResolvedValueOnce(true);

    const pending = insert(notebook);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(pending).resolves.toEqual({ status: "indeterminate" });
    expect(insertionMocks.applyEdit).toHaveBeenCalledOnce();
    expect(notebook.cellCount).toBe(0);
  });

  it("does not accept duplicate UUID markers as exact-document proof", async () => {
    vi.useFakeTimers();
    const notebook = fakeNotebook("file:///workspace/origin.ipynb");
    insertionMocks.notebookDocuments.push(notebook);
    insertionMocks.applyEdit.mockImplementationOnce(async () => {
      applyCapturedEdit(notebook);
      applyCapturedEdit(notebook);
      fireNotebookChange(notebook);
      return true;
    });

    const pending = insert(notebook);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(pending).resolves.toEqual({ status: "indeterminate" });
    expect(insertionMocks.applyEdit).toHaveBeenCalledOnce();
    expect(notebook.cellCount).toBe(2);
  });

  it("fails stale when the exact document is replaced while the edit is being built", async () => {
    const origin = fakeNotebook("file:///workspace/shared.ipynb");
    const replacement = fakeNotebook("file:///workspace/shared.ipynb");
    insertionMocks.notebookDocuments.push(origin);
    insertionMocks.onSet = () => {
      origin.isClosed = true;
      insertionMocks.notebookDocuments.splice(0, 1, replacement);
    };

    await expect(insert(origin)).resolves.toEqual({ status: "stale" });

    expect(insertionMocks.applyEdit).not.toHaveBeenCalled();
    expect(replacement.cellCount).toBe(0);
  });

  it("fails stale when a different open document has the same URI", async () => {
    const origin = fakeNotebook("file:///workspace/shared.ipynb");
    const duplicate = fakeNotebook("file:///workspace/shared.ipynb");
    insertionMocks.notebookDocuments.push(origin, duplicate);

    await expect(insert(origin)).resolves.toEqual({ status: "stale" });

    expect(insertionMocks.applyEdit).not.toHaveBeenCalled();
    expect(origin.cellCount).toBe(0);
    expect(duplicate.cellCount).toBe(0);
  });

  it("reports an explicit false VS Code edit as rejected", async () => {
    const rejected = fakeNotebook("file:///workspace/rejected.ipynb");
    insertionMocks.notebookDocuments.push(rejected);
    insertionMocks.applyEdit.mockResolvedValueOnce(false);
    await expect(insert(rejected)).resolves.toEqual({ status: "rejected" });
  });

  it("reports an asynchronous applyEdit failure as indeterminate", async () => {
    const failed = fakeNotebook("file:///workspace/failed.ipynb");
    insertionMocks.notebookDocuments.push(failed);
    insertionMocks.applyEdit.mockRejectedValueOnce(new Error("transport failed"));
    await expect(insert(failed)).resolves.toEqual({ status: "indeterminate" });
  });

  it("reports indeterminate without retry or rollback when URI resolution reaches a replacement", async () => {
    const origin = fakeNotebook("file:///workspace/shared.ipynb");
    const replacement = fakeNotebook("file:///workspace/shared.ipynb");
    insertionMocks.notebookDocuments.push(origin);
    insertionMocks.applyEdit.mockImplementationOnce(async () => {
      origin.isClosed = true;
      insertionMocks.notebookDocuments.splice(0, 1, replacement);
      fireNotebookClose(origin);
      fireNotebookOpen(replacement);
      applyCapturedEdit(replacement);
      fireNotebookChange(replacement);
      return true;
    });

    await expect(insert(origin)).resolves.toEqual({ status: "indeterminate" });

    // Stable VS Code notebook edits are URI-addressed, so the helper can detect but cannot
    // safely compensate for this post-dispatch race. It must never issue a second edit.
    expect(replacement.cellCount).toBe(1);
    expect(insertionMocks.applyEdit).toHaveBeenCalledOnce();
  });

  it("uses the unique marker as proof across a concurrent notebook metadata change", async () => {
    const notebook = fakeNotebook("file:///workspace/origin.ipynb");
    insertionMocks.notebookDocuments.push(notebook);
    insertionMocks.applyEdit.mockImplementationOnce(async () => {
      notebook.version += 1;
      fireNotebookChange(notebook);
      applyCapturedEdit(notebook);
      fireNotebookChange(notebook);
      return true;
    });

    await expect(insert(notebook)).resolves.toEqual({ status: "applied" });

    expect(insertionMocks.applyEdit).toHaveBeenCalledOnce();
  });

  it("serializes its own edits and fails a queued stale snapshot without dispatching it", async () => {
    const notebook = fakeNotebook("file:///workspace/origin.ipynb");
    insertionMocks.notebookDocuments.push(notebook);
    insertionMocks.applyEdit.mockImplementationOnce(async () => {
      applyCapturedEdit(notebook);
      return true;
    });

    const first = insert(notebook);
    const queued = insert(notebook);

    await expect(first).resolves.toEqual({ status: "applied" });
    await expect(queued).resolves.toEqual({ status: "stale" });
    expect(insertionMocks.applyEdit).toHaveBeenCalledOnce();
  });
});

function insert(notebook: FakeNotebook) {
  return insertGeneratedNotebookCell(
    notebook as unknown as NotebookDocument,
    0,
    "def clean_data(df):\n    return df\n",
    { source: "frame", backend: "polars", languageId: "python" }
  );
}

function insertR(notebook: FakeNotebook) {
  return insertGeneratedNotebookCell(notebook as unknown as NotebookDocument, 0, "open_wrangler_result <- frame\n", {
    source: "frame",
    backend: "r",
    languageId: "r"
  });
}

function fakeNotebook(uri: string): FakeNotebook {
  const cells: FakeCell[] = [];
  return {
    uri: { toString: () => uri },
    version: 1,
    isClosed: false,
    get cellCount() {
      return cells.length;
    },
    cells,
    cellAt(index: number): FakeCell {
      const cell = cells[index];
      if (!cell) throw new Error(`Missing fake cell ${index}.`);
      return cell;
    }
  };
}

function applyCapturedEdit(notebook: FakeNotebook, languageId?: string): void {
  const edit = insertionMocks.capturedEdit;
  if (!edit) throw new Error("No notebook edit was captured.");
  const cells = edit.newCells.map<FakeCell>((cell) => ({
    kind: cell.kind,
    document: {
      languageId: languageId ?? cell.languageId,
      getText: () => cell.value
    },
    metadata: cell.metadata
  }));
  notebook.cells.splice(edit.index, 0, ...cells);
  notebook.version += 1;
}

function fireNotebookChange(notebook: FakeNotebook): void {
  for (const listener of insertionMocks.notebookChangeListeners) listener({ notebook });
}

function fireNotebookOpen(notebook: FakeNotebook): void {
  for (const listener of insertionMocks.notebookOpenListeners) listener(notebook);
}

function fireNotebookClose(notebook: FakeNotebook): void {
  for (const listener of insertionMocks.notebookCloseListeners) listener(notebook);
}
