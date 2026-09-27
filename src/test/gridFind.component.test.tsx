import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CellValue, GridPage, SessionMetadata } from "../shared/protocol";

const postMessage = vi.hoisted(() => vi.fn());
vi.mock("../webviews/vscodeApi", () => ({
  vscode: { postMessage, getState: () => undefined, setState: () => undefined }
}));

import { App } from "../webviews/App";

const metadata: SessionMetadata = {
  protocolVersion: 4,
  sessionId: "session",
  revision: 1,
  backend: "polars",
  mode: "editing",
  source: { kind: "file", label: "cities.csv", path: "cities.csv" },
  capabilities: {
    editable: true,
    lazy: true,
    cancel: true,
    exportCsv: true,
    exportParquet: true,
    notebookInsert: false
  },
  shape: { rows: 3, columns: 3 },
  filteredShape: { rows: 3, columns: 3 },
  filterModel: { filters: [], sort: [] },
  steps: [],
  schema: [
    { id: "c:0", name: "city", position: 0, rawType: "String", type: "string", nullable: false },
    { id: "c:1", name: "country", position: 1, rawType: "String", type: "string", nullable: false },
    { id: "c:2", name: "tags", position: 2, rawType: "List(String)", type: "list", nullable: false }
  ]
};

const page: GridPage = {
  offset: 0,
  limit: 200,
  totalRows: 3,
  columnIds: ["c:0", "c:1", "c:2"],
  rows: [
    { id: "r:0", rowNumber: 0, values: [text("Berlin"), text("Germany"), list(["ber"])] },
    { id: "r:1", rowNumber: 1, values: [text("Bern"), text("Switzerland"), list([])] },
    { id: "r:2", rowNumber: 2, values: [text("Paris"), text("France"), list([])] }
  ]
};

describe("grid Find", () => {
  let hasFocus: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    postMessage.mockClear();
    hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  });
  afterEach(() => hasFocus.mockRestore());

  it("searches the confirmed view from the focused cell and steps through runtime matches", async () => {
    open(metadata);
    expect(fireEvent.keyDown(screen.getByRole("grid"), { key: "f", ctrlKey: true })).toBe(false);
    const input = screen.getByRole("textbox", { name: "Find" });
    expect(input).toHaveFocus();

    fireEvent.change(input, { target: { value: "BER" } });
    fireEvent.keyDown(input, { key: "Enter" });
    const first = latestFind();
    expect(first.message.viewContextId).toMatch(/^snapshot:/u);
    expect(first.request).toEqual({
      kind: "findCells",
      viewRequestId: expect.any(String),
      filterModel: { filters: [], sort: [] },
      query: "BER",
      matchCase: false,
      wholeCell: false,
      direction: "next",
      from: { row: 0, columnId: "c:0" },
      includeFrom: true
    });
    expect(status()).toBe("Searching…");
    expect(findMarks()).toEqual(
      new Map([
        ["Berlin", "match"],
        ["Bern", "match"]
      ])
    );

    await respond(first.request.viewRequestId, 2, { row: 0, columnId: "c:0", ordinal: 1 });
    expect(status()).toBe("1 of 2, row 1, city");
    expect(findMarks()).toEqual(
      new Map([
        ["Berlin", "current"],
        ["Bern", "match"]
      ])
    );

    fireEvent.keyDown(input, { key: "Enter" });
    const second = latestFind().request;
    expect(second).toMatchObject({ direction: "next", from: { row: 0, columnId: "c:0" }, includeFrom: false });
    await respond(second.viewRequestId, 2, { row: 1, columnId: "c:0", ordinal: 2 });
    expect(status()).toBe("2 of 2, row 2, city");
    expect(findMarks().get("Bern")).toBe("current");
    expect(input).toHaveFocus();

    for (const [event, direction] of [
      [{ key: "Enter", shiftKey: true }, "previous"],
      [{ key: "F3" }, "next"],
      [{ key: "F3", shiftKey: true }, "previous"]
    ] as const) {
      fireEvent.keyDown(input, event);
      expect(latestFind().request).toMatchObject({ direction, from: { row: 1, columnId: "c:0" }, includeFrom: false });
    }
  });

  it("applies match options and scope immediately and ignores superseded responses", async () => {
    open(metadata);
    fireEvent.keyDown(screen.getByRole("grid"), { key: "f", ctrlKey: true });
    const input = screen.getByRole("textbox", { name: "Find" });
    fireEvent.change(input, { target: { value: "bern" } });
    fireEvent.keyDown(input, { key: "Enter" });
    const superseded = latestFind().request;

    fireEvent.click(screen.getByRole("button", { name: "Match case" }));
    expect(screen.getByRole("button", { name: "Match case" })).toHaveAttribute("aria-pressed", "true");
    expect(latestFind().request).toMatchObject({ query: "bern", matchCase: true, wholeCell: false, includeFrom: true });
    expect(findMarks()).toEqual(new Map());

    fireEvent.keyDown(input, { key: "w", altKey: true });
    expect(latestFind().request).toMatchObject({ matchCase: true, wholeCell: true });
    fireEvent.keyDown(input, { key: "ç", code: "KeyC", altKey: true });
    expect(latestFind().request).toMatchObject({ matchCase: false, wholeCell: true });
    fireEvent.keyDown(input, { key: "c", altKey: true });
    expect(latestFind().request).toMatchObject({ matchCase: true, wholeCell: true });

    const scope = screen.getByRole("combobox", { name: "Search in" });
    expect(Array.from((scope as HTMLSelectElement).options, (option) => option.text)).toEqual([
      "All columns",
      "city",
      "country"
    ]);
    fireEvent.change(scope, { target: { value: "c:1" } });
    const scoped = latestFind().request;
    expect(scoped).toMatchObject({ columnIds: ["c:1"], matchCase: true, wholeCell: true });

    await respond(superseded.viewRequestId, 1, { row: 1, columnId: "c:0", ordinal: 1 });
    expect(status()).toBe("Searching…");
    await respond(scoped.viewRequestId, 0);
    expect(status()).toBe("No results");
  });

  it("shows runtime errors in the bar", async () => {
    open(metadata);
    fireEvent.keyDown(screen.getByRole("grid"), { key: "f", ctrlKey: true });
    const input = screen.getByRole("textbox", { name: "Find" });
    fireEvent.change(input, { target: { value: "x" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await dispatchAsync({
      kind: "error",
      code: "runtime_error",
      message: "The source file changed. Reopen it to continue.",
      recoverable: true,
      viewRequestId: latestFind().request.viewRequestId
    });
    expect(status()).toBe("The source file changed. Reopen it to continue.");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("scopes to a selected column and returns focus to the match on Escape without discarding the draft", async () => {
    const draft: SessionMetadata = {
      ...metadata,
      draftStep: { id: "draft", kind: "dropColumns", params: { columns: [{ id: "c:1", name: "country" }] } }
    };
    open(draft);
    fireEvent.click(screen.getByRole("columnheader", { name: /country/u }));
    fireEvent.keyDown(screen.getByRole("grid"), { key: "f", ctrlKey: true });
    expect(screen.getByRole("combobox", { name: "Search in" })).toHaveValue("c:1");

    const input = screen.getByRole("textbox", { name: "Find" });
    fireEvent.change(input, { target: { value: "france" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(latestFind().request).toMatchObject({ columnIds: ["c:1"] });
    await respond(latestFind().request.viewRequestId, 1, { row: 2, columnId: "c:1", ordinal: 1 });

    postMessage.mockClear();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("search", { name: "Find in grid" })).toBeNull();
    expect(screen.getByText("France").closest("td")).toHaveFocus();
    expect(screen.getByRole("button", { name: "Discard" })).toBeInTheDocument();
    expect(runtimeRequests()).toEqual([]);

    fireEvent.keyDown(screen.getByText("France").closest("td")!, { key: "F3" });
    expect(screen.getByRole("textbox", { name: "Find" })).toHaveValue("france");
    expect(latestFind().request).toMatchObject({
      query: "france",
      direction: "next",
      from: { row: 2, columnId: "c:1" },
      includeFrom: false
    });
  });

  it("opens from the host command and leaves Ctrl+F in other editable fields alone", () => {
    open(metadata);
    fireEvent.click(screen.getByRole("button", { name: "Go to row" }));
    const rowInput = screen.getByRole("textbox", { name: "Row number" });
    expect(fireEvent.keyDown(rowInput, { key: "f", ctrlKey: true })).toBe(true);
    expect(screen.queryByRole("textbox", { name: "Find" })).toBeNull();

    dispatch({ kind: "editorAction", action: "find" });
    expect(screen.getByRole("textbox", { name: "Find" })).toHaveFocus();
    expect(runtimeRequests()).toEqual([]);
  });

  it("explains engines without Find and keeps Escape inside the bar", () => {
    open({
      ...metadata,
      backend: "pyspark",
      mode: "viewing",
      source: { kind: "notebookVariable", label: "spark_df", variableName: "spark_df" },
      capabilities: {
        editable: false,
        lazy: false,
        cancel: false,
        exportCsv: false,
        exportParquet: false,
        notebookInsert: false,
        find: false
      }
    });
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    expect(screen.getByRole("textbox", { name: "Find" })).toBeDisabled();
    expect(status()).toBe("Find is unavailable for PySpark dataframes.");
    const close = screen.getByRole("button", { name: "Close Find" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: "Escape" });
    expect(screen.queryByRole("search", { name: "Find in grid" })).toBeNull();
    expect(runtimeRequests()).toEqual([]);
  });
});

function text(value: string): CellValue {
  return { kind: "string", raw: value, display: value, isNull: false, isNaN: false };
}

function list(values: string[]): CellValue {
  return { kind: "list", raw: values, display: JSON.stringify(values), isNull: false, isNaN: false };
}

function open(sessionMetadata: SessionMetadata): void {
  render(<App />);
  dispatch({ kind: "sessionOpened", metadata: sessionMetadata, page, summaries: [] });
  postMessage.mockClear();
}

function dispatch(data: unknown): void {
  act(() =>
    window.dispatchEvent(
      new MessageEvent("message", {
        data:
          data && typeof data === "object" && "kind" in data && data.kind === "sessionOpened"
            ? { ...data, offeredViewContextId: `snapshot:${crypto.randomUUID()}` }
            : data,
        origin: window.location.origin
      })
    )
  );
}

function runtimeRequests(): string[] {
  return postMessage.mock.calls
    .map(([message]) => message)
    .filter((message) => message?.kind === "runtimeRequest")
    .map((message) => message.request.kind);
}

function latestFind() {
  const message = postMessage.mock.calls
    .map(([candidate]) => candidate)
    .filter((candidate) => candidate?.kind === "runtimeRequest" && candidate.request.kind === "findCells")
    .at(-1);
  expect(message).toBeDefined();
  return { message, request: message.request };
}

async function dispatchAsync(data: unknown): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new MessageEvent("message", { data, origin: window.location.origin }));
  });
}

function respond(
  viewRequestId: string,
  matchCount: number,
  match?: { row: number; columnId: string; ordinal: number }
): Promise<void> {
  return dispatchAsync({ kind: "cellsFound", revision: 1, viewRequestId, matchCount, ...(match ? { match } : {}) });
}

function status(): string {
  return screen.getByRole("search", { name: "Find in grid" }).querySelector('[role="status"]')?.textContent ?? "";
}

function findMarks(): Map<string, string> {
  return new Map(
    Array.from(document.querySelectorAll("td[data-find-match]"), (cell) => [
      cell.textContent ?? "",
      cell.getAttribute("data-find-match") ?? ""
    ])
  );
}
