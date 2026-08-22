import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode, useState } from "react";
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
    vi.useRealTimers();
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

  it("keeps ArrowDown focus owned across a clipboard-result page refresh", async () => {
    const onPage = vi.fn();
    const pagedMetadata: SessionMetadata = {
      ...metadata,
      shape: { rows: 4, columns: 2 },
      filteredShape: { rows: 4, columns: 2 }
    };
    const props = {
      metadata: pagedMetadata,
      summaries: [],
      pageSize: 2,
      defaultColumnWidth: 190,
      insightsOnOpen: false,
      viewContextId: "view-a",
      onPage,
      onSortColumn: () => undefined,
      onOpenFilter: () => undefined,
      onVisibleSummaryColumnsChange: () => undefined
    };
    const firstPage = { ...page, totalRows: 4 };
    const rendered = render(<DataGrid {...props} page={firstPage} />);
    const scroller = screen.getByTestId("data-grid-scroller");
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 58 });
    const finalCell = screen.getByRole("cell", { name: "Paris" });
    act(() => finalCell.focus());

    fireEvent.keyDown(finalCell, { key: "ArrowDown" });
    expect(onPage).toHaveBeenCalledWith(2);

    rendered.rerender(
      <DataGrid
        {...props}
        page={{
          ...firstPage,
          offset: 2,
          rows: firstPage.rows.map((row, index) => ({ ...row, id: `r:${index + 2}`, rowNumber: index + 2 }))
        }}
      />
    );

    await waitFor(() => {
      expect(document.activeElement).toHaveAttribute("data-grid-row", "2");
      expect(document.activeElement).toHaveAttribute("data-grid-column", "0");
    });
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

  it("publishes and retains the keyboard range-copy receipt through a late stateful write", async () => {
    vi.useFakeTimers();
    try {
      let clipboard = "prior clipboard";
      let receiptAtWrite: ReturnType<typeof clipboardSettlementReceipt> | undefined;
      const lateWrite = deferred<void>();
      writeText.mockImplementationOnce(async (value: string) => {
        receiptAtWrite = clipboardSettlementReceipt();
        await lateWrite.promise;
        clipboard = value;
      });
      renderGrid();
      const milan = screen.getByRole("cell", { name: "Milan" });
      const emptySales = screen.getByRole("cell", { name: "" });
      pointerDrag(milan, emptySales, 67);

      fireEvent.keyDown(emptySales, { key: "c", ctrlKey: true });

      const pending = clipboardSettlementReceipt();
      expect(pending).toMatchObject({ mode: "range", status: "pending" });
      expect(pending.id).toBeGreaterThan(0);
      expect(receiptAtWrite).toEqual(pending);
      expect(clipboard).toBe("prior clipboard");
      await vi.advanceTimersByTimeAsync(10_001);
      expect(clipboardSettlementReceipt()).toEqual(pending);
      expect(screen.queryByText("Copied 2 by 2 cell range.")).toBeNull();

      await act(async () => lateWrite.resolve());

      expect(clipboard).toBe("Milan\t10.5\nParis\t");
      expect(clipboardSettlementReceipt()).toEqual({ ...pending, status: "success" });
      expect(screen.getByText("Copied 2 by 2 cell range.")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("announces a successful keyboard fallback without invalidating its same-cell owner", async () => {
    writeText.mockRejectedValueOnce(new Error("primary adapter denied"));
    const execCommand = vi.fn(() => {
      document.querySelector<HTMLTextAreaElement>("textarea")?.focus();
      return true;
    });
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    renderGrid();
    const milan = screen.getByRole("cell", { name: "Milan" });
    const emptySales = screen.getByRole("cell", { name: "" });
    pointerDrag(milan, emptySales, 18);

    fireEvent.keyDown(emptySales, { key: "c", ctrlKey: true });

    await waitFor(() => expect(execCommand).toHaveBeenCalledExactlyOnceWith("copy"));
    expect(document.activeElement).toBe(emptySales);
    expect(screen.getByText("Copied 2 by 2 cell range.")).toBeTruthy();
  });

  it("does not steal re-entrant focus or publish the superseded fallback action", async () => {
    writeText.mockRejectedValueOnce(new Error("primary adapter denied"));
    renderGrid();
    const milan = screen.getByRole("cell", { name: "Milan" });
    const emptySales = screen.getByRole("cell", { name: "" });
    pointerDrag(milan, emptySales, 21);
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn(() => {
        milan.focus();
        return true;
      })
    });

    fireEvent.keyDown(emptySales, { key: "c", ctrlKey: true });

    await waitFor(() => expect(document.activeElement).toBe(milan));
    expect(screen.queryByText("Copied 2 by 2 cell range.")).toBeNull();
    expect(screen.getByText("1 cell selected, row 1, column 1")).toBeTruthy();
  });

  it("does not restore obsolete focus or selection after fallback loses ownership inside execCommand", async () => {
    writeText.mockRejectedValueOnce(new Error("primary adapter denied"));
    const rendered = renderGrid("view-a", page, metadata, 0);
    const milan = screen.getByRole("cell", { name: "Milan" });
    const emptySales = screen.getByRole("cell", { name: "" });
    pointerDrag(milan, emptySales, 55);
    let fallbackInput: HTMLElement | undefined;
    let fallbackRetainedFocusThroughRestore = false;
    const execCommand = vi.fn(() => {
      fallbackInput = document.querySelector("textarea") ?? undefined;
      fallbackInput?.focus();
      rendered.rerender(grid("view-a", page, metadata, 1));
      fallbackRetainedFocusThroughRestore = document.activeElement === fallbackInput;
      return true;
    });
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });

    fireEvent.keyDown(emptySales, { key: "c", ctrlKey: true });

    await waitFor(() => expect(execCommand).toHaveBeenCalledExactlyOnceWith("copy"));
    expect({
      fallbackInputWasTextarea: fallbackInput?.tagName === "TEXTAREA",
      fallbackRetainedFocusThroughRestore
    }).toEqual({ fallbackInputWasTextarea: true, fallbackRetainedFocusThroughRestore: true });
    expect(fallbackInput?.isConnected).toBe(false);
    expect(document.activeElement).not.toBe(emptySales);
    expect(screen.getByText("1 cell selected, row 1, column 1")).toBeTruthy();
    expect(screen.queryByText(/Copied 2 by 2|Could not write/u)).toBeNull();
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
    const menu = screen.getByRole("menu", { name: "Cell and range actions for city" });
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

  it("publishes and retains the menu range-copy receipt through a late stateful write", async () => {
    vi.useFakeTimers();
    try {
      let clipboard = "prior clipboard";
      let receiptAtWrite: ReturnType<typeof clipboardSettlementReceipt> | undefined;
      const lateWrite = deferred<void>();
      writeText.mockImplementationOnce(async (value: string) => {
        receiptAtWrite = clipboardSettlementReceipt();
        await lateWrite.promise;
        clipboard = value;
      });
      renderGrid();
      const milan = screen.getByRole("cell", { name: "Milan" });
      const emptySales = screen.getByRole("cell", { name: "" });
      pointerDrag(milan, emptySales, 68);
      openClipboardMenu(milan, 69);

      fireEvent.click(
        within(screen.getByRole("menu", { name: "Cell and range actions for city" })).getByRole("menuitem", {
          name: "Copy selection"
        })
      );

      const pending = clipboardSettlementReceipt();
      expect(pending).toMatchObject({ mode: "range", status: "pending" });
      expect(receiptAtWrite).toEqual(pending);
      expect(clipboard).toBe("prior clipboard");
      await vi.advanceTimersByTimeAsync(10_001);
      expect(clipboardSettlementReceipt()).toEqual(pending);
      expect(screen.getByRole("menu", { name: "Cell and range actions for city" })).toBeInTheDocument();

      await act(async () => lateWrite.resolve());

      expect(clipboard).toBe("Milan\t10.5\nParis\t");
      expect(clipboardSettlementReceipt()).toEqual({ ...pending, status: "success" });
      expect(screen.queryByRole("menu")).toBeNull();
      expect(document.activeElement).toBe(emptySales);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets an owned menu fallback take private textarea focus and restore the range endpoint", async () => {
    writeText.mockRejectedValueOnce(new Error("primary adapter denied"));
    const execCommand = vi.fn(() => {
      document.querySelector<HTMLTextAreaElement>("textarea")?.focus();
      return true;
    });
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    renderGrid();
    const milan = screen.getByRole("cell", { name: "Milan" });
    const emptySales = screen.getByRole("cell", { name: "" });
    pointerDrag(milan, emptySales, 61);
    openClipboardMenu(milan, 62);

    fireEvent.click(
      within(screen.getByRole("menu", { name: "Cell and range actions for city" })).getByRole("menuitem", {
        name: "Copy selection"
      })
    );

    await waitFor(() => expect(execCommand).toHaveBeenCalledExactlyOnceWith("copy"));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(emptySales);
    expect(screen.getByText("Copied 2 by 2 cell range.")).toBeTruthy();
  });

  it("invalidates an owning range menu before left pointerdown collapses its exact selection", async () => {
    renderGrid();
    const milan = screen.getByRole("cell", { name: "Milan" });
    const emptySales = screen.getByRole("cell", { name: "" });
    pointerDrag(milan, emptySales, 56);
    openClipboardMenu(milan, 57);

    fireEvent.pointerDown(milan, pointerEvent(58));
    fireEvent.pointerUp(milan, pointerEvent(58, { buttons: 0 }));
    expect(screen.getByText("1 cell selected, row 1, column 1")).toBeTruthy();
    const staleMenu = screen.queryByRole("menu", { name: "Cell and range actions for city" });
    if (staleMenu) {
      fireEvent.click(within(staleMenu).getByRole("menuitem", { name: "Copy selection" }));
      await act(async () => Promise.resolve());
    }

    expect(writeText).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByText(/Copied|Could not write/u)).toBeNull();
  });

  it("invalidates a range menu before pointerless focus replaces its exact selection", async () => {
    renderGrid();
    const milan = screen.getByRole("cell", { name: "Milan" });
    const paris = screen.getByRole("cell", { name: "Paris" });
    const emptySales = screen.getByRole("cell", { name: "" });
    pointerDrag(milan, emptySales, 59);
    openClipboardMenu(milan, 60);
    const staleCopy = within(screen.getByRole("menu", { name: "Cell and range actions for city" })).getByRole(
      "menuitem",
      { name: "Copy selection" }
    );

    act(() => paris.focus());
    fireEvent.click(staleCopy);
    await act(async () => Promise.resolve());

    expect(screen.getByText("1 cell selected, row 2, column 1")).toBeTruthy();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.queryByText(/Copied|Could not write/u)).toBeNull();
  });

  it.each([
    ["current", "Milan", "1 cell selected, row 1, column 1"],
    ["different", "Paris", "1 cell selected, row 2, column 1"]
  ])("keeps a %s-cell filter-only menu through its accounted selection result refresh", async (_kind, name, status) => {
    renderGrid();
    const milan = screen.getByRole("cell", { name: "Milan" });
    const target = screen.getByRole("cell", { name });
    focusCell(milan);

    fireEvent.click(within(target).getByRole("button", { name: "Filter city by this cell" }));
    await act(async () => Promise.resolve());

    const menu = screen.getByRole("menu", { name: "Filter city by this cell" });
    expect(menu).toBeInTheDocument();
    expect(document.activeElement).toBe(menu);
    expect(screen.getByText(status)).toBeTruthy();
  });

  it("invalidates a menu when its selection reset coalesces with a result replacement", async () => {
    let replaceResults = false;
    const replacementPage: GridPage = {
      ...page,
      rows: [{ ...page.rows[0], values: [cell("Rome"), numberCell(11.5)] }, page.rows[1]]
    };
    function CoalescedResultReplacement() {
      const [activePage, setActivePage] = useState(page);
      return (
        <DataGrid
          metadata={metadata}
          page={activePage}
          summaries={[]}
          pageSize={2}
          defaultColumnWidth={190}
          insightsOnOpen={false}
          viewContextId="view-a"
          onPage={() => undefined}
          onSortColumn={() => undefined}
          onOpenFilter={() => undefined}
          onViewStateChange={() => {
            if (replaceResults) setActivePage(replacementPage);
          }}
          onVisibleSummaryColumnsChange={() => undefined}
        />
      );
    }
    render(<CoalescedResultReplacement />);
    replaceResults = true;

    fireEvent.click(
      within(screen.getByRole("cell", { name: "Milan" })).getByRole("button", {
        name: "Filter city by this cell"
      })
    );
    await act(async () => Promise.resolve());

    expect(screen.getByRole("cell", { name: "Rome" })).toBeInTheDocument();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it.each(["success", "fallback"] as const)(
    "makes delayed menu clipboard %s inert when focus moves to a column header",
    async (outcome) => {
      const delayedWrite = deferred<void>();
      writeText.mockImplementationOnce(() => delayedWrite.promise);
      const execCommand = vi.fn(() => {
        document.querySelector<HTMLTextAreaElement>("textarea")?.focus();
        return true;
      });
      Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
      renderGrid();
      const milan = screen.getByRole("cell", { name: "Milan" });
      const emptySales = screen.getByRole("cell", { name: "" });
      pointerDrag(milan, emptySales, outcome === "success" ? 63 : 65);
      openClipboardMenu(milan, outcome === "success" ? 64 : 66);
      fireEvent.click(
        within(screen.getByRole("menu", { name: "Cell and range actions for city" })).getByRole("menuitem", {
          name: "Copy selection"
        })
      );
      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
      const cityHeader = screen.getByRole("columnheader", { name: "city" });
      act(() => cityHeader.focus());

      if (outcome === "success") await act(async () => delayedWrite.resolve());
      else await act(async () => delayedWrite.reject(new Error("primary adapter denied")));

      expect(execCommand).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(cityHeader);
      expect(screen.getByRole("menu", { name: "Cell and range actions for city" })).toBeInTheDocument();
      expect(screen.queryByText(/Copied 2 by 2|Could not write/u)).toBeNull();
    }
  );

  it("leaves a newer menu and its focus untouched when an older clipboard write finishes", async () => {
    const delayedWrite = deferred<void>();
    writeText.mockImplementationOnce(() => delayedWrite.promise);
    renderGrid();
    const milan = screen.getByRole("cell", { name: "Milan" });
    const emptySales = screen.getByRole("cell", { name: "" });
    pointerDrag(milan, emptySales, 31);
    openClipboardMenu(milan, 32);

    fireEvent.click(
      within(screen.getByRole("menu", { name: "Cell and range actions for city" })).getByRole("menuitem", {
        name: "Copy selection"
      })
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

    openClipboardMenu(emptySales, 33);
    const newerMenu = screen.getByRole("menu", { name: "Cell and range actions for sales" });
    const newerAction = within(newerMenu).getByRole("menuitem", { name: "Copy selection" });
    expect(document.activeElement).toBe(newerAction);

    await act(async () => delayedWrite.resolve());

    expect(screen.getByRole("menu", { name: "Cell and range actions for sales" })).toBe(newerMenu);
    expect(document.activeElement).toBe(newerAction);
    expect(screen.queryByText("Copied 2 by 2 cell range.")).toBeNull();
  });

  it("does not start a fallback when a rejected clipboard write has lost menu ownership", async () => {
    const delayedWrite = deferred<void>();
    writeText.mockImplementationOnce(() => delayedWrite.promise);
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    renderGrid();
    const milan = screen.getByRole("cell", { name: "Milan" });
    const emptySales = screen.getByRole("cell", { name: "" });
    pointerDrag(milan, emptySales, 42);
    openClipboardMenu(milan, 43);

    fireEvent.click(
      within(screen.getByRole("menu", { name: "Cell and range actions for city" })).getByRole("menuitem", {
        name: "Copy selection"
      })
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    openClipboardMenu(emptySales, 44);

    await act(async () => delayedWrite.reject(new Error("primary adapter denied")));

    expect(execCommand).not.toHaveBeenCalled();
    expect(screen.getByRole("menu", { name: "Cell and range actions for sales" })).toBeInTheDocument();
    expect(screen.queryByText(/Could not write|Copied 2 by 2/u)).toBeNull();
  });

  it("keeps repeated menu and keyboard copies behind one noncancellable write", async () => {
    const firstWrite = deferred<void>();
    const secondWrite = deferred<void>();
    writeText.mockImplementationOnce(() => firstWrite.promise).mockImplementationOnce(() => secondWrite.promise);
    renderGrid();
    const milan = screen.getByRole("cell", { name: "Milan" });
    const emptySales = screen.getByRole("cell", { name: "" });
    pointerDrag(milan, emptySales, 34);
    openClipboardMenu(milan, 35);
    const copySelection = within(screen.getByRole("menu", { name: "Cell and range actions for city" })).getByRole(
      "menuitem",
      { name: "Copy selection" }
    );

    fireEvent.click(copySelection);
    const firstReceipt = clipboardSettlementReceipt();
    fireEvent.keyDown(emptySales, { key: "c", ctrlKey: true });
    expect(firstReceipt).toMatchObject({ mode: "range", status: "pending" });
    expect(clipboardSettlementReceipt()).toEqual(firstReceipt);
    expect(writeText).toHaveBeenCalledTimes(1);
    await act(async () => firstWrite.resolve());

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(clipboardSettlementReceipt()).toEqual({ ...firstReceipt, status: "success" });
    expect(document.activeElement).toBe(emptySales);

    fireEvent.keyDown(emptySales, { key: "c", ctrlKey: true });
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    const secondReceipt = clipboardSettlementReceipt();
    expect(secondReceipt).toMatchObject({ mode: "range", status: "pending" });
    expect(secondReceipt.id).toBeGreaterThan(firstReceipt.id);

    await act(async () => secondWrite.resolve());

    expect(document.activeElement).toBe(emptySales);
    expect(screen.getByText("Copied 2 by 2 cell range.")).toBeTruthy();
  });

  it("keeps a whole-column write ahead of a later range write until exact settlement", async () => {
    const columnWrite = deferred<void>();
    writeText.mockImplementationOnce(() => columnWrite.promise).mockResolvedValue(undefined);
    renderGrid();
    fireEvent.click(screen.getByRole("columnheader", { name: "city" }));
    dispatchPage(latestColumnRequest(), metadata, 0, 2, 2, [cell("Milan"), cell("Paris")]);
    fireEvent.click(await screen.findByRole("button", { name: "Copy column" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

    const milan = screen.getByRole("cell", { name: "Milan" });
    const emptySales = screen.getByRole("cell", { name: "" });
    pointerDrag(milan, emptySales, 72);
    fireEvent.keyDown(emptySales, { key: "c", ctrlKey: true });
    await act(async () => Promise.resolve());

    try {
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(screen.getByText("Wait for the current clipboard copy to finish.")).toBeTruthy();
    } finally {
      await act(async () => columnWrite.resolve());
    }

    fireEvent.keyDown(emptySales, { key: "c", ctrlKey: true });
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    expect(writeText).toHaveBeenLastCalledWith("Milan\t10.5\nParis\t");
  });

  it("keeps a range write ahead of a later whole-column write until exact settlement", async () => {
    const rangeWrite = deferred<void>();
    writeText.mockImplementationOnce(() => rangeWrite.promise).mockResolvedValue(undefined);
    renderGrid();
    const milan = screen.getByRole("cell", { name: "Milan" });
    const emptySales = screen.getByRole("cell", { name: "" });
    pointerDrag(milan, emptySales, 73);
    fireEvent.keyDown(emptySales, { key: "c", ctrlKey: true });
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("columnheader", { name: "city" }));
    dispatchPage(latestColumnRequest(), metadata, 0, 2, 2, [cell("Milan"), cell("Paris")]);
    fireEvent.click(await screen.findByRole("button", { name: "Copy column" }));
    await act(async () => Promise.resolve());

    try {
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(screen.getByText("Wait for the current clipboard copy to finish.")).toBeTruthy();
    } finally {
      await act(async () => rangeWrite.resolve());
    }

    fireEvent.click(screen.getByRole("button", { name: "Copy column" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    expect(writeText).toHaveBeenLastCalledWith("Milan\nParis");
  });

  it("bounds repeated changed-column copies behind one unresolved write and settles the queued copy once", async () => {
    const cityWrite = deferred<void>();
    writeText.mockImplementationOnce(() => cityWrite.promise).mockResolvedValue(undefined);
    renderGrid();
    fireEvent.click(screen.getByRole("columnheader", { name: "city" }));
    dispatchPage(latestColumnRequest(), metadata, 0, 2, 2, [cell("Milan"), cell("Paris")]);
    fireEvent.click(await screen.findByRole("button", { name: "Copy column" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("columnheader", { name: "sales" }));
    dispatchPage(latestColumnRequest(), metadata, 0, 2, 2, [numberCell(10.5), numberCell(-20)]);
    const copySales = await screen.findByRole("button", { name: "Copy column" });
    fireEvent.click(copySales);
    fireEvent.click(copySales);
    fireEvent.click(copySales);
    await act(async () => Promise.resolve());

    try {
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(screen.getByText("Column sales is ready and will copy after the current write finishes.")).toBeTruthy();
    } finally {
      await act(async () => cityWrite.resolve());
    }

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    expect(writeText).toHaveBeenLastCalledWith("10.5\n-20");
    await act(async () => Promise.resolve());
    expect(writeText).toHaveBeenCalledTimes(2);
  });

  it("drops a queued whole-column menu copy after its exact menu owner becomes stale", async () => {
    const cityWrite = deferred<void>();
    writeText.mockImplementationOnce(() => cityWrite.promise).mockResolvedValue(undefined);
    renderGrid();
    fireEvent.click(screen.getByRole("columnheader", { name: "city" }));
    dispatchPage(latestColumnRequest(), metadata, 0, 2, 2, [cell("Milan"), cell("Paris")]);
    fireEvent.click(await screen.findByRole("button", { name: "Copy column" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("columnheader", { name: "sales" }));
    dispatchPage(latestColumnRequest(), metadata, 0, 2, 2, [numberCell(10.5), numberCell(-20)]);
    const emptySales = screen.getByRole("cell", { name: "" });
    openClipboardMenu(emptySales, 76);
    const menu = screen.getByRole("menu", { name: "Cell and column actions for sales" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy column" }));
    await act(async () => Promise.resolve());
    expect(screen.getByText("Column sales is ready and will copy after the current write finishes.")).toBeTruthy();

    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await act(async () => cityWrite.resolve());
    await act(async () => Promise.resolve());

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Copied 2 cells from column sales without its header.")).toBeNull();
  });

  it("keeps a disposed grid's unresolved write ahead of its replacement grid", async () => {
    const oldWrite = deferred<void>();
    writeText.mockImplementationOnce(() => oldWrite.promise).mockResolvedValue(undefined);
    const original = renderGrid();
    const milan = screen.getByRole("cell", { name: "Milan" });
    const emptySales = screen.getByRole("cell", { name: "" });
    pointerDrag(milan, emptySales, 74);
    fireEvent.keyDown(emptySales, { key: "c", ctrlKey: true });
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    original.unmount();

    renderGrid("view-b");
    const replacementMilan = screen.getByRole("cell", { name: "Milan" });
    const replacementSales = screen.getByRole("cell", { name: "" });
    pointerDrag(replacementMilan, replacementSales, 75);
    fireEvent.keyDown(replacementSales, { key: "c", ctrlKey: true });
    await act(async () => Promise.resolve());

    try {
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(screen.getByText("Wait for the current clipboard copy to finish.")).toBeTruthy();
    } finally {
      await act(async () => oldWrite.resolve());
    }

    fireEvent.keyDown(replacementSales, { key: "c", ctrlKey: true });
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    expect(writeText).toHaveBeenLastCalledWith("Milan\t10.5\nParis\t");
  });

  it("does not publish or restore a delayed copy after grid focus moves elsewhere", async () => {
    const delayedWrite = deferred<void>();
    writeText.mockImplementationOnce(() => delayedWrite.promise);
    render(
      <>
        <button type="button">Outside grid</button>
        {grid("view-a")}
      </>
    );
    const milan = screen.getByRole("cell", { name: "Milan" });
    const emptySales = screen.getByRole("cell", { name: "" });
    pointerDrag(milan, emptySales, 36);
    openClipboardMenu(milan, 37);
    fireEvent.click(
      within(screen.getByRole("menu", { name: "Cell and range actions for city" })).getByRole("menuitem", {
        name: "Copy selection"
      })
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const outside = screen.getByRole("button", { name: "Outside grid" });
    act(() => outside.focus());

    await act(async () => delayedWrite.resolve());

    expect(document.activeElement).toBe(outside);
    expect(screen.getByRole("menu", { name: "Cell and range actions for city" })).toBeInTheDocument();
    expect(screen.queryByText("Copied 2 by 2 cell range.")).toBeNull();
  });

  it("makes a delayed copy inert after view replacement or disposal", async () => {
    const staleViewWrite = deferred<void>();
    writeText.mockImplementationOnce(() => staleViewWrite.promise);
    const rendered = renderGrid();
    const milan = screen.getByRole("cell", { name: "Milan" });
    const emptySales = screen.getByRole("cell", { name: "" });
    pointerDrag(milan, emptySales, 38);
    openClipboardMenu(milan, 39);
    fireEvent.click(
      within(screen.getByRole("menu", { name: "Cell and range actions for city" })).getByRole("menuitem", {
        name: "Copy selection"
      })
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const staleReceipt = clipboardSettlementReceipt();
    expect(staleReceipt).toMatchObject({ mode: "range", status: "pending" });

    rendered.rerender(grid("view-b"));
    expect(clipboardSettlementReceipt()).toEqual({ id: staleReceipt.id, mode: "none", status: "idle" });
    await act(async () => staleViewWrite.resolve());
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByText("Copied 2 by 2 cell range.")).toBeNull();
    expect(clipboardSettlementReceipt()).toEqual({ id: staleReceipt.id, mode: "none", status: "idle" });

    const disposedWrite = deferred<void>();
    writeText.mockImplementationOnce(() => disposedWrite.promise);
    const replacementMilan = screen.getByRole("cell", { name: "Milan" });
    const replacementSales = screen.getByRole("cell", { name: "" });
    pointerDrag(replacementMilan, replacementSales, 40);
    openClipboardMenu(replacementMilan, 41);
    fireEvent.click(
      within(screen.getByRole("menu", { name: "Cell and range actions for city" })).getByRole("menuitem", {
        name: "Copy selection"
      })
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    rendered.unmount();

    await act(async () => disposedWrite.resolve());
    expect(writeText).toHaveBeenCalledTimes(2);
  });

  it("leaves a never-settling range write pending for its external lifecycle owner", async () => {
    vi.useFakeTimers();
    const unsettledWrite = deferred<void>();
    try {
      writeText.mockImplementationOnce(() => unsettledWrite.promise);
      renderGrid();
      const milan = screen.getByRole("cell", { name: "Milan" });
      const emptySales = screen.getByRole("cell", { name: "" });
      pointerDrag(milan, emptySales, 70);

      fireEvent.keyDown(emptySales, { key: "c", ctrlKey: true });
      const pending = clipboardSettlementReceipt();
      openClipboardMenu(milan, 71);
      fireEvent.click(
        within(screen.getByRole("menu", { name: "Cell and range actions for city" })).getByRole("menuitem", {
          name: "Copy selection"
        })
      );
      fireEvent.keyDown(emptySales, { key: "c", ctrlKey: true });
      await vi.advanceTimersByTimeAsync(30_000);

      expect(clipboardSettlementReceipt()).toEqual(pending);
      expect(pending).toMatchObject({ mode: "range", status: "pending" });
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(screen.queryByText(/Copied 2 by 2|Could not write/u)).toBeNull();
    } finally {
      await act(async () => unsettledWrite.resolve());
      vi.useRealTimers();
    }
  });

  it("dismisses a pre-restore range menu before its action can copy the replacement selection", async () => {
    const rendered = renderGrid("view-a", page, metadata, 0);
    const milan = screen.getByRole("cell", { name: "Milan" });
    const emptySales = screen.getByRole("cell", { name: "" });
    pointerDrag(milan, emptySales, 51);
    openClipboardMenu(milan, 52);

    rendered.rerender(grid("view-a", page, metadata, 1));
    expect(screen.getByText("1 cell selected, row 1, column 1")).toBeTruthy();
    const staleMenu = screen.queryByRole("menu", { name: "Cell and range actions for city" });
    if (staleMenu) {
      fireEvent.click(within(staleMenu).getByRole("menuitem", { name: "Copy selection" }));
      await act(async () => Promise.resolve());
    }

    expect(writeText).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByText(/Copied|Could not write/u)).toBeNull();
  });

  it.each(["success", "fallback"] as const)(
    "makes a delayed menu copy %s inert after a same-view restore",
    async (outcome) => {
      const delayedWrite = deferred<void>();
      writeText.mockImplementationOnce(() => delayedWrite.promise);
      const execCommand = vi.fn(() => true);
      Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
      const rendered = renderGrid("view-a", page, metadata, 0);
      const milan = screen.getByRole("cell", { name: "Milan" });
      const emptySales = screen.getByRole("cell", { name: "" });
      pointerDrag(milan, emptySales, 53);
      openClipboardMenu(milan, 54);
      fireEvent.click(
        within(screen.getByRole("menu", { name: "Cell and range actions for city" })).getByRole("menuitem", {
          name: "Copy selection"
        })
      );
      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

      rendered.rerender(grid("view-a", page, metadata, 1));
      if (outcome === "success") await act(async () => delayedWrite.resolve());
      else await act(async () => delayedWrite.reject(new Error("stale menu adapter denial")));

      expect(execCommand).not.toHaveBeenCalled();
      expect(screen.queryByRole("menu")).toBeNull();
      expect(screen.queryByText(/Copied 2 by 2|Could not write/u)).toBeNull();
      expect(document.activeElement).not.toBe(emptySales);
      expect(screen.getByText("1 cell selected, row 1, column 1")).toBeTruthy();
    }
  );

  it("makes a toolbar copy inert when its exact view is replaced before fallback", async () => {
    const delayedWrite = deferred<void>();
    writeText.mockImplementationOnce(() => delayedWrite.promise);
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    const rendered = renderGrid();
    const milan = screen.getByRole("cell", { name: "Milan" });
    const emptySales = screen.getByRole("cell", { name: "" });
    pointerDrag(milan, emptySales, 45);

    fireEvent.click(screen.getByRole("button", { name: "Copy range" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    rendered.rerender(grid("view-b"));
    await act(async () => delayedWrite.reject(new Error("stale toolbar adapter denial")));

    expect(execCommand).not.toHaveBeenCalled();
    expect(screen.queryByText(/Could not write|Copied 2 by 2/u)).toBeNull();
  });

  it("makes a keyboard copy inert when a later selection owns the grid", async () => {
    const delayedWrite = deferred<void>();
    writeText.mockImplementationOnce(() => delayedWrite.promise);
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    renderGrid();
    const milan = screen.getByRole("cell", { name: "Milan" });
    const emptySales = screen.getByRole("cell", { name: "" });
    pointerDrag(milan, emptySales, 46);

    fireEvent.keyDown(emptySales, { key: "c", ctrlKey: true });
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    focusCell(milan);
    await act(async () => delayedWrite.reject(new Error("stale keyboard adapter denial")));

    expect(execCommand).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(milan);
    expect(screen.queryByText(/Could not write|Copied 2 by 2/u)).toBeNull();
  });

  it.each(["toolbar", "header"] as const)(
    "makes a whole-column %s copy inert when its exact view is replaced",
    async (trigger) => {
      const delayedWrite = deferred<void>();
      writeText.mockImplementationOnce(() => delayedWrite.promise);
      const execCommand = vi.fn(() => true);
      Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
      const rendered = renderGrid();
      const cityHeader = screen.getByRole("columnheader", { name: "city" });
      fireEvent.click(cityHeader);
      const request = latestColumnRequest();
      dispatchPage(request, metadata, 0, 2, 2, [cell("Milan"), cell("Paris")]);
      await waitFor(() => expect(screen.getByRole("button", { name: "Copy column" })).toBeEnabled());

      if (trigger === "toolbar") fireEvent.click(screen.getByRole("button", { name: "Copy column" }));
      else fireEvent.keyDown(cityHeader, { key: "c", ctrlKey: true });
      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
      rendered.rerender(grid("view-b"));
      await act(async () => delayedWrite.reject(new Error(`stale ${trigger} adapter denial`)));

      expect(execCommand).not.toHaveBeenCalled();
      expect(screen.queryByText(/Could not write|Copied 2 cells/u)).toBeNull();
    }
  );

  it("defers a re-entrant menu action until the older write settles", async () => {
    const firstWrite = deferred<void>();
    const secondWrite = deferred<void>();
    writeText.mockImplementationOnce(() => firstWrite.promise).mockImplementationOnce(() => secondWrite.promise);
    renderGrid();
    const milan = screen.getByRole("cell", { name: "Milan" });
    const emptySales = screen.getByRole("cell", { name: "" });
    pointerDrag(milan, emptySales, 47);
    openClipboardMenu(milan, 48);
    const copySelection = within(screen.getByRole("menu", { name: "Cell and range actions for city" })).getByRole(
      "menuitem",
      { name: "Copy selection" }
    );
    fireEvent.click(copySelection);
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

    let startNewerAction = true;
    vi.mocked(document.hasFocus).mockImplementation(() => {
      if (startNewerAction) {
        startNewerAction = false;
        fireEvent.click(copySelection);
      }
      return true;
    });
    await act(async () => firstWrite.resolve());

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("menu", { name: "Cell and range actions for city" })).toBeInTheDocument();
    expect(screen.queryByText("Copied 2 by 2 cell range.")).toBeNull();

    fireEvent.click(copySelection);
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    await act(async () => secondWrite.resolve());
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(emptySales);
    expect(screen.getByText("Copied 2 by 2 cell range.")).toBeTruthy();
  });

  it("keeps menu and whole-column ownership live through StrictMode effect replay", async () => {
    render(<StrictMode>{grid("view-a")}</StrictMode>);
    const milan = screen.getByRole("cell", { name: "Milan" });
    const emptySales = screen.getByRole("cell", { name: "" });
    pointerDrag(milan, emptySales, 49);
    openClipboardMenu(milan, 50);
    fireEvent.click(
      within(screen.getByRole("menu", { name: "Cell and range actions for city" })).getByRole("menuitem", {
        name: "Copy selection"
      })
    );

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(emptySales);
    expect(screen.getByText("Copied 2 by 2 cell range.")).toBeTruthy();

    fireEvent.click(screen.getByRole("columnheader", { name: "city" }));
    const request = latestColumnRequest();
    dispatchPage(request, metadata, 0, 2, 2, [cell("Milan"), cell("Paris")]);
    const copyColumn = await screen.findByRole("button", { name: "Copy column" });
    expect(copyColumn).toBeEnabled();
    fireEvent.click(copyColumn);

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Copied 2 cells from column city without its header.")).toBeTruthy();
  });

  it("routes every copy action to the visible whole column instead of a stale prior rectangle", async () => {
    renderGrid();
    const milan = screen.getByRole("cell", { name: "Milan" });
    const paris = screen.getByRole("cell", { name: "Paris" });
    const emptySales = screen.getByRole("cell", { name: "" });
    pointerDrag(milan, emptySales, 21);

    fireEvent.click(screen.getByRole("columnheader", { name: "city" }));
    const request = latestColumnRequest();
    dispatchPage(request, metadata, 0, 2, 2, [cell("Milan"), cell("Paris")]);
    await waitFor(() => expect(screen.getByRole("button", { name: "Copy column" })).toBeEnabled());
    expect(document.querySelectorAll('[data-clipboard-selected="true"]')).toHaveLength(3);
    for (const name of ["Copy cell", "Copy row", "Copy range"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
      expect(screen.getByRole("button", { name })).toHaveAttribute(
        "title",
        "A whole column is selected. Use Copy column."
      );
    }

    expect(fireEvent.pointerDown(paris, { button: 2, buttons: 2, pointerId: 22, pointerType: "mouse" })).toBe(false);
    fireEvent.contextMenu(paris, { button: 2 });

    const menu = screen.getByRole("menu", { name: "Cell and column actions for city" });
    expect(within(menu).queryByRole("menuitem", { name: "Copy selection" })).toBeNull();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy column" }));

    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("Milan\nParis"));
    expect(writeText).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(document.activeElement).toBe(paris));
    expect(screen.getByText("Whole filtered and sorted column city selected, 2 rows.")).toBeTruthy();
    expect(document.querySelectorAll('[data-clipboard-selected="true"]')).toHaveLength(3);

    fireEvent.keyDown(paris, { key: "c", ctrlKey: true });
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    expect(writeText).toHaveBeenLastCalledWith("Milan\nParis");
    expect(writeText).not.toHaveBeenCalledWith("Milan\t10.5\nParis\t");
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
    const menu = screen.getByRole("menu", { name: "Cell and range actions for city" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy selection" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenLastCalledWith("Milan\t10.5\nParis\t");
    expect(document.querySelectorAll('[data-clipboard-selected="true"]')).toHaveLength(4);
  });

  it("keeps an unloaded projected rectangle selected and exposes its disabled context diagnostic", async () => {
    const projectedPage: GridPage = {
      ...page,
      columnIds: ["c:0"],
      rows: page.rows.map((row) => ({ ...row, values: [row.values[0]] }))
    };
    renderGrid("view-a", projectedPage);
    const milan = screen.getByRole("cell", { name: "Milan" });
    const unloadedSales = screen.getByRole("cell", { name: "Loading sales, row 2" });
    pointerDrag(milan, unloadedSales, 25);

    expect(screen.getByText("2 rows by 2 columns selected")).toBeTruthy();
    expect(document.querySelectorAll('[data-clipboard-selected="true"]')).toHaveLength(4);
    expect(fireEvent.pointerDown(milan, { button: 2, buttons: 2, pointerId: 26, pointerType: "mouse" })).toBe(false);
    fireEvent.contextMenu(milan, { button: 2 });

    const menu = screen.getByRole("menu", { name: "Cell and range actions for city" });
    const copySelection = within(menu).getByRole("menuitem", { name: "Copy selection" });
    expect(copySelection).toBeDisabled();
    expect(copySelection).toHaveAttribute("title", "Wait for every selected column to load before copying.");
    expect(screen.getByRole("button", { name: "Copy range" })).toHaveAttribute(
      "title",
      "Wait for every selected column to load before copying."
    );
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(unloadedSales));
    fireEvent.keyDown(unloadedSales, { key: "c", ctrlKey: true });

    expect(await screen.findByText("Wait for every selected column to load before copying.")).toBeTruthy();
    expect(document.querySelectorAll('[data-clipboard-selected="true"]')).toHaveLength(4);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("keeps an oversized rectangle selected and exposes a payload-free context diagnostic", async () => {
    const oversizedPage: GridPage = {
      ...page,
      rows: [{ ...page.rows[0], values: [cell("x".repeat(4 * 1024 * 1024)), numberCell(10.5)] }, page.rows[1]]
    };
    renderGrid("view-a", oversizedPage);
    const start = document.querySelector<HTMLElement>('td[data-grid-row="0"][data-grid-column="0"]');
    const endpoint = screen.getByRole("cell", { name: "" });
    expect(start).not.toBeNull();
    pointerDrag(start!, endpoint, 27);

    const reason = "Copy is limited to 4 MiB of displayed text. Select a smaller range.";
    expect(screen.getByText("2 rows by 2 columns selected")).toBeTruthy();
    expect(document.querySelectorAll('[data-clipboard-selected="true"]')).toHaveLength(4);
    expect(fireEvent.pointerDown(start!, { button: 2, buttons: 2, pointerId: 28, pointerType: "mouse" })).toBe(false);
    fireEvent.contextMenu(start!, { button: 2 });

    const menu = screen.getByRole("menu", { name: "Cell and range actions for city" });
    const copySelection = within(menu).getByRole("menuitem", { name: "Copy selection" });
    expect(copySelection).toBeDisabled();
    expect(copySelection).toHaveAttribute("title", reason);
    expect(screen.getByRole("button", { name: "Copy range" })).toHaveAttribute("title", reason);
    fireEvent.keyDown(menu, { key: "Escape" });
    fireEvent.keyDown(endpoint, { key: "c", ctrlKey: true });

    expect(await screen.findByText(reason)).toBeTruthy();
    expect(document.querySelectorAll('[data-clipboard-selected="true"]')).toHaveLength(4);
    expect(writeText).not.toHaveBeenCalled();
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
    expect(clipboardSettlementReceipt()).toMatchObject({ mode: "cell", status: "failure" });
    expect(screen.queryByText(/denied/u)).toBeNull();
  });

  it("does not publish a failure receipt until the exact navigator write rejects", async () => {
    const delayedFailure = deferred<void>();
    writeText.mockImplementationOnce(() => delayedFailure.promise);
    Object.defineProperty(document, "execCommand", { configurable: true, value: vi.fn(() => false) });
    renderGrid();
    const milan = screen.getByRole("cell", { name: "Milan" });
    const emptySales = screen.getByRole("cell", { name: "" });
    pointerDrag(milan, emptySales, 71);

    fireEvent.keyDown(emptySales, { key: "c", ctrlKey: true });
    const pending = clipboardSettlementReceipt();
    expect(pending).toMatchObject({ mode: "range", status: "pending" });

    await act(async () => delayedFailure.reject(new Error("primary adapter denied")));

    expect(clipboardSettlementReceipt()).toEqual({ ...pending, status: "failure" });
    expect(
      screen.getByText("Could not write to the clipboard. Check this editor's clipboard permissions.")
    ).toBeTruthy();
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
    expect(screen.getByText("Copied 3 cells from column city without its header.")).toBeTruthy();
  });

  it("keeps the header copy action and its progress visible at narrow layouts", async () => {
    const threeRowMetadata: SessionMetadata = {
      ...metadata,
      shape: { rows: 3, columns: 2 },
      filteredShape: { rows: 3, columns: 2 }
    };
    renderGrid("view-a", { ...page, totalRows: 3 }, threeRowMetadata);
    const cityHeader = screen.getByRole("columnheader", { name: "city" });
    const copy = within(cityHeader).getByRole("button", {
      name: "Copy column city; header excluded"
    });

    fireEvent.click(copy);
    const firstRequest = latestColumnRequest();
    expect(
      within(cityHeader).getByRole("button", {
        name: "Copying column city when ready; header excluded"
      })
    ).toHaveAttribute("aria-busy", "true");

    dispatchPage(firstRequest, threeRowMetadata, 0, 2, 3, [cell("Milan"), cell("Paris")]);
    const secondRequest = latestColumnRequest();
    dispatchPage(secondRequest, threeRowMetadata, 2, 1, 3, [cell("Zürich")]);

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith("Milan\nParis\nZürich");
    expect(
      within(cityHeader).getByRole("button", {
        name: "Copy column city; 3 values ready; header excluded"
      })
    ).toBeEnabled();
    expect(screen.getByText("Copied 3 cells from column city without its header.")).toBeTruthy();
  });

  it("exposes copy, sort, menu, and resize as distinct focusable header controls", () => {
    renderGrid("view-a", page, {
      ...metadata,
      filterModel: { filters: [], sort: [{ column: "city", direction: "asc", nulls: "last" }] }
    });
    const cityHeader = screen.getByRole("columnheader", { name: /city, sorted ascending/u });
    const controls = cityHeader.querySelector(".columnHeaderActions");
    expect(controls).not.toBeNull();
    expect(
      within(controls as HTMLElement).getByRole("button", { name: "Copy column city; header excluded" })
    ).toHaveClass("columnSortIndicator");
    expect(within(controls as HTMLElement).getByRole("button", { name: /Clear sort for city/u })).toHaveClass(
      "columnSortIndicator"
    );
    const menu = controls?.querySelector<HTMLElement>('.columnMenu > summary[aria-label="Column actions for city"]');
    const resize = within(cityHeader).getByRole("button", { name: "Resize city column" });
    expect(menu?.tagName).toBe("SUMMARY");
    expect(resize).toHaveClass("columnResizeHandle");

    const headerControls = [
      within(controls as HTMLElement).getByRole("button", { name: "Copy column city; header excluded" }),
      within(controls as HTMLElement).getByRole("button", { name: /Clear sort for city/u }),
      menu,
      resize
    ];
    expect(new Set(headerControls).size).toBe(4);
    for (const control of headerControls) {
      expect(control).toBeTruthy();
      control?.focus();
      expect(control).toHaveFocus();
    }

    resize.focus();
    fireEvent.keyDown(resize, { key: "Home" });
    expect(resize).toHaveFocus();
    expect(within(cityHeader).getByRole("button", { name: "Copy column city; header excluded" })).toBeEnabled();
    expect(cityHeader.querySelector('.columnMenu > summary[aria-label="Column actions for city"]')).toBe(menu);
  });

  it("owns the first platform shortcut through preparation and writes exactly once", async () => {
    renderGrid();
    const salesHeader = screen.getByRole("columnheader", { name: "sales" });
    act(() => salesHeader.focus());

    fireEvent.keyDown(salesHeader, { key: "c", ctrlKey: true });
    const request = latestColumnRequest();
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.getByText("Preparing column sales. Copy will complete when it is ready.")).toBeTruthy();

    dispatchPage(request, metadata, 0, 2, 2, [numberCell(-10.5), numberCell(-20)]);
    dispatchPage(request, metadata, 0, 2, 2, [numberCell(999), numberCell(999)]);

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith("-10.5\n-20");
    expect(document.activeElement).toBe(salesHeader);
  });

  it("uses the bounded fallback once for a first Cmd+C and restores the exact header focus", async () => {
    writeText.mockRejectedValueOnce(new Error("permission denied"));
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    renderGrid();
    const cityHeader = screen.getByRole("columnheader", { name: "city" });
    act(() => cityHeader.focus());

    fireEvent.keyDown(cityHeader, { key: "c", metaKey: true });
    const request = latestColumnRequest();
    dispatchPage(request, metadata, 0, 2, 2, [cell(""), cell("München")]);

    await waitFor(() => expect(execCommand).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(cityHeader);
    expect(screen.getByText("Copied 2 cells from column city without its header.")).toBeTruthy();
  });

  it("does not fallback or restore stale focus after the logical view changes", async () => {
    const primary = deferred<void>();
    writeText.mockImplementationOnce(() => primary.promise);
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    const rendered = renderGrid();
    const cityHeader = screen.getByRole("columnheader", { name: "city" });
    act(() => cityHeader.focus());
    fireEvent.keyDown(cityHeader, { key: "c", ctrlKey: true });
    const request = latestColumnRequest();
    dispatchPage(request, metadata, 0, 2, 2, [cell("Milan"), cell("Paris")]);
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

    rendered.rerender(grid("view-b"));
    const replacement = screen.getByRole("columnheader", { name: "sales" });
    act(() => replacement.focus());
    await act(async () => {
      primary.reject(new Error("permission denied"));
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(execCommand).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(replacement);
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("does not fallback or publish success after document focus leaves the unchanged header", async () => {
    const primary = deferred<void>();
    writeText.mockImplementationOnce(() => primary.promise);
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    renderGrid();
    const cityHeader = screen.getByRole("columnheader", { name: "city" });
    act(() => cityHeader.focus());
    fireEvent.keyDown(cityHeader, { key: "c", ctrlKey: true });
    const request = latestColumnRequest();
    dispatchPage(request, metadata, 0, 2, 2, [cell("Milan"), cell("Paris")]);
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

    vi.mocked(document.hasFocus).mockReturnValue(false);
    expect(document.activeElement).toBe(cityHeader);
    await act(async () => {
      primary.reject(new Error("permission denied"));
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(execCommand).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(cityHeader);
    expect(document.querySelector("textarea")).toBeNull();
    expect(screen.queryByText("Copied 2 cells from column city without its header.")).toBeNull();
    expect(
      screen.getByText(
        "The data view or focus changed before the prepared column could be copied. Select the column again."
      )
    ).toBeTruthy();
  });

  it("serializes two ready column writes without stranding or duplicating the second", async () => {
    const first = deferred<void>();
    writeText.mockImplementationOnce(() => first.promise).mockResolvedValueOnce(undefined);
    renderGrid();
    const cityHeader = screen.getByRole("columnheader", { name: "city" });
    act(() => cityHeader.focus());
    fireEvent.keyDown(cityHeader, { key: "c", ctrlKey: true });
    const cityRequest = latestColumnRequest();
    dispatchPage(cityRequest, metadata, 0, 2, 2, [cell("Milan"), cell("Paris")]);
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

    const salesHeader = screen.getByRole("columnheader", { name: "sales" });
    act(() => salesHeader.focus());
    fireEvent.keyDown(salesHeader, { key: "c", ctrlKey: true });
    const salesRequest = latestColumnRequest();
    dispatchPage(salesRequest, metadata, 0, 2, 2, [numberCell(10.5), numberCell(-20)]);
    dispatchPage(salesRequest, metadata, 0, 2, 2, [numberCell(999), numberCell(999)]);
    expect(writeText).toHaveBeenCalledTimes(1);

    first.resolve();
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    expect(writeText).toHaveBeenNthCalledWith(1, "Milan\nParis");
    expect(writeText).toHaveBeenNthCalledWith(2, "10.5\n-20");
    expect(screen.getByText("Copied 2 cells from column sales without its header.")).toBeTruthy();
    expect(
      within(salesHeader).getByRole("button", {
        name: "Copy column sales; 2 values ready; header excluded"
      })
    ).toBeEnabled();
  });

  it("terminal-latches one never-settling adapter write and immediately rejects later owners", async () => {
    vi.useFakeTimers();
    const first = deferred<void>();
    writeText.mockImplementationOnce(() => first.promise);
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    const rendered = renderGrid();
    const cityHeader = screen.getByRole("columnheader", { name: "city" });
    act(() => cityHeader.focus());
    fireEvent.keyDown(cityHeader, { key: "c", ctrlKey: true });
    const cityRequest = latestColumnRequest();
    dispatchPage(cityRequest, metadata, 0, 2, 2, [cell("Milan"), cell("Paris")]);
    await act(async () => Promise.resolve());
    expect(writeText).toHaveBeenCalledTimes(1);

    const salesHeader = screen.getByRole("columnheader", { name: "sales" });
    act(() => salesHeader.focus());
    fireEvent.keyDown(salesHeader, { key: "c", ctrlKey: true });
    const salesRequest = latestColumnRequest();
    dispatchPage(salesRequest, metadata, 0, 2, 2, [numberCell(10.5), numberCell(-20)]);
    await act(async () => Promise.resolve());
    expect(writeText).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_001);
    });
    expect(
      screen.getByText("Clipboard access did not settle. Reload this data editor before copying another column.")
    ).toBeTruthy();

    const requestCount = vscodePostMessage.mock.calls.length;
    act(() => cityHeader.focus());
    fireEvent.keyDown(cityHeader, { key: "c", ctrlKey: true });
    await act(async () => Promise.resolve());
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(vscodePostMessage).toHaveBeenCalledTimes(requestCount);
    expect(
      screen.getByText("Clipboard access did not settle. Reload this data editor before copying another column.")
    ).toBeTruthy();

    rendered.unmount();
    await act(async () => {
      first.reject(new Error("late permission failure"));
      await Promise.resolve();
    });
    expect(execCommand).not.toHaveBeenCalled();
    expect(document.querySelector("textarea")).toBeNull();
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

function renderGrid(viewContextId = "view-a", activePage = page, activeMetadata = metadata, restoreVersion = 0) {
  return render(grid(viewContextId, activePage, activeMetadata, restoreVersion));
}

function grid(viewContextId: string, activePage = page, activeMetadata = metadata, restoreVersion = 0) {
  return (
    <DataGrid
      metadata={activeMetadata}
      page={activePage}
      summaries={[]}
      pageSize={2}
      defaultColumnWidth={190}
      insightsOnOpen={false}
      viewContextId={viewContextId}
      viewStateRestoreVersion={restoreVersion}
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

function openClipboardMenu(cell: HTMLElement, pointerId: number): void {
  expect(fireEvent.pointerDown(cell, { button: 2, buttons: 2, pointerId, pointerType: "mouse" })).toBe(false);
  fireEvent.contextMenu(cell, { button: 2 });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function clipboardSettlementReceipt() {
  const status = screen.getByRole("status", { name: "Clipboard copy result" });
  return {
    id: Number(status.getAttribute("data-grid-clipboard-settlement-id")),
    mode: status.getAttribute("data-grid-clipboard-settlement-mode"),
    status: status.getAttribute("data-grid-clipboard-settlement-status")
  };
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
