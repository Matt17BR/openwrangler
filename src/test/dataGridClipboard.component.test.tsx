import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GridPage, SessionMetadata } from "../shared/protocol";
import { DataGrid } from "../webviews/grid/DataGrid";

const metadata: SessionMetadata = {
  protocolVersion: 2,
  sessionId: "clipboard-session",
  revision: 3,
  backend: "pandas",
  mode: "editing",
  source: { kind: "file", label: "clipboard.csv", path: "clipboard.csv" },
  capabilities: {
    editable: true,
    lazy: false,
    cancel: true,
    exportCsv: true,
    exportParquet: true,
    notebookInsert: false
  },
  shape: { rows: 2, columns: 2 },
  filteredShape: { rows: 2, columns: 2 },
  filterModel: { filters: [], sort: [] },
  steps: [],
  schema: [
    { id: "c:0", name: "city", position: 0, rawType: "object", type: "string", nullable: false },
    { id: "c:1", name: "sales", position: 1, rawType: "float64", type: "float", nullable: true }
  ]
};

const page: GridPage = {
  offset: 0,
  limit: 2,
  totalRows: 2,
  columnIds: ["c:0", "c:1"],
  rows: [
    {
      id: "r:0",
      rowNumber: 0,
      values: [cell("Milan"), numberCell(10.5)]
    },
    {
      id: "r:1",
      rowNumber: 1,
      values: [cell("Paris"), { kind: "null", raw: null, display: "", isNull: true, isNaN: false }]
    }
  ]
};

let clipboardDescriptor: PropertyDescriptor | undefined;
let execCommandDescriptor: PropertyDescriptor | undefined;
let writeText: ReturnType<typeof vi.fn>;

describe("DataGrid clipboard interactions", () => {
  beforeEach(() => {
    clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    execCommandDescriptor = Object.getOwnPropertyDescriptor(document, "execCommand");
    writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
    else Reflect.deleteProperty(navigator, "clipboard");
    if (execCommandDescriptor) Object.defineProperty(document, "execCommand", execCommandDescriptor);
    else Reflect.deleteProperty(document, "execCommand");
  });

  it("copies the focused cell and complete loaded row from explicit controls", async () => {
    renderGrid();
    const city = screen.getByRole("cell", { name: "Milan" });
    focusCell(city);

    fireEvent.click(screen.getByRole("button", { name: "Copy cell" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("Milan"));
    expect(screen.getByText("Copied cell.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Copy row" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("Milan\t10.5"));
    expect(await screen.findByText("Copied row.")).toBeTruthy();
  });

  it("writes formula-neutralized strings and row labels while preserving a typed negative", async () => {
    const formulaPage: GridPage = {
      ...page,
      rows: [
        {
          ...page.rows[0],
          rowLabel: " \uFEFF@ROW()",
          values: [cell("=2+2"), numberCell(-10.5)]
        },
        page.rows[1]
      ]
    };
    renderGrid("view-a", formulaPage);
    focusCell(screen.getByRole("cell", { name: "=2+2" }));

    fireEvent.click(screen.getByRole("button", { name: "Copy row" }));

    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("' \uFEFF@ROW()\t'=2+2\t-10.5"));
    expect(await screen.findByText("Copied row with its row label.")).toBeTruthy();
  });

  it("extends a rectangular pointer selection and copies its exact displayed values", async () => {
    renderGrid();
    const city = screen.getByRole("cell", { name: "Milan" });
    const emptySales = screen.getByRole("cell", { name: "" });
    focusCell(city);
    fireEvent.pointerDown(emptySales, { button: 0, shiftKey: true });
    act(() => emptySales.focus());

    expect(screen.getByText("2 rows by 2 columns selected")).toBeTruthy();
    expect(document.querySelectorAll('[data-clipboard-selected="true"]')).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: "Copy range" }));

    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("Milan\t10.5\nParis\t"));
    expect(screen.getByText("Copied 2 by 2 cell range.")).toBeTruthy();
  });

  it("extends with Shift+Arrow and supports the platform copy shortcut", async () => {
    renderGrid();
    const city = screen.getByRole("cell", { name: "Milan" });
    focusCell(city);

    fireEvent.keyDown(city, { key: "ArrowRight", shiftKey: true });
    expect(screen.getByText("1 row by 2 columns selected")).toBeTruthy();
    fireEvent.keyDown(city, { key: "c", ctrlKey: true });

    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("Milan\t10.5"));
  });

  it("labels a projected row copy as loaded columns instead of implying a full-row fetch", async () => {
    const projectedPage: GridPage = {
      ...page,
      columnIds: ["c:0"],
      rows: page.rows.map((row) => ({ ...row, values: [row.values[0]] }))
    };
    renderGrid("view-a", projectedPage);
    focusCell(screen.getByRole("cell", { name: "Milan" }));
    const copyRow = screen.getByRole("button", { name: "Copy row" });
    expect(copyRow).toHaveAttribute("title", "Copy loaded row columns");

    fireEvent.click(copyRow);

    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("Milan"));
    expect(screen.getByText("Copied loaded row columns.")).toBeTruthy();
  });

  it("resets the ephemeral selection when the logical view changes", () => {
    const rendered = renderGrid("view-a");
    const city = screen.getByRole("cell", { name: "Milan" });
    const emptySales = screen.getByRole("cell", { name: "" });
    focusCell(city);
    fireEvent.pointerDown(emptySales, { button: 0, shiftKey: true });
    act(() => emptySales.focus());
    expect(document.querySelectorAll('[data-clipboard-selected="true"]')).toHaveLength(4);

    rendered.rerender(grid("view-b"));

    expect(document.querySelectorAll('[data-clipboard-selected="true"]')).toHaveLength(1);
    expect(screen.getByText("1 cell selected, row 1, column 2")).toBeTruthy();
  });

  it("reports clipboard denial without exposing cell contents in the error", async () => {
    writeText.mockRejectedValueOnce(new Error("denied"));
    Object.defineProperty(document, "execCommand", { configurable: true, value: vi.fn(() => false) });
    renderGrid();
    focusCell(screen.getByRole("cell", { name: "Milan" }));

    fireEvent.click(screen.getByRole("button", { name: "Copy cell" }));

    expect(
      await screen.findByText("Could not write to the clipboard. Check this editor's clipboard permissions.")
    ).toBeTruthy();
    expect(screen.queryByText(/denied/u)).toBeNull();
  });
});

function renderGrid(viewContextId = "view-a", activePage = page) {
  return render(grid(viewContextId, activePage));
}

function grid(viewContextId: string, activePage = page) {
  return (
    <DataGrid
      metadata={metadata}
      page={activePage}
      summaries={[]}
      pageSize={2}
      defaultColumnWidth={190}
      insightsOnOpen={false}
      viewContextId={viewContextId}
      onPage={() => undefined}
      onSortColumn={() => undefined}
      onOpenFilter={() => undefined}
      onVisibleSummaryColumnsChange={() => undefined}
    />
  );
}

function focusCell(target: HTMLElement): void {
  fireEvent.pointerDown(target, { button: 0 });
  act(() => target.focus());
}

function cell(display: string) {
  return { kind: "string" as const, raw: display, display, isNull: false, isNaN: false };
}

function numberCell(raw: number) {
  return { kind: "number" as const, raw, display: String(raw), isNull: false, isNaN: false };
}
