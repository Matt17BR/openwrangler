import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GridPage, SessionMetadata } from "../shared/protocol";
import type { GridViewState } from "../shared/viewState";
import { DataGrid } from "../webviews/grid/DataGrid";

const metadata: SessionMetadata = {
  protocolVersion: 2,
  sessionId: "resize-session",
  revision: 1,
  backend: "pandas",
  mode: "editing",
  source: { kind: "file", label: "resize.csv", path: "resize.csv" },
  capabilities: {
    editable: true,
    lazy: false,
    cancel: true,
    exportCsv: true,
    exportParquet: true,
    notebookInsert: false
  },
  shape: { rows: 1, columns: 2 },
  filteredShape: { rows: 1, columns: 2 },
  filterModel: { filters: [], sort: [] },
  steps: [],
  schema: [
    { id: "__proto__", name: "prototype", position: 0, rawType: "object", type: "string", nullable: false },
    { id: "列😀", name: "unicode", position: 1, rawType: "object", type: "string", nullable: false }
  ]
};

const page: GridPage = {
  offset: 0,
  limit: 1,
  totalRows: 1,
  columnIds: metadata.schema.map((column) => column.id),
  rows: [
    {
      id: "row:0",
      rowNumber: 0,
      values: [stringCell("prototype value"), stringCell("Unicode value")]
    }
  ]
};

describe("DataGrid column resizing", () => {
  let setPointerCaptureDescriptor: PropertyDescriptor | undefined;
  let releasePointerCaptureDescriptor: PropertyDescriptor | undefined;
  let setPointerCapture: ReturnType<typeof vi.fn>;
  let releasePointerCapture: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setPointerCaptureDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "setPointerCapture");
    releasePointerCaptureDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "releasePointerCapture");
    setPointerCapture = vi.fn();
    releasePointerCapture = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
      configurable: true,
      value: setPointerCapture
    });
    Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
      configurable: true,
      value: releasePointerCapture
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restorePrototypeProperty("setPointerCapture", setPointerCaptureDescriptor);
    restorePrototypeProperty("releasePointerCapture", releasePointerCaptureDescriptor);
  });

  it("resizes and restores prototype-name and Unicode column IDs without object-key coercion", () => {
    const onViewStateChange = vi.fn();
    render(<GridHarness onViewStateChange={onViewStateChange} />);

    fireEvent.keyDown(screen.getByRole("button", { name: "Resize prototype column" }), { key: "ArrowRight" });
    fireEvent.keyDown(screen.getByRole("button", { name: "Resize unicode column" }), { key: "End" });

    const latest = onViewStateChange.mock.calls.at(-1)?.[0] as GridViewState;
    expect(latest.columnWidths).toBeInstanceOf(Map);
    expect([...latest.columnWidths]).toEqual([
      ["__proto__", 200],
      ["列😀", 640]
    ]);
    expect(document.querySelectorAll("col")[1]).toHaveStyle({ width: "200px" });
    expect(document.querySelectorAll("col")[2]).toHaveStyle({ width: "640px" });
  });

  it.each([
    ["pointerup", (pointerId: number) => fireEvent.pointerUp(window, pointerEvent(pointerId, 130))],
    ["pointercancel", (pointerId: number) => fireEvent.pointerCancel(window, pointerEvent(pointerId, 130))]
  ])("removes the active drag on %s", (_eventName, finish) => {
    const onViewStateChange = vi.fn();
    render(<GridHarness onViewStateChange={onViewStateChange} />);
    const resize = screen.getByRole("button", { name: "Resize prototype column" });

    fireEvent.pointerDown(resize, pointerEvent(7, 100));
    fireEvent.pointerMove(window, pointerEvent(7, 120));
    expect(onViewStateChange).toHaveBeenCalledTimes(1);

    finish(7);
    fireEvent.pointerMove(window, pointerEvent(7, 180));

    expect(onViewStateChange).toHaveBeenCalledTimes(1);
    expect(releasePointerCapture).toHaveBeenCalledWith(7);
  });

  it("removes the active drag when pointer capture is lost", () => {
    const onViewStateChange = vi.fn();
    render(<GridHarness onViewStateChange={onViewStateChange} />);
    const resize = screen.getByRole("button", { name: "Resize prototype column" });

    fireEvent.pointerDown(resize, pointerEvent(11, 100));
    fireEvent.pointerMove(window, pointerEvent(11, 120));
    fireEvent(resize, lostPointerCaptureEvent(11));
    fireEvent.pointerMove(window, pointerEvent(11, 180));

    expect(onViewStateChange).toHaveBeenCalledTimes(1);
    expect(releasePointerCapture).toHaveBeenCalledWith(11);
  });

  it("removes the active drag on window blur", () => {
    const onViewStateChange = vi.fn();
    render(<GridHarness onViewStateChange={onViewStateChange} />);
    const resize = screen.getByRole("button", { name: "Resize prototype column" });

    fireEvent.pointerDown(resize, pointerEvent(13, 100));
    fireEvent.pointerMove(window, pointerEvent(13, 120));
    fireEvent.blur(window);
    fireEvent.pointerMove(window, pointerEvent(13, 180));

    expect(onViewStateChange).toHaveBeenCalledTimes(1);
    expect(releasePointerCapture).toHaveBeenCalledWith(13);
  });

  it("removes the active drag when the grid unmounts", () => {
    const onViewStateChange = vi.fn();
    const view = render(<GridHarness onViewStateChange={onViewStateChange} />);
    const resize = screen.getByRole("button", { name: "Resize prototype column" });

    fireEvent.pointerDown(resize, pointerEvent(17, 100));
    fireEvent.pointerMove(window, pointerEvent(17, 120));
    view.unmount();
    fireEvent.pointerMove(window, pointerEvent(17, 180));

    expect(onViewStateChange).toHaveBeenCalledTimes(1);
    expect(releasePointerCapture).toHaveBeenCalledWith(17);
  });

  it("replaces an incomplete drag without retaining stale handlers or accumulating the wrong column", () => {
    const onViewStateChange = vi.fn();
    render(<GridHarness onViewStateChange={onViewStateChange} />);
    const prototypeResize = screen.getByRole("button", { name: "Resize prototype column" });
    const unicodeResize = screen.getByRole("button", { name: "Resize unicode column" });

    fireEvent.pointerDown(prototypeResize, pointerEvent(19, 100));
    fireEvent.pointerMove(window, pointerEvent(19, 120));
    fireEvent.pointerDown(unicodeResize, pointerEvent(23, 100));
    const callsBeforeStaleMove = onViewStateChange.mock.calls.length;

    fireEvent.pointerMove(window, pointerEvent(19, 180));
    expect(onViewStateChange).toHaveBeenCalledTimes(callsBeforeStaleMove);
    fireEvent.pointerMove(window, pointerEvent(23, 130));

    const latest = onViewStateChange.mock.calls.at(-1)?.[0] as GridViewState;
    expect([...latest.columnWidths]).toEqual([
      ["__proto__", 210],
      ["列😀", 220]
    ]);
    expect(setPointerCapture.mock.calls).toEqual([[19], [23]]);
    expect(releasePointerCapture).toHaveBeenCalledWith(19);

    fireEvent.pointerUp(window, pointerEvent(23, 130));
    fireEvent.pointerMove(window, pointerEvent(23, 200));
    expect(onViewStateChange.mock.calls.at(-1)?.[0]).toBe(latest);
  });
});

function GridHarness({ onViewStateChange }: { onViewStateChange(state: GridViewState): void }) {
  const [viewState, setViewState] = useState<GridViewState>({
    columnWidths: new Map(),
    viewport: { firstVisibleRow: 0, scrollLeft: 0 }
  });
  return (
    <DataGrid
      metadata={metadata}
      page={page}
      summaries={[]}
      pageSize={1}
      defaultColumnWidth={190}
      insightsOnOpen={false}
      viewState={viewState}
      onViewStateChange={(next) => {
        onViewStateChange(next);
        setViewState(next);
      }}
      onPage={() => undefined}
      onSortColumn={() => undefined}
      onOpenFilter={() => undefined}
      onVisibleSummaryColumnsChange={() => undefined}
    />
  );
}

function stringCell(display: string) {
  return { kind: "string" as const, raw: display, display, isNull: false, isNaN: false };
}

function pointerEvent(pointerId: number, clientX: number) {
  return { button: 0, buttons: 1, clientX, pointerId, pointerType: "mouse" };
}

function lostPointerCaptureEvent(pointerId: number): Event {
  const event = new Event("lostpointercapture");
  Object.defineProperty(event, "pointerId", { value: pointerId });
  return event;
}

function restorePrototypeProperty(property: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(HTMLElement.prototype, property, descriptor);
  else Reflect.deleteProperty(HTMLElement.prototype, property);
}
