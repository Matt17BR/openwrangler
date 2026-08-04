import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  findExactActiveNotebookPreviewButton,
  findExactActiveNotebookRendererButton,
  observeGridScrollability,
  observeInlinePreviewReady
} from "./extensionHost/notebookRendererFrame";

describe("authoritative notebook renderer frame selection", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("rejects a visible pending guest and activates only the settled active guest", () => {
    const pending = notebookGuest("pending-frame", "orders", "Open in Open Wrangler");
    const active = notebookGuest("active-frame", "orders", "Open in Open Wrangler");
    const pendingActivation = vi.fn();
    const activeActivation = vi.fn();
    pending.button.addEventListener("click", pendingActivation);
    active.button.addEventListener("click", activeActivation);

    expect(
      findExactActiveNotebookRendererButton({
        expectedLabel: "orders",
        expectedButtonName: "Open in Open Wrangler"
      })
    ).toBeNull();

    pending.frame.remove();
    const selected = findExactActiveNotebookRendererButton({
      expectedLabel: "orders",
      expectedButtonName: "Open in Open Wrangler"
    });
    expect(selected).toBe(active.button);
    (selected as HTMLButtonElement).click();
    expect(activeActivation).toHaveBeenCalledOnce();
    expect(pendingActivation).not.toHaveBeenCalled();
  });

  it("rejects ambiguous retained active guests instead of choosing one by discovery order", () => {
    notebookGuest("active-frame", "orders", "Open in Open Wrangler");
    notebookGuest("active-frame", "orders", "Open in Open Wrangler");

    expect(
      findExactActiveNotebookRendererButton({
        expectedLabel: "orders",
        expectedButtonName: "Open in Open Wrangler"
      })
    ).toBeNull();
  });

  it("resolves a generic public preview action from the settled active guest", () => {
    const guest = notebookGuest("active-frame", "orders", "Open Data Wrangler");
    appendPreviewTable(guest.section);
    expect(
      findExactActiveNotebookPreviewButton({
        expectedButtonNames: ["Open Data Wrangler", "Open in Data Wrangler"],
        requiredLabels: ["c00", "c01", "0", "1"]
      })
    ).toBe(guest.button);
  });

  it("does not borrow preview sentinels from a sibling output", () => {
    const guest = notebookGuest("active-frame", "orders", "Open Data Wrangler");
    const siblingOutput = guest.frame.contentDocument?.createElement("section");
    if (!siblingOutput) throw new Error("The DOM test environment did not create an iframe document.");
    siblingOutput.dataset.outputId = "sibling";
    appendPreviewTable(siblingOutput);
    guest.frame.contentDocument?.body.append(siblingOutput);

    expect(
      findExactActiveNotebookPreviewButton({
        expectedButtonNames: ["Open Data Wrangler", "Open in Data Wrangler"],
        requiredLabels: ["c00", "c01", "0", "1"]
      })
    ).toBeNull();
    expect(
      observeInlinePreviewReady(guest.button, {
        actionName: "Open Data Wrangler",
        firstColumn: "c00",
        secondColumn: "c01"
      })
    ).toBe(false);
  });

  it("accepts inline sentinels inside the action's own output", () => {
    const guest = notebookGuest("active-frame", "orders", "Open Data Wrangler");
    const table = appendPreviewTable(guest.section);
    show(table, { left: 20, top: 20, width: 300, height: 120 });

    expect(
      observeInlinePreviewReady(guest.button, {
        actionName: "Open Data Wrangler",
        firstColumn: "c00",
        secondColumn: "c01"
      })
    ).toBe(true);
  });

  it("requires a viewport hit on the grid before reporting pointer usability", () => {
    const grid = document.createElement("div");
    grid.setAttribute("role", "grid");
    const firstHeader = document.createElement("div");
    firstHeader.setAttribute("role", "columnheader");
    firstHeader.textContent = "c00";
    const secondHeader = document.createElement("div");
    secondHeader.setAttribute("role", "columnheader");
    secondHeader.textContent = "c01";
    const hitChild = document.createElement("div");
    grid.append(firstHeader, secondHeader, hitChild);
    document.body.append(grid);
    show(grid, { left: 10, top: 10, width: 200, height: 100 });
    Object.defineProperties(grid, {
      clientHeight: { configurable: true, value: 100 },
      clientWidth: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 500 },
      scrollWidth: { configurable: true, value: 450 }
    });

    const overlay = document.createElement("div");
    document.body.append(overlay);
    const elementFromPoint = vi.fn<(_: number, __: number) => Element | null>().mockReturnValue(overlay);
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: elementFromPoint });
    expect(observeGridScrollability()).toBeNull();

    elementFromPoint.mockReturnValue(hitChild);
    expect(observeGridScrollability()).toEqual({
      verticalOverflow: 400,
      horizontalOverflow: 250,
      pointerUsable: true
    });
    expect(elementFromPoint).toHaveBeenCalledWith(110, 60);
  });
});

function notebookGuest(id: "active-frame" | "pending-frame", label: string, action: string) {
  const frame = document.createElement("iframe");
  frame.id = id;
  document.body.append(frame);
  const guest = frame.contentDocument;
  if (!guest) throw new Error("The DOM test environment did not create an iframe document.");

  const section = guest.createElement("section");
  section.className = "openwrangler-notebook";
  const header = guest.createElement("header");
  const title = guest.createElement("span");
  title.textContent = `Open Wrangler preview: ${label} (duckdb) - 10 x 2`;
  const button = guest.createElement("button");
  button.textContent = action;
  header.append(title, button);
  section.append(header);
  guest.body.append(section);
  return { frame, button, section };
}

function appendPreviewTable(output: HTMLElement): HTMLTableElement {
  const table = output.ownerDocument.createElement("table");
  const head = output.ownerDocument.createElement("thead");
  const headerRow = output.ownerDocument.createElement("tr");
  for (const label of ["c00", "c01"]) {
    const header = output.ownerDocument.createElement("th");
    header.textContent = label;
    headerRow.append(header);
  }
  const body = output.ownerDocument.createElement("tbody");
  const row = output.ownerDocument.createElement("tr");
  for (const label of ["0", "1"]) {
    const cell = output.ownerDocument.createElement("td");
    cell.textContent = label;
    row.append(cell);
  }
  head.append(headerRow);
  body.append(row);
  table.append(head, body);
  output.append(table);
  return table;
}

function show(
  element: Element,
  box: { readonly left: number; readonly top: number; readonly width: number; readonly height: number }
): void {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    ...box,
    x: box.left,
    y: box.top,
    right: box.left + box.width,
    bottom: box.top + box.height,
    toJSON: () => ({})
  });
}
