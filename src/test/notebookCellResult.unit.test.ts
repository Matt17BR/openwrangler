import { beforeEach, describe, expect, it } from "vitest";
import type { ExtensionContext, NotebookEditor } from "vscode";
import {
  notebookCellResultMocks,
  notebookCellResultApi,
  resetNotebookCellResultTest,
  coordinator,
  command,
  trackedStatusItem,
  recordExecutionAndWait,
  notebook,
  setCells,
  codeCell,
  output
} from "./notebookCellResult.testSupport";

const mocks = notebookCellResultMocks();
const {
  NotebookCellResultTracker,
  notebookCellResultStatusItem,
  registerNotebookCellResultAction,
  OPEN_WRANGLER_MIME_V2
} = notebookCellResultApi();

describe("executed notebook cell result action", () => {
  beforeEach(() => {
    resetNotebookCellResultTest();
  });

  it("rolls back real tracker listeners and prior providers when a grouped registration throws", () => {
    mocks.failRegistrationAttempt = 4;
    const tracker = new NotebookCellResultTracker();
    const context = { subscriptions: [] } as unknown as ExtensionContext;

    expect(() => registerNotebookCellResultAction(context, coordinator(), tracker)).toThrow(
      "notebook cell result registration failed"
    );

    expect(context.subscriptions).toEqual([]);
    expect(mocks.providers).toEqual([]);
    expect(mocks.commands.size).toBe(0);
    expect(mocks.notebookChanges).toEqual([]);
    expect(mocks.notebookCloses).toEqual([]);
  });

  it("offers one action only for a supported execute_result observed in this extension session", async () => {
    const document = notebook();
    const cell = codeCell(document, 4);

    expect(notebookCellResultStatusItem(cell, new NotebookCellResultTracker())).toBeUndefined();
    const item = await trackedStatusItem(cell);

    expect(item?.text).toBe("$(open-preview) Open in Open Wrangler");
    expect(item?.command).toMatchObject({
      command: "openWrangler.openNotebookCellResult",
      arguments: [cell]
    });
    expect(await trackedStatusItem(codeCell(document, 4, [output("{}", OPEN_WRANGLER_MIME_V2)]))).toBeUndefined();
    expect(await trackedStatusItem(codeCell(document, 0))).toBeUndefined();
    expect(await trackedStatusItem(codeCell(document, 4, [], "r"))).toBeUndefined();
    expect(await trackedStatusItem(codeCell(document, 4, [output("42")]), false)).toBeUndefined();
    expect(
      await trackedStatusItem(codeCell(document, 4, [output("<div>hello</div>", "text/html")]), false)
    ).toBeUndefined();
    expect(
      await trackedStatusItem(
        codeCell(document, 4, [output("<table><tr><td>styled</td></tr></table>", "text/html")]),
        false
      )
    ).toBeUndefined();
    expect(
      await trackedStatusItem(
        codeCell(document, 4, [output("<table><tr><td>1</td></tr></table>", "text/html", "display_data")])
      )
    ).toBeUndefined();
    expect(
      await trackedStatusItem(codeCell(document, 4, [output("printed polars table", "text/plain", "stream")]))
    ).toBeUndefined();
    expect(await trackedStatusItem(codeCell(document, 4, [output("DataFrame[id: bigint]")]))).toBeDefined();
  });

  it("rejects an over-limit output-container cell before reading a trailing output", async () => {
    const document = notebook("file:///status-output-container-cap.ipynb");
    const matchedOutput = output("DataFrame[id: bigint]");
    const cell = codeCell(document, 4, [matchedOutput]);
    setCells(document, [cell]);
    let trailingItemsRead = 0;
    const trailingOutput = Object.defineProperty({}, "items", {
      get: () => {
        trailingItemsRead += 1;
        return [{ mime: "text/html", data: new Uint8Array(1) }];
      }
    });
    Object.defineProperty(cell, "outputs", {
      configurable: true,
      value: [matchedOutput, ...Array.from({ length: 100_000 }, () => ({ items: [] })), trailingOutput]
    });

    expect(await trackedStatusItem(cell)).toBeUndefined();
    expect(trailingItemsRead).toBe(0);
  });

  it("publishes an eligible status item without waiting for another kernel lookup", async () => {
    const document = notebook("file:///synchronous-status-item.ipynb");
    const cell = codeCell(document, 4);
    setCells(document, [cell]);
    const tracker = new NotebookCellResultTracker();
    registerNotebookCellResultAction({ subscriptions: [] } as unknown as ExtensionContext, coordinator(), tracker);
    await recordExecutionAndWait(cell);
    mocks.kernelCurrent.mockImplementation(() => new Promise<boolean>(() => undefined));

    const provided = mocks.providers[0]?.provider.provideCellStatusBarItems(cell, {} as never);

    expect(provided).toMatchObject({ text: "$(open-preview) Open in Open Wrangler" });
    expect(provided).not.toBeInstanceOf(Promise);
    expect(mocks.kernelCurrent).not.toHaveBeenCalled();
    tracker.dispose();
  });

  it("opens the exact executed result without consulting another active notebook", async () => {
    const document = notebook("file:///origin.ipynb");
    const cell = codeCell(document, 8);
    setCells(document, [cell]);
    const originEditor = { notebook: document } as NotebookEditor;
    mocks.notebookDocuments.push(document);
    mocks.visibleEditors.push(originEditor);
    const context = { subscriptions: [] } as unknown as ExtensionContext;
    registerNotebookCellResultAction(context, coordinator());
    await recordExecutionAndWait(cell);

    await command()(cell);

    expect(mocks.bridgeDocuments).toEqual([document]);
    expect(mocks.capture).toHaveBeenCalledWith(8, "a".repeat(64), mocks.bindings[0]);
    expect(mocks.createBridge).toHaveBeenCalledWith(expect.anything(), document);
    expect(mocks.createPanel).toHaveBeenCalledWith(
      context,
      expect.anything(),
      {
        kind: "notebookVariable",
        label: "DataFrame",
        variableName: "__openwrangler_live_result_0123456789abcdef0123456789abcdef",
        uri: "file:///origin.ipynb"
      },
      "pandas"
    );
    expect(mocks.disposed).toBe(0);
  });

  it("rejects an edited cell instead of using its old execution result", async () => {
    const document = notebook();
    const cell = codeCell(document, 2);
    setCells(document, [cell]);
    mocks.notebookDocuments.push(document);
    mocks.visibleEditors.push({ notebook: document } as NotebookEditor);
    registerNotebookCellResultAction({ subscriptions: [] } as unknown as ExtensionContext, coordinator());
    await recordExecutionAndWait(cell);
    (cell.document as unknown as { text: string }).text = "replacement";

    await command()(cell);

    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.warning).toHaveBeenCalledWith(
      "This executed notebook result is no longer current. Run the dataframe cell and try again."
    );
  });

  it("fails closed when the same notebook is visible in more than one editor", async () => {
    const document = notebook();
    const cell = codeCell(document, 2);
    setCells(document, [cell]);
    mocks.notebookDocuments.push(document);
    mocks.visibleEditors.push({ notebook: document } as NotebookEditor, { notebook: document } as NotebookEditor);
    registerNotebookCellResultAction({ subscriptions: [] } as unknown as ExtensionContext, coordinator());
    await recordExecutionAndWait(cell);

    await command()(cell);

    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.warning).toHaveBeenCalledWith(
      "This executed notebook result is no longer current. Run the dataframe cell and try again."
    );
  });
});
