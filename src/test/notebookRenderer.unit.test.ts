import { describe, expect, it, vi } from "vitest";
import { activate } from "../webviews/notebookRenderer";

describe("notebook renderer", () => {
  it("registers the supported built-in HTML postRender hook for inline upgrades", async () => {
    let receiver: ((message: unknown) => void) | undefined;
    let hook:
      | {
          postRender(
            item: { id: string; mime: string; data(): Uint8Array },
            element: HTMLElement,
            signal: AbortSignal
          ): Promise<void>;
        }
      | undefined;
    const registerHook = vi.fn((value) => {
      hook = value;
    });
    const getRenderer = vi.fn(async () => ({ experimental_registerHtmlRenderingHook: registerHook }));
    const postMessage = vi.fn();

    const api = activate({
      getRenderer,
      onDidReceiveMessage: (listener: (message: unknown) => void) => {
        receiver = listener;
      },
      postMessage
    } as never);
    await Promise.resolve();

    expect(getRenderer).toHaveBeenCalledWith("vscode.builtin-renderer");
    expect(registerHook).toHaveBeenCalledOnce();
    expect(api.renderOutputItem).toBeTypeOf("function");
    const secondGetRenderer = vi.fn(async () => ({ experimental_registerHtmlRenderingHook: registerHook }));
    const secondApi = activate({
      getRenderer: secondGetRenderer,
      onDidReceiveMessage: vi.fn(),
      postMessage: vi.fn()
    } as never);
    expect(secondApi.renderOutputItem).toBeTypeOf("function");
    expect(secondGetRenderer).not.toHaveBeenCalled();
    expect(registerHook.mock.calls[0]?.[0]).toMatchObject({ postRender: expect.any(Function) });

    const controller = new AbortController();
    const element = document.createElement("div");
    const ordinary = document.createElement("table");
    ordinary.dataset.originalHtml = "true";
    element.appendChild(ordinary);
    const bytes = new TextEncoder().encode("<table><tr><td>1</td></tr></table>");
    await hook?.postRender({ id: "output-1", mime: "text/html", data: () => bytes }, element, controller.signal);
    const candidate = postMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(candidate).toEqual({
      kind: "openWrangler.inlineCandidate",
      protocol: 1,
      token: expect.stringMatching(/^[a-f0-9]{32}$/u),
      outputItemId: "output-1",
      byteLength: bytes.byteLength,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
    });

    receiver?.({ ...candidate, kind: "openWrangler.inlineUpgrade", payload: { mimeVersion: 2 } });
    expect(element.querySelector("[data-open-wrangler-inline-upgrade]")).toBeNull();
    receiver?.({ ...candidate, kind: "openWrangler.inlineUpgrade", payload: canonicalPayload(1, "frame") });
    receiver?.({ ...candidate, kind: "openWrangler.inlineUpgrade", payload: canonicalPayload(1, "frame") });
    expect(element.querySelectorAll("[data-open-wrangler-inline-upgrade]")).toHaveLength(1);
    expect(element.querySelector("[data-original-html]")).toBeNull();
    expect(element.querySelectorAll("table")).toHaveLength(1);

    receiver?.({
      kind: "openWrangler.inlineRevoke",
      protocol: 1,
      token: candidate.token,
      outputItemId: "output-1",
      byteLength: candidate.byteLength,
      sha256: candidate.sha256
    });
    expect(element.querySelector("[data-open-wrangler-inline-upgrade]")).toBeNull();
    expect(element.querySelector("[data-original-html]")).toBe(ordinary);
    expect(element.querySelectorAll("table")).toHaveLength(1);

    await hook?.postRender({ id: "output-1", mime: "text/html", data: () => bytes }, element, controller.signal);
    const replacementCandidate = postMessage.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    receiver?.({
      ...replacementCandidate,
      kind: "openWrangler.inlineUpgrade",
      payload: canonicalPayload(1, "frame")
    });
    expect(element.querySelector("[data-original-html]")).toBeNull();

    controller.abort();
    expect(element.querySelector("[data-open-wrangler-inline-upgrade]")).toBeNull();
    expect(element.querySelector("[data-original-html]")).toBe(ordinary);
    expect(postMessage).toHaveBeenLastCalledWith({
      kind: "openWrangler.inlineCancel",
      protocol: 1,
      token: replacementCandidate.token,
      outputItemId: "output-1"
    });

    postMessage.mockClear();
    const retainedControllers: AbortController[] = [];
    for (let index = 0; index < 128; index += 1) {
      const retainedController = new AbortController();
      retainedControllers.push(retainedController);
      const retainedElement = document.createElement("div");
      retainedElement.appendChild(document.createElement("table"));
      await hook?.postRender(
        { id: `retained-${index}`, mime: "text/html", data: () => bytes },
        retainedElement,
        retainedController.signal
      );
    }
    const freshController = new AbortController();
    const freshElement = document.createElement("div");
    freshElement.appendChild(document.createElement("table"));
    await hook?.postRender(
      { id: "fresh-after-128", mime: "text/html", data: () => bytes },
      freshElement,
      freshController.signal
    );
    expect(postMessage.mock.calls.at(-1)?.[0]).toMatchObject({
      kind: "openWrangler.inlineCandidate",
      outputItemId: "fresh-after-128"
    });
    for (const retainedController of retainedControllers) retainedController.abort();
    freshController.abort();

    vi.useFakeTimers();
    try {
      postMessage.mockClear();
      const deadlineElement = document.createElement("div");
      const deadlineOrdinary = document.createElement("table");
      deadlineElement.appendChild(deadlineOrdinary);
      await hook?.postRender(
        { id: "deadline-output", mime: "text/html", data: () => bytes },
        deadlineElement,
        new AbortController().signal
      );
      await vi.advanceTimersByTimeAsync(10_000);
      expect(deadlineElement.firstChild).toBe(deadlineOrdinary);
      expect(postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind: "openWrangler.inlineCancel", outputItemId: "deadline-output" })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows compact capture paging and forwards only the validated canonical payload", () => {
    const postMessage = vi.fn();
    const element = document.createElement("div");
    const payload = canonicalPayload(10, "frame");

    activate({ postMessage }).renderOutputItem({ json: () => payload }, element);

    expect(element.querySelector('[role="status"]')?.textContent).toBe("1-1 of 1 captured · 10 total");
    const button = element.querySelector("button");
    expect(button?.textContent).toBe("Open in Open Wrangler");
    button?.click();
    expect(postMessage).toHaveBeenCalledWith({ kind: "openInOpenWrangler", payload });
  });

  it("keeps one clear action and opens the complete linked live variable", () => {
    const postMessage = vi.fn();
    const element = document.createElement("div");
    const payload = canonicalPayload(1, "frame");

    activate({ postMessage }).renderOutputItem({ json: () => payload }, element);

    const actions = Array.from(element.querySelectorAll("button")).filter((button) =>
      button.textContent?.startsWith("Open")
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]?.textContent).toBe("Open in Open Wrangler");
    expect(actions[0]?.title).toContain("complete current value of frame");
    expect(element.querySelector("table")?.getAttribute("aria-label")).toBe(
      "Open Wrangler inline preview of saved frame"
    );

    actions[0]?.click();
    expect(postMessage).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledWith({ kind: "openInOpenWrangler", payload });
  });

  it("opens a current temporary result without exposing its opaque handle", () => {
    const postMessage = vi.fn();
    const element = document.createElement("div");
    const handle = "__openwrangler_live_result_0123456789abcdef0123456789abcdef";
    const payload = canonicalPayload(1, handle);

    activate({ postMessage }).renderOutputItem({ json: () => payload }, element);

    const action = Array.from(element.querySelectorAll("button")).find(
      (button) => button.textContent === "Open in Open Wrangler"
    );
    expect(action?.title).toBe("Open the complete current notebook result");
    expect(element.textContent).not.toContain(handle);
    action?.click();
    expect(postMessage).toHaveBeenCalledWith({ kind: "openInOpenWrangler", payload });
  });

  it("keeps an unlinked legacy preview inline without a false rerun instruction", () => {
    const postMessage = vi.fn();
    const element = document.createElement("div");
    const payload = canonicalPayload(1);

    activate({ postMessage }).renderOutputItem({ json: () => payload }, element);

    expect(
      Array.from(element.querySelectorAll("button")).some((button) => button.textContent === "Open in Open Wrangler")
    ).toBe(false);
    expect(element.querySelector('[role="note"]')).toBeNull();
    expect(element.textContent).not.toContain("Run this cell again");
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("rejects capability-elevated notebook metadata before rendering an action", () => {
    const element = document.createElement("div");
    const payload = canonicalPayload(1);

    activate({ postMessage: vi.fn() }).renderOutputItem(
      {
        json: () => ({
          ...payload,
          metadata: {
            ...payload.metadata,
            capabilities: { ...payload.metadata.capabilities, editable: true }
          }
        })
      },
      element
    );

    expect(element.querySelector('[role="alert"]')?.textContent).toContain(
      "malformed or uses an unsupported MIME version"
    );
    expect(element.querySelector("button")).toBeNull();
  });

  it("keeps the saved preview readable when extension-host messaging is unavailable", () => {
    const element = document.createElement("div");

    activate({}).renderOutputItem({ json: () => canonicalPayload(1, "frame") }, element);

    expect(element.querySelector("section.openwrangler-notebook")?.textContent).toContain(
      "Open Wrangler preview: saved frame"
    );
    expect(element.querySelector("table")?.textContent).toContain("value");
    expect(
      Array.from(element.querySelectorAll("button")).some((button) => button.textContent?.startsWith("Open"))
    ).toBe(false);
  });

  it("renders every captured column and pages rows at 10, 20, 50, or 100 per page", () => {
    const postMessage = vi.fn();
    const element = document.createElement("div");
    const payload = widePayload(25, 24);

    activate({ postMessage }).renderOutputItem({ json: () => payload }, element);

    expect(element.querySelectorAll("thead th")).toHaveLength(24);
    expect(element.querySelectorAll("tbody tr")).toHaveLength(20);
    expect(element.querySelectorAll("tbody td")).toHaveLength(480);
    expect(element.querySelector('[data-testid="inline-preview-page"]')?.textContent).toBe("1-20 of 25");
    const pageSize = element.querySelector<HTMLSelectElement>('select[aria-label="Rows per notebook preview page"]');
    expect(Array.from(pageSize?.options ?? []).map((option) => option.value)).toEqual(["10", "20", "50", "100"]);
    const next = Array.from(element.querySelectorAll("button")).find((button) => button.textContent === "Next");
    next?.click();
    expect(element.querySelectorAll("tbody tr")).toHaveLength(5);
    expect(element.querySelector('[data-testid="inline-preview-page"]')?.textContent).toBe("21-25 of 25");
    if (pageSize) {
      pageSize.value = "10";
      pageSize.dispatchEvent(new Event("change"));
    }
    expect(element.querySelectorAll("tbody tr")).toHaveLength(5);
    expect(element.querySelector('[data-testid="inline-preview-page"]')?.textContent).toBe("21-25 of 25");
    element.querySelector("button")?.click();
    expect(postMessage).toHaveBeenCalledWith({ kind: "openInOpenWrangler", payload });
  });

  it("rejects an over-limit capture before creating notebook DOM or an action", () => {
    const element = document.createElement("div");
    const payload = canonicalPayload(1);

    activate({ postMessage: vi.fn() }).renderOutputItem(
      { json: () => ({ ...payload, page: { ...payload.page, limit: 10_001 } }) },
      element
    );

    expect(element.querySelector('[role="alert"]')).not.toBeNull();
    expect(element.querySelector("table")).toBeNull();
    expect(element.querySelector("button")).toBeNull();
  });

  it("bounds every user-derived inline string without changing the expanded payload", () => {
    const postMessage = vi.fn();
    const element = document.createElement("div");
    const longColumn = "🧪".repeat(200);
    const longCell = "🧪".repeat(600);
    const base = canonicalPayload(1, "frame");
    const payload = {
      ...base,
      metadata: {
        ...base.metadata,
        schema: [{ ...base.metadata.schema[0]!, name: longColumn, rawType: longColumn }]
      },
      page: {
        ...base.page,
        rows: [
          {
            ...base.page.rows[0]!,
            values: [{ kind: "string", raw: longCell, display: longCell, isNull: false, isNaN: false }]
          }
        ]
      }
    };

    activate({ postMessage }).renderOutputItem({ json: () => payload }, element);

    const truncated = element.querySelectorAll('[data-truncated-value="true"]');
    expect(truncated).toHaveLength(2);
    const cell = element.querySelector("tbody td");
    expect(cell?.textContent?.endsWith("…")).toBe(true);
    expect(Array.from(cell?.textContent ?? "")).toHaveLength(513);
    expect(Array.from(cell?.getAttribute("title") ?? "").length).toBeLessThan(650);
    expect(Array.from(cell?.getAttribute("aria-label") ?? "").length).toBeLessThan(650);
    element.querySelector("button")?.click();
    expect(postMessage).toHaveBeenCalledWith({ kind: "openInOpenWrangler", payload });
  });
});

function canonicalPayload(totalRows: number, variableName?: string) {
  return {
    mimeVersion: 2,
    metadata: {
      protocolVersion: 2,
      sessionId: "untrusted-saved-session",
      revision: 0,
      backend: "polars",
      mode: "viewing",
      source: { kind: "notebookOutput", label: "saved frame", ...(variableName ? { variableName } : {}) },
      capabilities: {
        editable: false,
        lazy: false,
        cancel: false,
        exportCsv: false,
        exportParquet: false,
        notebookInsert: false
      },
      shape: { rows: totalRows, columns: 1 },
      filteredShape: { rows: totalRows, columns: 1 },
      filterModel: { filters: [], sort: [] },
      steps: [],
      schema: [{ id: "c:value", name: "value", position: 0, rawType: "Int64", type: "integer", nullable: false }]
    },
    page: {
      offset: 0,
      limit: 1,
      totalRows,
      columnIds: ["c:value"],
      rows: [
        {
          id: "r:0",
          rowNumber: 0,
          values: [{ kind: "integer", raw: 1, display: "1", isNull: false, isNaN: false }]
        }
      ]
    },
    summaries: []
  };
}

function widePayload(rowCount: number, columnCount: number) {
  const schema = Array.from({ length: columnCount }, (_, position) => ({
    id: `c:${position}`,
    name: `column_${position}`,
    position,
    rawType: "Int64",
    type: "integer",
    nullable: false
  }));
  return {
    mimeVersion: 2,
    metadata: {
      ...canonicalPayload(1).metadata,
      source: { ...canonicalPayload(1).metadata.source, variableName: "frame" },
      shape: { rows: rowCount, columns: columnCount },
      filteredShape: { rows: rowCount, columns: columnCount },
      schema
    },
    page: {
      offset: 0,
      limit: rowCount,
      totalRows: rowCount,
      columnIds: schema.map((column) => column.id),
      rows: Array.from({ length: rowCount }, (_, rowNumber) => ({
        id: `r:${rowNumber}`,
        rowNumber,
        values: schema.map((_, position) => ({
          kind: "integer",
          raw: rowNumber * columnCount + position,
          display: String(rowNumber * columnCount + position),
          isNull: false,
          isNaN: false
        }))
      }))
    },
    summaries: []
  };
}
