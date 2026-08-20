import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GridPage, SessionMetadata } from "../shared/protocol";
import { DataGrid } from "../webviews/grid/DataGrid";

const vscodePostMessage = vi.hoisted(() => vi.fn());
vi.mock("../webviews/vscodeApi", () => ({
  vscode: { postMessage: vscodePostMessage, getState: vi.fn(), setState: vi.fn() }
}));

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
  rowAxis: { kind: "positional", levelNames: [] },
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
let releasePointerCaptureDescriptor: PropertyDescriptor | undefined;
let setPointerCaptureDescriptor: PropertyDescriptor | undefined;
let writeText: ReturnType<typeof vi.fn>;

describe("DataGrid clipboard interactions", () => {
  beforeEach(() => {
    vscodePostMessage.mockClear();
    clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    execCommandDescriptor = Object.getOwnPropertyDescriptor(document, "execCommand");
    releasePointerCaptureDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "releasePointerCapture");
    setPointerCaptureDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "setPointerCapture");
    writeText = vi.fn(async () => undefined);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
      configurable: true,
      value: vi.fn()
    });
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
      configurable: true,
      value: vi.fn()
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
    else Reflect.deleteProperty(navigator, "clipboard");
    if (execCommandDescriptor) Object.defineProperty(document, "execCommand", execCommandDescriptor);
    else Reflect.deleteProperty(document, "execCommand");
    restorePrototypeProperty("releasePointerCapture", releasePointerCaptureDescriptor);
    restorePrototypeProperty("setPointerCapture", setPointerCaptureDescriptor);
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
    renderGrid("view-a", formulaPage, { ...metadata, rowAxis: { kind: "index", levelNames: ["account"] } });
    focusCell(screen.getByRole("cell", { name: "=2+2" }));

    fireEvent.click(screen.getByRole("button", { name: "Copy row" }));

    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("' \uFEFF@ROW()\t'=2+2\t-10.5"));
    expect(await screen.findByText("Copied row with its row label.")).toBeTruthy();
  });

  it.each([
    ["Ctrl+C", { ctrlKey: true }],
    ["Cmd+C", { metaKey: true }]
  ])("copies a real pointer-selected rectangle once from its focus owner with %s", async (_label, modifier) => {
    renderGrid();
    const city = screen.getByRole("cell", { name: "Milan" });
    const emptySales = screen.getByRole("cell", { name: "" });
    pointerDrag(city, emptySales, 17);

    expect(screen.getByText("2 rows by 2 columns selected")).toBeTruthy();
    expect(document.querySelectorAll('[data-clipboard-selected="true"]')).toHaveLength(4);
    expect(document.activeElement).toBe(emptySales);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "c", ...modifier });

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenLastCalledWith("Milan\t10.5\nParis\t");
    expect(screen.getByText("Copied 2 by 2 cell range.")).toBeTruthy();
  });

  it("preserves a pointer-selected rectangle in its context menu and restores the drag endpoint", async () => {
    const contextPage: GridPage = {
      ...page,
      rows: [
        { ...page.rows[0], values: [cell("=2+2"), numberCell(-10.5)] },
        {
          ...page.rows[1],
          values: [cell('contains\t"quote"'), { kind: "null", raw: null, display: "", isNull: true, isNaN: false }]
        }
      ]
    };
    renderGrid("view-a", contextPage);
    const city = screen.getByRole("cell", { name: "=2+2" });
    const emptySales = screen.getByRole("cell", { name: "" });
    pointerDrag(city, emptySales, 19);

    expect(fireEvent.pointerDown(city, { button: 2, buttons: 2, pointerId: 20, pointerType: "mouse" })).toBe(false);
    fireEvent.contextMenu(city, { button: 2 });

    expect(document.querySelectorAll('[data-clipboard-selected="true"]')).toHaveLength(4);
    expect(screen.getByText("2 rows by 2 columns selected")).toBeTruthy();
    const menu = screen.getByRole("menu", { name: "Cell and selection actions for city" });
    expect(within(menu).getByRole("menuitem", { name: "Keep only this value" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Exclude this value" })).toBeInTheDocument();
    const copySelection = within(menu).getByRole("menuitem", { name: "Copy selection" });
    expect(document.activeElement).toBe(copySelection);
    fireEvent.click(copySelection);

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenLastCalledWith(`'=2+2\t-10.5\n"contains\t""quote"""\t`);
    await waitFor(() => expect(document.activeElement).toBe(emptySales));
    expect(document.querySelectorAll('[data-clipboard-selected="true"]')).toHaveLength(4);
    expect(screen.getByText("Copied 2 by 2 cell range.")).toBeTruthy();
  });

  it("does not expose a stale Milan range action from a whole-city-column selection", async () => {
    renderGrid();
    const milan = screen.getByRole("cell", { name: "Milan" });
    const paris = screen.getByRole("cell", { name: "Paris" });
    pointerDrag(milan, milan, 21);

    fireEvent.click(screen.getByRole("columnheader", { name: "city" }));
    const request = latestColumnRequest();
    dispatchPage(request, metadata, 0, 2, 2, [cell("Milan"), cell("Paris")]);
    await waitFor(() => expect(screen.getByRole("button", { name: "Copy column" })).toBeEnabled());
    expect(document.querySelectorAll('[data-clipboard-selected="true"]')).toHaveLength(3);

    expect(fireEvent.pointerDown(paris, { button: 2, buttons: 2, pointerId: 22, pointerType: "mouse" })).toBe(true);
    act(() => paris.focus());
    fireEvent.contextMenu(paris, { button: 2 });

    const menu = screen.getByRole("menu", { name: "Filter city by this cell" });
    expect(within(menu).queryByRole("menuitem", { name: "Copy selection" })).toBeNull();
    expect(screen.getByText("1 cell selected, row 2, column 1")).toBeTruthy();
    expect(document.querySelectorAll('[data-clipboard-selected="true"]')).toHaveLength(1);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("clears an in-flight whole-column copy when a pointer range replaces it", async () => {
    renderGrid();
    fireEvent.click(screen.getByRole("columnheader", { name: "city" }));
    const request = latestColumnRequest();
    const milan = screen.getByRole("cell", { name: "Milan" });
    const emptySales = screen.getByRole("cell", { name: "" });

    pointerDrag(milan, emptySales, 23);

    expect(vscodePostMessage).toHaveBeenCalledWith({
      kind: "cancelViewRequests",
      viewRequestIds: [request.request.viewRequestId]
    });
    expect(screen.getByText("2 rows by 2 columns selected")).toBeTruthy();
    expect(fireEvent.pointerDown(milan, { button: 2, buttons: 2, pointerId: 24, pointerType: "mouse" })).toBe(false);
    fireEvent.contextMenu(milan, { button: 2 });
    const menu = screen.getByRole("menu", { name: "Cell and selection actions for city" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy selection" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenLastCalledWith("Milan\t10.5\nParis\t");
    expect(document.querySelectorAll('[data-clipboard-selected="true"]')).toHaveLength(4);
  });

  it("presents named MultiIndex labels as an accessible row axis without adding data columns", () => {
    const indexedPage: GridPage = {
      ...page,
      rows: [
        { ...page.rows[0], rowLabel: "north · acct-a" },
        { ...page.rows[1], rowLabel: "south · acct-b" }
      ]
    };
    renderGrid("view-a", indexedPage, {
      ...metadata,
      rowAxis: { kind: "multiIndex", levelNames: ["region", "account"] }
    });

    expect(screen.getByRole("columnheader", { name: "region / account row labels" })).toHaveTextContent(
      "region / account"
    );
    expect(screen.getByRole("rowheader", { name: "Row 1, region / account north · acct-a" })).toHaveTextContent(
      "north · acct-a"
    );
    expect(screen.getAllByRole("columnheader")).toHaveLength(3);
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

  it("prepares and copies a whole filtered and sorted column across projected pages", async () => {
    const threeRowMetadata: SessionMetadata = {
      ...metadata,
      shape: { rows: 3, columns: 2 },
      filteredShape: { rows: 3, columns: 2 }
    };
    const visiblePage: GridPage = { ...page, totalRows: 3 };
    renderGrid("view-a", visiblePage, threeRowMetadata);

    fireEvent.click(screen.getByRole("columnheader", { name: "city" }));
    const firstRequest = latestColumnRequest();
    expect(firstRequest).toMatchObject({
      purpose: "clipboardColumn",
      viewContextId: "view-a",
      request: { kind: "getPage", offset: 0, limit: 2, columnOffset: 0, columnLimit: 1 }
    });
    expect(screen.getByText("Whole filtered and sorted column city selected. Preparing copy.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy column" })).toBeDisabled();

    dispatchPage(firstRequest, threeRowMetadata, 0, 2, 3, [cell("=2+2"), cell("\t@cmd")]);
    const secondRequest = latestColumnRequest();
    expect(secondRequest.request).toMatchObject({ offset: 2, limit: 1, columnOffset: 0, columnLimit: 1 });
    dispatchPage(secondRequest, threeRowMetadata, 2, 1, 3, [cell("contains\nline")]);

    const copyColumn = await screen.findByRole("button", { name: "Copy column" });
    expect(copyColumn).toBeEnabled();
    expect(screen.getByText("Whole filtered and sorted column city selected, 3 rows.")).toBeTruthy();
    expect(document.querySelectorAll('[data-clipboard-selected="true"]')).toHaveLength(3);
    fireEvent.click(copyColumn);

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('\'=2+2\n"\'\t@cmd"\n"contains\nline"'));
    expect(screen.getByText("Copied 3 cells from column city.")).toBeTruthy();
  });

  it("uses Ctrl+Space and Ctrl+C for a typed-negative whole column", async () => {
    renderGrid();
    const salesHeader = screen.getByRole("columnheader", { name: "sales" });
    act(() => salesHeader.focus());
    fireEvent.keyDown(salesHeader, { key: " ", ctrlKey: true });
    const request = latestColumnRequest();
    dispatchPage(request, metadata, 0, 2, 2, [numberCell(-10.5), numberCell(-20)]);

    await waitFor(() => expect(screen.getByRole("button", { name: "Copy column" })).toBeEnabled());
    fireEvent.keyDown(salesHeader, { key: "c", ctrlKey: true });

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("-10.5\n-20"));
    expect(document.activeElement).toBe(salesHeader);
  });

  it("rejects a known oversized column before any page or clipboard adapter call", () => {
    renderGrid("view-a", page, {
      ...metadata,
      shape: { rows: 100_001, columns: 2 },
      filteredShape: { rows: 100_001, columns: 2 }
    });

    fireEvent.click(screen.getByRole("columnheader", { name: "city" }));

    expect(vscodePostMessage).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Copy column" })).toHaveAttribute(
      "title",
      "Copy is limited to 100,000 cells. Select a smaller range."
    );
    expect(screen.getByText("Copy is limited to 100,000 cells. Select a smaller range.")).toBeTruthy();
  });

  it("cancels preparation and ignores its page when the logical view changes", () => {
    const rendered = renderGrid("view-a");
    fireEvent.click(screen.getByRole("columnheader", { name: "city" }));
    const staleRequest = latestColumnRequest();

    rendered.rerender(grid("view-b"));

    expect(vscodePostMessage).toHaveBeenCalledWith({
      kind: "cancelViewRequests",
      viewRequestIds: [staleRequest.request.viewRequestId]
    });
    dispatchPage(staleRequest, metadata, 0, 2, 2, [cell("stale-secret"), cell("stale-secret")]);
    expect(screen.getByRole("button", { name: "Copy column" })).toBeDisabled();
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.queryByText(/stale-secret/u)).toBeNull();
  });
});

interface PostedColumnRequest {
  kind: "runtimeRequest";
  purpose: "clipboardColumn";
  viewContextId: string;
  request: {
    kind: "getPage";
    viewRequestId: string;
    offset: number;
    limit: number;
    columnOffset: number;
    columnLimit: number;
  };
}

function latestColumnRequest(): PostedColumnRequest {
  const requests = vscodePostMessage.mock.calls
    .map(([message]) => message as Partial<PostedColumnRequest>)
    .filter((message): message is PostedColumnRequest => message.kind === "runtimeRequest");
  const request = requests.at(-1);
  if (!request) throw new Error("Expected a clipboard-column request.");
  return request;
}

function dispatchPage(
  message: PostedColumnRequest,
  activeMetadata: SessionMetadata,
  offset: number,
  limit: number,
  totalRows: number,
  values: ReturnType<typeof cell>[] | ReturnType<typeof numberCell>[]
): void {
  const column = activeMetadata.schema[message.request.columnOffset];
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        data: {
          kind: "page",
          revision: activeMetadata.revision,
          viewRequestId: message.request.viewRequestId,
          metadata: activeMetadata,
          page: {
            offset,
            limit,
            totalRows,
            columnIds: [column.id],
            rows: values.map((value, index) => ({
              id: `clipboard:${offset + index}`,
              rowNumber: offset + index,
              values: [value]
            }))
          }
        }
      })
    );
  });
}

function renderGrid(viewContextId = "view-a", activePage = page, activeMetadata = metadata) {
  return render(grid(viewContextId, activePage, activeMetadata));
}

function grid(viewContextId: string, activePage = page, activeMetadata = metadata) {
  return (
    <DataGrid
      metadata={activeMetadata}
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

function pointerDrag(start: HTMLElement, end: HTMLElement, pointerId: number): void {
  fireEvent.pointerDown(start, pointerEvent(pointerId));
  fireEvent.pointerMove(end, pointerEvent(pointerId));
  fireEvent.pointerUp(end, pointerEvent(pointerId, { buttons: 0 }));
}

function pointerEvent(pointerId: number, overrides: { buttons?: number } = {}) {
  return { button: 0, buttons: 1, pointerId, pointerType: "mouse", ...overrides };
}

function restorePrototypeProperty(property: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(HTMLElement.prototype, property, descriptor);
  else Reflect.deleteProperty(HTMLElement.prototype, property);
}

function cell(display: string) {
  return { kind: "string" as const, raw: display, display, isNull: false, isNaN: false };
}

function numberCell(raw: number) {
  return { kind: "number" as const, raw, display: String(raw), isNull: false, isNaN: false };
}
