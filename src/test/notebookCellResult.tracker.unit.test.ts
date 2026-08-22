import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext, NotebookEditor } from "vscode";
import {
  notebookCellResultMocks,
  notebookCellResultApi,
  resetNotebookCellResultTest,
  coordinator,
  trackerInternals,
  command,
  recordExecution,
  recordExecutionAndWait,
  settleInspection,
  executionEvent,
  outputOnlyEvent,
  executionStartedEvent,
  notebook,
  setCells,
  codeCell,
  output,
  testBinding,
  deferred
} from "./notebookCellResult.testSupport";

const mocks = notebookCellResultMocks();
const { NotebookCellResultTracker, notebookCellResultStatusItem, registerNotebookCellResultAction } =
  notebookCellResultApi();

describe("executed notebook cell result tracker", () => {
  beforeEach(() => {
    resetNotebookCellResultTest();
  });

  it("binds one exact current HTML output and rejects byte-identical ambiguity", async () => {
    const document = notebook("file:///inline-upgrade.ipynb");
    const bytes = new TextEncoder().encode("<table><tr><td>1</td></tr></table>");
    const first = codeCell(document, 1, [output(new TextDecoder().decode(bytes), "text/html")]);
    setCells(document, [first]);
    const exactEditor = { notebook: document } as NotebookEditor;
    mocks.notebookDocuments.push(document);
    mocks.visibleEditors.push(exactEditor);
    const tracker = new NotebookCellResultTracker();
    tracker.start();
    await recordExecutionAndWait(first);
    const candidate = {
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex")
    };

    const binding = await tracker.bindInlineUpgrade(exactEditor, candidate);

    expect(binding?.cell).toBe(first);
    expect(binding?.isCurrent()).toBe(true);
    const invalidated = vi.fn();
    binding?.onDidInvalidate(invalidated);

    const replacementEditor = { notebook: document } as NotebookEditor;
    mocks.visibleEditors.splice(0, 1, replacementEditor);
    expect(binding?.isCurrent()).toBe(false);
    mocks.visibleEditors.splice(0, 1, exactEditor);
    expect(binding?.isCurrent()).toBe(true);

    const duplicate = codeCell(document, 2, [output(new TextDecoder().decode(bytes), "text/html")]);
    setCells(document, [first, duplicate]);
    await recordExecutionAndWait(duplicate);
    expect(await tracker.bindInlineUpgrade(exactEditor, candidate)).toBeUndefined();
    mocks.bindings[0]?.invalidate();
    expect(binding?.isCurrent()).toBe(false);
    expect(invalidated).toHaveBeenCalledOnce();
    binding?.dispose();
    tracker.dispose();
  });

  it("accepts VS Code's fresh outputs facade while retaining the exact ordered output objects", async () => {
    const document = notebook("file:///inline-upgrade-fresh-output-facade.ipynb");
    const bytes = new TextEncoder().encode("<table><tr><td>fresh facade</td></tr></table>");
    const storedOutputs = [output(new TextDecoder().decode(bytes), "text/html")];
    const cell = codeCell(document, 1, storedOutputs);
    Object.defineProperty(cell, "outputs", {
      configurable: true,
      get: () => storedOutputs.slice()
    });
    setCells(document, [cell]);
    const exactEditor = { notebook: document } as NotebookEditor;
    mocks.notebookDocuments.push(document);
    mocks.visibleEditors.push(exactEditor);
    const tracker = new NotebookCellResultTracker();
    tracker.start();
    await recordExecutionAndWait(cell);

    const binding = await tracker.bindInlineUpgrade(exactEditor, {
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex")
    });

    expect(binding?.isCurrent()).toBe(true);
    binding?.dispose();
    tracker.dispose();
  });

  it.each(["replacement", "reordering", "length"] as const)(
    "fails closed when a fresh outputs facade hides an underlying %s change between snapshot passes",
    async (mutation) => {
      const document = notebook(`file:///inline-upgrade-fresh-output-${mutation}.ipynb`);
      const bytes = new TextEncoder().encode("<table><tr><td>changing facade</td></tr></table>");
      const matchedOutput = output(new TextDecoder().decode(bytes), "text/html");
      const matchedItems = matchedOutput.items;
      let itemReads = 0;
      Object.defineProperty(matchedOutput, "items", {
        configurable: true,
        get: () => {
          itemReads += 1;
          return matchedItems;
        }
      });
      const otherOutput = output("other output");
      let storedOutputs = [matchedOutput, otherOutput];
      let outputReads = 0;
      let mutateDuringSnapshot = false;
      const cell = codeCell(document, 1, storedOutputs);
      Object.defineProperty(cell, "outputs", {
        configurable: true,
        get: () => {
          outputReads += 1;
          if (mutateDuringSnapshot && outputReads === 2) {
            if (mutation === "replacement") {
              storedOutputs = [output(new TextDecoder().decode(bytes), "text/html"), otherOutput];
            } else if (mutation === "reordering") {
              storedOutputs = [otherOutput, matchedOutput];
            } else {
              storedOutputs = [matchedOutput, otherOutput, output("additional output")];
            }
          }
          return storedOutputs.slice();
        }
      });
      setCells(document, [cell]);
      const exactEditor = { notebook: document } as NotebookEditor;
      mocks.notebookDocuments.push(document);
      mocks.visibleEditors.push(exactEditor);
      const tracker = new NotebookCellResultTracker();
      tracker.start();
      await recordExecutionAndWait(cell);
      itemReads = 0;
      outputReads = 0;
      mutateDuringSnapshot = true;

      await expect(
        tracker.bindInlineUpgrade(exactEditor, {
          byteLength: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex")
        })
      ).resolves.toBeUndefined();

      expect(itemReads).toBe(0);
      tracker.dispose();
    }
  );

  it.each(["cells", "outputs", "items"] as const)(
    "copies %s by bounded numeric index without consuming an over-yielding iterator",
    async (level) => {
      const document = notebook(`file:///inline-upgrade-${level}-iterator.ipynb`);
      const bytes = new TextEncoder().encode("<table><tr><td>numeric references</td></tr></table>");
      const item = { mime: "text/html", data: bytes };
      let iteratorReads = 0;
      const overYielding = <T>(value: T): T[] => {
        const values = [value];
        Object.defineProperty(values, Symbol.iterator, {
          configurable: true,
          value: function* () {
            iteratorReads += 1;
            yield values[0]!;
            yield values[0]!;
          }
        });
        return values;
      };
      const matchedOutput = { metadata: { outputType: "execute_result" }, items: [item] };
      if (level === "items") matchedOutput.items = overYielding(item);
      const cell = codeCell(document, 1, [matchedOutput]);
      if (level === "outputs") {
        Object.defineProperty(cell, "outputs", { configurable: true, value: overYielding(matchedOutput) });
      }
      setCells(document, [cell]);
      if (level === "cells") {
        const cells = overYielding(cell);
        Object.defineProperty(document, "getCells", { configurable: true, value: () => cells });
      }
      const exactEditor = { notebook: document } as NotebookEditor;
      mocks.notebookDocuments.push(document);
      mocks.visibleEditors.push(exactEditor);
      const tracker = new NotebookCellResultTracker();
      tracker.start();
      await recordExecutionAndWait(cell);

      const binding = await tracker.bindInlineUpgrade(exactEditor, {
        byteLength: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex")
      });

      expect(binding?.isCurrent()).toBe(true);
      expect(iteratorReads).toBe(0);
      binding?.dispose();
      tracker.dispose();
    }
  );

  it.each(["cells", "outputs", "items"] as const)(
    "rejects an accessor-backed %s index without invoking its growth getter",
    async (level) => {
      const document = notebook(`file:///inline-upgrade-${level}-indexed-growth.ipynb`);
      const bytes = new TextEncoder().encode("<table><tr><td>growing references</td></tr></table>");
      let dataReads = 0;
      const item = Object.defineProperty({ mime: "text/html" }, "data", {
        configurable: true,
        get: () => {
          dataReads += 1;
          return bytes;
        }
      }) as { mime: string; data: Uint8Array };
      const extraItem = { mime: "text/plain", data: new Uint8Array() };
      const matchedOutput = { metadata: { outputType: "execute_result" }, items: [item] };
      const extraOutput = output("extra output");
      const cell = codeCell(document, 1, [matchedOutput]);
      const extraCell = codeCell(document, 2, [extraOutput]);
      let growthEnabled = false;
      let indexReads = 0;
      const growing = <T>(first: T, extra: T): T[] => {
        const values: T[] = [];
        Object.defineProperty(values, "0", {
          configurable: true,
          enumerable: true,
          get: () => {
            indexReads += 1;
            if (growthEnabled && values.length === 1) {
              Object.defineProperty(values, "1", {
                configurable: true,
                enumerable: true,
                writable: true,
                value: extra
              });
            }
            return first;
          }
        });
        return values;
      };
      if (level === "items") matchedOutput.items = growing(item, extraItem);
      if (level === "outputs") {
        Object.defineProperty(cell, "outputs", {
          configurable: true,
          value: growing(matchedOutput, extraOutput)
        });
      }
      setCells(document, [cell]);
      if (level === "cells") {
        const cells = growing(cell, extraCell);
        Object.defineProperty(document, "getCells", { configurable: true, value: () => cells });
      }
      const exactEditor = { notebook: document } as NotebookEditor;
      mocks.notebookDocuments.push(document);
      mocks.visibleEditors.push(exactEditor);
      const tracker = new NotebookCellResultTracker();
      tracker.start();
      await recordExecutionAndWait(cell);
      dataReads = 0;
      indexReads = 0;
      growthEnabled = true;

      await expect(
        tracker.bindInlineUpgrade(exactEditor, {
          byteLength: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex")
        })
      ).resolves.toBeUndefined();

      expect(indexReads).toBe(0);
      expect(dataReads).toBe(0);
      tracker.dispose();
    }
  );

  it.each(["cells", "outputs", "items"] as const)(
    "rejects %s growth triggered by the last identity comparison in the final currentness sweep",
    async (level) => {
      const document = notebook(`file:///inline-upgrade-${level}-delayed-final-growth.ipynb`);
      const bytes = new TextEncoder().encode("<table><tr><td>final sweep</td></tr></table>");
      let armed = false;
      let indexedReads = 0;
      let descriptorReads = 0;
      let dataReads = 0;
      const item = Object.defineProperty({ mime: "text/html" }, "data", {
        configurable: true,
        get: () => {
          dataReads += 1;
          armed = true;
          indexedReads = 0;
          descriptorReads = 0;
          return bytes;
        }
      }) as { mime: string; data: Uint8Array };
      const extraItem = { mime: "text/plain", data: new Uint8Array() };
      const matchedOutput = { metadata: { outputType: "execute_result" }, items: [item] };
      const extraOutput = output("extra output");
      const cell = codeCell(document, 1, [matchedOutput]);
      const extraCell = codeCell(document, 2, [extraOutput]);
      const indexedGrowthRead = level === "cells" ? 5 : 4;
      const delayedGrowth = <T>(first: T, extra: T): T[] => {
        const target = [first];
        const grow = (): void => {
          if (target.length === 1) target.push(extra);
        };
        return new Proxy(target, {
          get: (current, property, receiver) => {
            if (property === "0" && armed) {
              indexedReads += 1;
              if (indexedReads === indexedGrowthRead) grow();
            }
            return Reflect.get(current, property, receiver);
          },
          getOwnPropertyDescriptor: (current, property) => {
            if (property === "0" && armed) {
              descriptorReads += 1;
              if (descriptorReads === 2) grow();
            }
            return Reflect.getOwnPropertyDescriptor(current, property);
          }
        });
      };
      if (level === "items") matchedOutput.items = delayedGrowth(item, extraItem);
      if (level === "outputs") {
        Object.defineProperty(cell, "outputs", {
          configurable: true,
          value: delayedGrowth(matchedOutput, extraOutput)
        });
      }
      setCells(document, [cell]);
      if (level === "cells") {
        const cells = delayedGrowth(cell, extraCell);
        Object.defineProperty(document, "getCells", { configurable: true, value: () => cells });
      }
      const exactEditor = { notebook: document } as NotebookEditor;
      mocks.notebookDocuments.push(document);
      mocks.visibleEditors.push(exactEditor);
      const tracker = new NotebookCellResultTracker();
      tracker.start();
      await recordExecutionAndWait(cell);

      await expect(
        tracker.bindInlineUpgrade(exactEditor, {
          byteLength: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex")
        })
      ).resolves.toBeUndefined();

      expect(dataReads).toBe(1);
      tracker.dispose();
    }
  );

  it("queues the first HTML candidate until its exact eligibility inspection settles", async () => {
    const document = notebook("file:///inline-upgrade-before-eligibility.ipynb");
    const bytes = new TextEncoder().encode("<table><tr><td>first</td></tr></table>");
    const cell = codeCell(document, 1, [output(new TextDecoder().decode(bytes), "text/html")]);
    setCells(document, [cell]);
    const exactEditor = { notebook: document } as NotebookEditor;
    mocks.notebookDocuments.push(document);
    mocks.visibleEditors.push(exactEditor);
    const tracker = new NotebookCellResultTracker();
    tracker.start();

    const queued = tracker.bindInlineUpgrade(exactEditor, {
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex")
    });
    await recordExecutionAndWait(cell);

    const binding = await queued;
    expect(binding?.cell).toBe(cell);
    expect(binding?.isCurrent()).toBe(true);
    binding?.dispose();
    tracker.dispose();
  });

  it("rejects a pending inline candidate before an early cross-cell items getter", async () => {
    const document = notebook("file:///inline-upgrade-pending-output-expansion.ipynb");
    const bytes = new TextEncoder().encode("<table><tr><td>pending</td></tr></table>");
    const matchedOutput = output(new TextDecoder().decode(bytes), "text/html");
    const cell = codeCell(document, 1, [matchedOutput]);
    setCells(document, [cell]);
    const exactEditor = { notebook: document } as NotebookEditor;
    mocks.notebookDocuments.push(document);
    mocks.visibleEditors.push(exactEditor);
    const tracker = new NotebookCellResultTracker();
    tracker.start();

    const queued = tracker.bindInlineUpgrade(exactEditor, {
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex")
    });
    let earlyItemsRead = 0;
    const earlyOutput = Object.defineProperty({}, "items", {
      get: () => {
        earlyItemsRead += 1;
        throw new Error("The global container preflight must reject before reading early items.");
      }
    });
    const earlyCell = codeCell(document, 2, [earlyOutput] as never);
    const overLimitCell = codeCell(document, 3, Array.from({ length: 100_000 }, () => ({ items: [] })) as never);
    const earlyOutputs = earlyCell.outputs;
    const currentOutputs = cell.outputs;
    const overLimitOutputs = overLimitCell.outputs;
    Object.defineProperty(earlyCell, "outputs", { configurable: true, get: () => earlyOutputs.slice() });
    Object.defineProperty(cell, "outputs", { configurable: true, get: () => currentOutputs.slice() });
    Object.defineProperty(overLimitCell, "outputs", {
      configurable: true,
      get: () => overLimitOutputs.slice()
    });
    setCells(document, [earlyCell, cell, overLimitCell]);

    await recordExecutionAndWait(cell);

    expect(await queued).toBeUndefined();
    expect(earlyItemsRead).toBe(0);
    tracker.dispose();
  });

  it("rejects a published inline binding before an early cross-cell items getter", async () => {
    const document = notebook("file:///inline-upgrade-published-output-expansion.ipynb");
    const bytes = new TextEncoder().encode("<table><tr><td>published</td></tr></table>");
    const matchedOutput = output(new TextDecoder().decode(bytes), "text/html");
    const cell = codeCell(document, 1, [matchedOutput]);
    setCells(document, [cell]);
    const exactEditor = { notebook: document } as NotebookEditor;
    mocks.notebookDocuments.push(document);
    mocks.visibleEditors.push(exactEditor);
    const tracker = new NotebookCellResultTracker();
    tracker.start();
    await recordExecutionAndWait(cell);
    const binding = await tracker.bindInlineUpgrade(exactEditor, {
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex")
    });
    expect(binding?.isCurrent()).toBe(true);

    let earlyItemsRead = 0;
    const earlyOutput = Object.defineProperty({}, "items", {
      get: () => {
        earlyItemsRead += 1;
        throw new Error("The global container preflight must reject before reading early items.");
      }
    });
    const earlyCell = codeCell(document, 2, [earlyOutput] as never);
    const overLimitCell = codeCell(document, 3, Array.from({ length: 100_000 }, () => ({ items: [] })) as never);
    const earlyOutputs = earlyCell.outputs;
    const currentOutputs = cell.outputs;
    const overLimitOutputs = overLimitCell.outputs;
    Object.defineProperty(earlyCell, "outputs", { configurable: true, get: () => earlyOutputs.slice() });
    Object.defineProperty(cell, "outputs", { configurable: true, get: () => currentOutputs.slice() });
    Object.defineProperty(overLimitCell, "outputs", {
      configurable: true,
      get: () => overLimitOutputs.slice()
    });
    setCells(document, [earlyCell, cell, overLimitCell]);

    expect(binding?.isCurrent()).toBe(false);
    expect(earlyItemsRead).toBe(0);
    binding?.dispose();
    tracker.dispose();
  });

  it("accepts the exact one-cell output-container boundary", async () => {
    const document = notebook("file:///inline-upgrade-output-container-boundary.ipynb");
    const bytes = new TextEncoder().encode("<table><tr><td>boundary</td></tr></table>");
    const matchedOutput = output(new TextDecoder().decode(bytes), "text/html");
    const cell = codeCell(document, 1, [
      matchedOutput,
      ...Array.from({ length: 99_999 }, () => ({ items: [] }))
    ] as never);
    setCells(document, [cell]);
    const exactEditor = { notebook: document } as NotebookEditor;
    mocks.notebookDocuments.push(document);
    mocks.visibleEditors.push(exactEditor);
    const tracker = new NotebookCellResultTracker();
    tracker.start();
    await recordExecutionAndWait(cell);

    const binding = await tracker.bindInlineUpgrade(exactEditor, {
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex")
    });

    expect(binding?.isCurrent()).toBe(true);
    binding?.dispose();
    tracker.dispose();
  });

  it("rejects a byte-identical raw HTML output that is ineligible for a live result", async () => {
    const document = notebook("file:///inline-upgrade-ineligible-duplicate.ipynb");
    const bytes = new TextEncoder().encode("<table><tr><td>same</td></tr></table>");
    const eligible = codeCell(document, 1, [output(new TextDecoder().decode(bytes), "text/html")]);
    const ordinary = codeCell(document, 2, [output(new TextDecoder().decode(bytes), "text/html", "display_data")]);
    setCells(document, [eligible, ordinary]);
    const exactEditor = { notebook: document } as NotebookEditor;
    mocks.notebookDocuments.push(document);
    mocks.visibleEditors.push(exactEditor);
    const tracker = new NotebookCellResultTracker();
    tracker.start();
    await recordExecutionAndWait(eligible);

    expect(
      await tracker.bindInlineUpgrade(exactEditor, {
        byteLength: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex")
      })
    ).toBeUndefined();
    tracker.dispose();
  });

  it("fails closed before hashing more than the bounded HTML candidate budget", async () => {
    const document = notebook("file:///inline-upgrade-scan-bound.ipynb");
    const bytes = new Uint8Array(32 * 1024);
    const items = Array.from({ length: 513 }, (_, index) => {
      const data = new Uint8Array(bytes);
      new DataView(data.buffer).setUint32(0, index);
      return { mime: "text/html", data };
    });
    const first = codeCell(document, 1, [{ metadata: { outputType: "execute_result" }, items }]);
    setCells(document, [first]);
    const exactEditor = { notebook: document } as NotebookEditor;
    mocks.notebookDocuments.push(document);
    mocks.visibleEditors.push(exactEditor);
    const tracker = new NotebookCellResultTracker();
    tracker.start();
    await recordExecutionAndWait(first);

    expect(
      await tracker.bindInlineUpgrade(exactEditor, {
        byteLength: items[0]!.data.byteLength,
        sha256: createHash("sha256").update(items[0]!.data).digest("hex")
      })
    ).toBeUndefined();
    tracker.dispose();
  });

  it("reads each HTML item data accessor once and charges that exact reference against the scan budget", async () => {
    const document = notebook("file:///inline-upgrade-changing-item-data.ipynb");
    const candidateBytes = new Uint8Array(32 * 1024).fill(1);
    const scannedBytes = new Uint8Array(candidateBytes.byteLength);
    const emptyBytes = new Uint8Array();
    let totalDataReads = 0;
    const perItemDataReads = new Array<number>(513).fill(0);
    const items = Array.from({ length: perItemDataReads.length }, (_, index) =>
      Object.defineProperty({ mime: "text/html" }, "data", {
        configurable: true,
        get: () => {
          totalDataReads += 1;
          perItemDataReads[index] = (perItemDataReads[index] ?? 0) + 1;
          const read = perItemDataReads[index];
          return read === 1 || read === 4 ? scannedBytes : emptyBytes;
        }
      })
    ) as Array<{ mime: string; data: Uint8Array }>;
    const cell = codeCell(document, 1, [{ metadata: { outputType: "execute_result" }, items }]);
    setCells(document, [cell]);
    const exactEditor = { notebook: document } as NotebookEditor;
    mocks.notebookDocuments.push(document);
    mocks.visibleEditors.push(exactEditor);
    const tracker = new NotebookCellResultTracker();
    tracker.start();
    await recordExecutionAndWait(cell);

    await expect(
      tracker.bindInlineUpgrade(exactEditor, {
        byteLength: candidateBytes.byteLength,
        sha256: createHash("sha256").update(candidateBytes).digest("hex")
      })
    ).resolves.toBeUndefined();

    expect(totalDataReads).toBe(513);
    expect(perItemDataReads.every((reads) => reads <= 1)).toBe(true);
    tracker.dispose();
  });

  it.each(["output", "item"] as const)(
    "rejects an aliased %s identity before reading its alternating data accessor",
    async (level) => {
      const document = notebook(`file:///inline-upgrade-aliased-${level}.ipynb`);
      const bytes = new TextEncoder().encode("<table><tr><td>aliased identity</td></tr></table>");
      const emptyBytes = new Uint8Array();
      let dataReads = 0;
      const sharedItem = Object.defineProperty({ mime: "text/html" }, "data", {
        configurable: true,
        get: () => {
          dataReads += 1;
          return dataReads % 2 === 1 ? bytes : emptyBytes;
        }
      }) as { mime: string; data: Uint8Array };
      const firstOutput = { metadata: { outputType: "execute_result" }, items: [sharedItem] };
      const outputs =
        level === "output"
          ? [firstOutput, firstOutput]
          : [firstOutput, { metadata: { outputType: "execute_result" }, items: [sharedItem] }];
      const cell = codeCell(document, 1, outputs);
      setCells(document, [cell]);
      const exactEditor = { notebook: document } as NotebookEditor;
      mocks.notebookDocuments.push(document);
      mocks.visibleEditors.push(exactEditor);
      const tracker = new NotebookCellResultTracker();
      tracker.start();
      await recordExecutionAndWait(cell);

      await expect(
        tracker.bindInlineUpgrade(exactEditor, {
          byteLength: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex")
        })
      ).resolves.toBeUndefined();

      expect(dataReads).toBe(0);
      tracker.dispose();
    }
  );

  it.each(["sparse", "undefined"] as const)(
    "rejects a %s item slot before reading an earlier matching item",
    async (slotKind) => {
      const document = notebook(`file:///inline-upgrade-${slotKind}-item-slot.ipynb`);
      const bytes = new TextEncoder().encode("<table><tr><td>dense items</td></tr></table>");
      let dataReads = 0;
      const matchedItem = Object.defineProperty({ mime: "text/html" }, "data", {
        configurable: true,
        get: () => {
          dataReads += 1;
          return bytes;
        }
      }) as { mime: string; data: Uint8Array };
      const items = new Array<{ mime: string; data: Uint8Array } | undefined>(2);
      items[0] = matchedItem;
      if (slotKind === "undefined") items[1] = undefined;
      let invalidItemsEnabled = false;
      const outputContainer = {
        metadata: { outputType: "execute_result" },
        get items() {
          return invalidItemsEnabled ? items : [matchedItem];
        }
      };
      const cell = codeCell(document, 1, [outputContainer as never]);
      setCells(document, [cell]);
      const exactEditor = { notebook: document } as NotebookEditor;
      mocks.notebookDocuments.push(document);
      mocks.visibleEditors.push(exactEditor);
      const tracker = new NotebookCellResultTracker();
      tracker.start();
      await recordExecutionAndWait(cell);
      invalidItemsEnabled = true;

      await expect(
        tracker.bindInlineUpgrade(exactEditor, {
          byteLength: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex")
        })
      ).resolves.toBeUndefined();

      expect(dataReads).toBe(0);
      tracker.dispose();
    }
  );

  it("retains a first dataframe execution that finishes before commands and providers register", async () => {
    const document = notebook("file:///cold-start.ipynb");
    const cell = codeCell(document, 1);
    setCells(document, [cell]);
    mocks.notebookDocuments.push(document);
    mocks.visibleEditors.push({ notebook: document } as NotebookEditor);
    const tracker = new NotebookCellResultTracker();
    tracker.start();

    await recordExecutionAndWait(cell);
    expect(mocks.providers).toHaveLength(0);
    registerNotebookCellResultAction({ subscriptions: [] } as unknown as ExtensionContext, coordinator(), tracker);

    expect(mocks.notebookChanges).toHaveLength(1);
    expect(mocks.notebookCloses).toHaveLength(1);
    expect(mocks.providers[0]?.provider.provideCellStatusBarItems(cell, {} as never)).toBeDefined();
    await command()(cell);
    expect(mocks.capture).toHaveBeenCalledWith(1, "a".repeat(64), mocks.bindings[0]);
    expect(mocks.createPanel).toHaveBeenCalledOnce();
  });

  it("observes the first result when execution summary and output arrive in separate events", async () => {
    const document = notebook("file:///split-events.ipynb");
    const cell = codeCell(document, 1, []);
    setCells(document, [cell]);
    const tracker = new NotebookCellResultTracker();
    tracker.start();

    tracker.recordDocumentChange(executionStartedEvent(cell) as never);
    await settleInspection();

    tracker.recordDocumentChange({
      notebook: document,
      metadata: undefined,
      contentChanges: [],
      cellChanges: [{ cell, executionSummary: cell.executionSummary }]
    } as never);
    expect(mocks.inspect).not.toHaveBeenCalled();

    Object.defineProperty(cell, "outputs", { configurable: true, value: [output("DataFrame[id: bigint]")] });
    tracker.recordDocumentChange({
      notebook: document,
      metadata: undefined,
      contentChanges: [],
      cellChanges: [{ cell, outputs: cell.outputs }]
    } as never);
    await settleInspection();

    expect(mocks.inspect).toHaveBeenCalledWith(document, 1, "a".repeat(64), mocks.bindings[0]);
    expect(notebookCellResultStatusItem(cell, tracker)).toBeDefined();
    tracker.dispose();
  });

  it("rechecks the selected kernel when it was not available at execution start", async () => {
    const previous = process.env.OPEN_WRANGLER_EXTENSION_TESTS;
    delete process.env.OPEN_WRANGLER_EXTENSION_TESTS;
    const gatedTracker = new NotebookCellResultTracker();
    expect(gatedTracker.diagnosticsForTesting()).toBeUndefined();
    gatedTracker.dispose();
    process.env.OPEN_WRANGLER_EXTENSION_TESTS = "1";
    const document = notebook("file:///late-selected-kernel.ipynb");
    const cell = codeCell(document, 1);
    setCells(document, [cell]);
    const binding = testBinding();
    mocks.bindings.push(binding);
    mocks.observe.mockResolvedValueOnce(undefined).mockResolvedValueOnce(binding);
    const tracker = new NotebookCellResultTracker();
    tracker.start();

    try {
      tracker.recordDocumentChange(executionStartedEvent(cell) as never);
      await settleInspection();
      tracker.recordDocumentChange(executionEvent(cell) as never);
      await settleInspection();

      expect(mocks.observe).toHaveBeenCalledTimes(2);
      expect(mocks.inspect).toHaveBeenCalledWith(document, 1, "a".repeat(64), binding);
      expect(notebookCellResultStatusItem(cell, tracker)).toBeDefined();
      const diagnostic = tracker.diagnosticsForTesting();
      expect(Object.isFrozen(diagnostic)).toBe(true);
      expect(diagnostic).toEqual({
        stage: "eligible",
        statusItem: "offered",
        reason: undefined
      });
    } finally {
      tracker.dispose();
      if (previous === undefined) delete process.env.OPEN_WRANGLER_EXTENSION_TESTS;
      else process.env.OPEN_WRANGLER_EXTENSION_TESTS = previous;
    }
  });

  it("reports a bounded completion-kernel error without exposing its message", async () => {
    const previous = process.env.OPEN_WRANGLER_EXTENSION_TESTS;
    process.env.OPEN_WRANGLER_EXTENSION_TESTS = "1";
    const document = notebook("file:///completion-kernel-error.ipynb");
    const cell = codeCell(document, 1);
    setCells(document, [cell]);
    mocks.observe.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("private kernel failure details"));
    const tracker = new NotebookCellResultTracker();
    tracker.start();
    try {
      tracker.recordDocumentChange(executionStartedEvent(cell) as never);
      await settleInspection();
      tracker.recordDocumentChange(executionEvent(cell) as never);
      await settleInspection();

      const diagnostic = tracker.diagnosticsForTesting();
      expect(diagnostic).toMatchObject({
        stage: "rejected",
        statusItem: "not-requested",
        reason: "completion-kernel-error"
      });
      expect(JSON.stringify(diagnostic)).not.toContain("private kernel failure details");
    } finally {
      tracker.dispose();
      if (previous === undefined) delete process.env.OPEN_WRANGLER_EXTENSION_TESTS;
      else process.env.OPEN_WRANGLER_EXTENSION_TESTS = previous;
    }
  });

  it("checks the selected kernel when the first observed event already contains the result", async () => {
    const document = notebook("file:///completion-only-first-result.ipynb");
    const cell = codeCell(document, 1);
    setCells(document, [cell]);
    const binding = testBinding();
    mocks.bindings.push(binding);
    mocks.observe.mockResolvedValueOnce(binding);
    const tracker = new NotebookCellResultTracker();
    tracker.start();

    tracker.recordDocumentChange(executionEvent(cell) as never);
    await settleInspection();

    expect(mocks.observe).toHaveBeenCalledOnce();
    expect(mocks.inspect).toHaveBeenCalledWith(document, 1, "a".repeat(64), binding);
    expect(notebookCellResultStatusItem(cell, tracker)).toBeDefined();
    tracker.dispose();
  });

  it("falls back after a hung execution-start lookup and disposes its late binding", async () => {
    vi.useFakeTimers();
    try {
      const document = notebook("file:///hung-execution-start.ipynb");
      const cell = codeCell(document, 1);
      setCells(document, [cell]);
      const initial = deferred<ReturnType<typeof testBinding> | undefined>();
      const lateBinding = testBinding();
      const fallbackBinding = testBinding();
      mocks.observe.mockReturnValueOnce(initial.promise).mockResolvedValueOnce(fallbackBinding);
      const tracker = new NotebookCellResultTracker();
      tracker.start();

      tracker.recordDocumentChange(executionStartedEvent(cell) as never);
      tracker.recordDocumentChange(executionEvent(cell) as never);
      await settleInspection();
      expect(mocks.observe).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(10_000);
      await settleInspection();

      expect(mocks.observe).toHaveBeenCalledTimes(2);
      expect(mocks.inspect).toHaveBeenCalledWith(document, 1, "a".repeat(64), fallbackBinding);
      expect(notebookCellResultStatusItem(cell, tracker)).toBeDefined();

      initial.resolve(lateBinding);
      await settleInspection();
      expect(lateBinding.isGenerationValid()).toBe(false);
      expect(notebookCellResultStatusItem(cell, tracker)).toBeDefined();
      tracker.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("discards a completion-time kernel lookup after a newer execution starts", async () => {
    const document = notebook("file:///superseded-completion-lookup.ipynb");
    const firstCell = codeCell(document, 1);
    const newerCell = codeCell(document, 2);
    setCells(document, [firstCell, newerCell]);
    const lateObservation = deferred<ReturnType<typeof testBinding> | undefined>();
    const lateBinding = testBinding();
    mocks.observe.mockResolvedValueOnce(undefined).mockReturnValueOnce(lateObservation.promise);
    const tracker = new NotebookCellResultTracker();
    tracker.start();

    tracker.recordDocumentChange(executionStartedEvent(firstCell) as never);
    await settleInspection();
    tracker.recordDocumentChange(executionEvent(firstCell) as never);
    await settleInspection();
    expect(mocks.observe).toHaveBeenCalledTimes(2);

    tracker.recordDocumentChange(executionStartedEvent(newerCell) as never);
    lateObservation.resolve(lateBinding);
    await settleInspection();

    expect(mocks.inspect).not.toHaveBeenCalled();
    expect(lateBinding.isGenerationValid()).toBe(false);
    expect(notebookCellResultStatusItem(firstCell, tracker)).toBeUndefined();
    tracker.dispose();
  });

  it("removes a superseded pending inspection while retaining the newer cell", async () => {
    const document = notebook("file:///superseded-pending-inspection.ipynb");
    const firstCell = codeCell(document, 1);
    const newerCell = codeCell(document, 2);
    setCells(document, [firstCell, newerCell]);
    const firstObservation = deferred<ReturnType<typeof testBinding> | undefined>();
    const newerObservation = deferred<ReturnType<typeof testBinding> | undefined>();
    const firstBinding = testBinding();
    const newerBinding = testBinding();
    mocks.observe.mockReturnValueOnce(firstObservation.promise).mockReturnValueOnce(newerObservation.promise);
    const tracker = new NotebookCellResultTracker();
    tracker.start();

    tracker.recordDocumentChange(executionStartedEvent(firstCell) as never);
    tracker.recordDocumentChange(executionEvent(firstCell) as never);
    tracker.recordDocumentChange(executionStartedEvent(newerCell) as never);
    firstObservation.resolve(firstBinding);
    await settleInspection();

    const internals = trackerInternals(tracker);
    const state = internals.notebookStates.get(document);
    expect(internals.pendingCells.has(firstCell)).toBe(false);
    expect(state?.trackedCells.has(firstCell)).toBe(false);
    expect(state?.trackedCells.has(newerCell)).toBe(true);
    expect(firstBinding.isGenerationValid()).toBe(false);

    tracker.dispose();
    newerObservation.resolve(newerBinding);
    await settleInspection();
    expect(newerBinding.isGenerationValid()).toBe(false);
  });

  it("does not let a late superseded inspection delete its replacement", async () => {
    const document = notebook("file:///replacement-pending-inspection.ipynb");
    const cell = codeCell(document, 1);
    setCells(document, [cell]);
    const firstObservation = deferred<ReturnType<typeof testBinding> | undefined>();
    const replacementObservation = deferred<ReturnType<typeof testBinding> | undefined>();
    const firstBinding = testBinding();
    const replacementBinding = testBinding();
    mocks.observe.mockReturnValueOnce(firstObservation.promise).mockReturnValueOnce(replacementObservation.promise);
    const tracker = new NotebookCellResultTracker();
    tracker.start();

    tracker.recordDocumentChange(executionStartedEvent(cell, 1) as never);
    tracker.recordDocumentChange(executionEvent(cell) as never);
    Object.defineProperty(cell, "executionSummary", {
      configurable: true,
      value: { executionOrder: 2, success: true }
    });
    tracker.recordDocumentChange(executionStartedEvent(cell, 2) as never);
    tracker.recordDocumentChange(executionEvent(cell) as never);
    const internals = trackerInternals(tracker);
    const replacement = internals.pendingCells.get(cell);
    expect(replacement).toBeDefined();

    firstObservation.resolve(firstBinding);
    await settleInspection();

    expect(firstBinding.isGenerationValid()).toBe(false);
    expect(internals.pendingCells.get(cell)).toBe(replacement);

    replacementObservation.resolve(replacementBinding);
    await settleInspection();
    expect(notebookCellResultStatusItem(cell, tracker)).toBeDefined();
    tracker.dispose();
  });

  it("recognizes an execute_result output when Jupyter leaves success unspecified", async () => {
    const document = notebook("file:///unspecified-success.ipynb");
    const cell = codeCell(document, 1);
    Object.defineProperty(cell, "executionSummary", {
      configurable: true,
      value: { executionOrder: 1, success: undefined }
    });
    setCells(document, [cell]);
    const tracker = new NotebookCellResultTracker();
    tracker.start();

    tracker.recordDocumentChange(executionStartedEvent(cell, 1) as never);
    await settleInspection();
    tracker.recordDocumentChange(executionEvent(cell) as never);
    await settleInspection();

    expect(mocks.inspect).toHaveBeenCalledWith(document, 1, "a".repeat(64), mocks.bindings[0]);
    expect(notebookCellResultStatusItem(cell, tracker)).toBeDefined();
    tracker.dispose();
  });

  it("retains an in-flight kernel observation when a fast first result completes", async () => {
    const document = notebook("file:///fast-first-result.ipynb");
    const cell = codeCell(document, 1);
    setCells(document, [cell]);
    const observation = deferred<ReturnType<typeof testBinding> | undefined>();
    const binding = testBinding();
    mocks.bindings.push(binding);
    mocks.observe.mockReturnValueOnce(observation.promise);
    const tracker = new NotebookCellResultTracker();
    tracker.start();

    tracker.recordDocumentChange(executionStartedEvent(cell) as never);
    tracker.recordDocumentChange(executionEvent(cell) as never);
    await settleInspection();
    expect(mocks.inspect).not.toHaveBeenCalled();

    observation.resolve(binding);
    await settleInspection();

    expect(mocks.inspect).toHaveBeenCalledWith(document, 1, "a".repeat(64), binding);
    expect(notebookCellResultStatusItem(cell, tracker)).toBeDefined();
    tracker.dispose();
  });

  it("treats repeated completion events for the same execution as one result", async () => {
    const document = notebook("file:///repeated-completion.ipynb");
    const cell = codeCell(document, 1);
    setCells(document, [cell]);
    const observation = deferred<ReturnType<typeof testBinding> | undefined>();
    const binding = testBinding();
    mocks.bindings.push(binding);
    mocks.observe.mockReturnValueOnce(observation.promise);
    const tracker = new NotebookCellResultTracker();
    tracker.start();

    tracker.recordDocumentChange(executionStartedEvent(cell) as never);
    tracker.recordDocumentChange(executionEvent(cell) as never);
    tracker.recordDocumentChange(executionEvent(cell) as never);
    observation.resolve(binding);
    await settleInspection();

    expect(mocks.observe).toHaveBeenCalledOnce();
    expect(mocks.inspect).toHaveBeenCalledOnce();
    expect(notebookCellResultStatusItem(cell, tracker)).toBeDefined();

    tracker.recordDocumentChange(executionEvent(cell) as never);
    await settleInspection();

    expect(mocks.observe).toHaveBeenCalledOnce();
    expect(mocks.inspect).toHaveBeenCalledOnce();
    expect(notebookCellResultStatusItem(cell, tracker)).toBeDefined();
    tracker.dispose();
  });

  it("ignores a delayed older completion after publishing a newer result", async () => {
    const document = notebook("file:///delayed-older-completion.ipynb");
    const olderCell = codeCell(document, 1);
    const currentCell = codeCell(document, 3);
    setCells(document, [olderCell, currentCell]);
    const tracker = new NotebookCellResultTracker();
    tracker.start();

    tracker.recordDocumentChange(executionStartedEvent(currentCell) as never);
    tracker.recordDocumentChange(executionEvent(currentCell) as never);
    await settleInspection();
    expect(notebookCellResultStatusItem(currentCell, tracker)).toBeDefined();

    tracker.recordDocumentChange(executionEvent(olderCell) as never);
    await settleInspection();

    expect(mocks.observe).toHaveBeenCalledOnce();
    expect(mocks.inspect).toHaveBeenCalledOnce();
    expect(notebookCellResultStatusItem(currentCell, tracker)).toBeDefined();
    expect(notebookCellResultStatusItem(olderCell, tracker)).toBeUndefined();
    tracker.dispose();
  });

  it("keeps the consent-bound observation across repeated in-progress summaries", async () => {
    const document = notebook("file:///repeated-progress.ipynb");
    const cell = codeCell(document, 1);
    setCells(document, [cell]);
    const observation = deferred<ReturnType<typeof testBinding> | undefined>();
    const binding = testBinding();
    mocks.bindings.push(binding);
    mocks.observe.mockReturnValueOnce(observation.promise).mockResolvedValueOnce(undefined);
    const tracker = new NotebookCellResultTracker();
    tracker.start();

    tracker.recordDocumentChange(executionStartedEvent(cell, undefined) as never);
    tracker.recordDocumentChange(executionStartedEvent(cell, 1) as never);
    tracker.recordDocumentChange(executionEvent(cell) as never);
    observation.resolve(binding);
    await settleInspection();

    expect(mocks.observe).toHaveBeenCalledOnce();
    expect(mocks.inspect).toHaveBeenCalledWith(document, 1, "a".repeat(64), binding);
    expect(notebookCellResultStatusItem(cell, tracker)).toBeDefined();
    tracker.dispose();
  });

  it("restarts the pending observation when the concrete execution order changes", async () => {
    const document = notebook("file:///changed-execution.ipynb");
    const cell = codeCell(document, 1);
    setCells(document, [cell]);
    const firstObservation = deferred<ReturnType<typeof testBinding> | undefined>();
    const firstBinding = testBinding();
    const secondBinding = testBinding();
    mocks.observe.mockReturnValueOnce(firstObservation.promise).mockResolvedValueOnce(secondBinding);
    const tracker = new NotebookCellResultTracker();
    tracker.start();

    tracker.recordDocumentChange(executionStartedEvent(cell, 1) as never);
    tracker.recordDocumentChange(executionStartedEvent(cell, 2) as never);
    Object.defineProperty(cell, "executionSummary", {
      configurable: true,
      value: { executionOrder: 2, success: true }
    });
    tracker.recordDocumentChange(executionEvent(cell) as never);
    firstObservation.resolve(firstBinding);
    await settleInspection();

    expect(mocks.observe).toHaveBeenCalledTimes(2);
    expect(firstBinding.isGenerationValid()).toBe(false);
    expect(mocks.inspect).toHaveBeenCalledWith(document, 2, "a".repeat(64), secondBinding);
    expect(notebookCellResultStatusItem(cell, tracker)).toBeDefined();
    tracker.dispose();
  });

  it("retires a kernel observation when a successful cell produces no output", async () => {
    vi.useFakeTimers();
    try {
      const document = notebook("file:///silent-cell.ipynb");
      const cell = codeCell(document, 1, []);
      const tracker = new NotebookCellResultTracker();
      tracker.start();

      tracker.recordDocumentChange(executionStartedEvent(cell) as never);
      await settleInspection();
      tracker.recordDocumentChange(executionEvent(cell) as never);
      await settleInspection();
      expect(mocks.bindings[0]?.isGenerationValid()).toBe(true);

      await vi.advanceTimersByTimeAsync(10_000);

      expect(mocks.bindings[0]?.isGenerationValid()).toBe(false);
      expect(mocks.inspect).not.toHaveBeenCalled();
      tracker.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a cell rerun while the exact result lookup is pending", async () => {
    const document = notebook();
    const cell = codeCell(document, 3);
    setCells(document, [cell]);
    mocks.notebookDocuments.push(document);
    mocks.visibleEditors.push({ notebook: document } as NotebookEditor);
    const gate = deferred<{
      backend: "pandas";
      label: string;
      variableName: string;
    }>();
    mocks.capture.mockReturnValue(gate.promise);
    registerNotebookCellResultAction({ subscriptions: [] } as unknown as ExtensionContext, coordinator());
    await recordExecutionAndWait(cell);

    const opening = command()(cell);
    await vi.waitFor(() => expect(mocks.capture).toHaveBeenCalledOnce());
    Object.defineProperty(cell, "executionSummary", {
      configurable: true,
      value: { executionOrder: 4, success: true }
    });
    recordExecution(cell);
    gate.resolve({ backend: "pandas", label: "DataFrame", variableName: "frame" });
    await opening;

    expect(mocks.createPanel).not.toHaveBeenCalled();
    expect(mocks.disposed).toBe(1);
    expect(mocks.warning).toHaveBeenCalledWith(
      "The notebook cell or selected kernel changed while Open Wrangler was opening its result. Try again."
    );
  });

  it("rejects a second visible split opened while the result lookup is pending", async () => {
    const document = notebook();
    const cell = codeCell(document, 3);
    setCells(document, [cell]);
    const originEditor = { notebook: document } as NotebookEditor;
    mocks.notebookDocuments.push(document);
    mocks.visibleEditors.push(originEditor);
    const gate = deferred<{
      backend: "pandas";
      label: string;
      variableName: string;
    }>();
    mocks.capture.mockReturnValue(gate.promise);
    registerNotebookCellResultAction({ subscriptions: [] } as unknown as ExtensionContext, coordinator());
    await recordExecutionAndWait(cell);

    const opening = command()(cell);
    await vi.waitFor(() => expect(mocks.capture).toHaveBeenCalledOnce());
    mocks.visibleEditors.push({ notebook: document } as NotebookEditor);
    gate.resolve({ backend: "pandas", label: "DataFrame", variableName: "frame" });
    await opening;

    expect(mocks.createPanel).not.toHaveBeenCalled();
    expect(mocks.disposed).toBe(1);
    expect(mocks.warning).toHaveBeenCalledWith(
      "The notebook cell or selected kernel changed while Open Wrangler was opening its result. Try again."
    );
  });

  it("does not retarget an observed result after the selected kernel changes", async () => {
    const document = notebook();
    const cell = codeCell(document, 5);
    setCells(document, [cell]);
    mocks.notebookDocuments.push(document);
    mocks.visibleEditors.push({ notebook: document } as NotebookEditor);
    registerNotebookCellResultAction({ subscriptions: [] } as unknown as ExtensionContext, coordinator());
    await recordExecutionAndWait(cell);
    mocks.kernelCurrent.mockResolvedValue(false);

    await command()(cell);

    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.createPanel).not.toHaveBeenCalled();
    expect(mocks.warning).toHaveBeenCalledWith(
      "This executed notebook result is no longer current. Run the dataframe cell and try again."
    );
  });

  it("removes the action as soon as the observed kernel generation restarts", async () => {
    const document = notebook();
    const cell = codeCell(document, 5);
    const tracker = new NotebookCellResultTracker();
    tracker.start();
    tracker.recordDocumentChange(executionStartedEvent(cell) as never);
    await settleInspection();
    tracker.recordDocumentChange(executionEvent(cell) as never);
    await settleInspection();

    expect(notebookCellResultStatusItem(cell, tracker)).toBeDefined();
    mocks.bindings[0]?.invalidate();

    expect(notebookCellResultStatusItem(cell, tracker)).toBeUndefined();
    tracker.dispose();
  });

  it("does not access a replacement or duplicate notebook document", async () => {
    const document = notebook();
    const replacement = notebook();
    const cell = codeCell(document, 2);
    setCells(document, [cell]);
    mocks.notebookDocuments.push(document, replacement);
    mocks.visibleEditors.push({ notebook: document } as NotebookEditor);
    registerNotebookCellResultAction({ subscriptions: [] } as unknown as ExtensionContext, coordinator());
    await recordExecutionAndWait(cell);

    await command()(cell);

    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.createPanel).not.toHaveBeenCalled();
    expect(mocks.warning).toHaveBeenCalledWith(
      "This executed notebook result is no longer current. Run the dataframe cell and try again."
    );
  });

  it("invalidates older cells when the observed execution count restarts", async () => {
    const document = notebook();
    const oldCell = codeCell(document, 7);
    const newCell = codeCell(document, 1);
    setCells(document, [oldCell, newCell]);
    mocks.notebookDocuments.push(document);
    mocks.visibleEditors.push({ notebook: document } as NotebookEditor);
    registerNotebookCellResultAction({ subscriptions: [] } as unknown as ExtensionContext, coordinator());
    await recordExecutionAndWait(oldCell);
    expect(mocks.providers[0]?.provider.provideCellStatusBarItems(oldCell, {} as never)).toBeDefined();

    await recordExecutionAndWait(newCell);
    expect(mocks.providers[0]?.provider.provideCellStatusBarItems(newCell, {} as never)).toBeDefined();
    await command()(oldCell);

    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.warning).toHaveBeenCalledWith(
      "This executed notebook result is no longer current. Run the dataframe cell and try again."
    );
  });

  it("tracks execution-order resets from output-only completion events", async () => {
    const document = notebook("file:///output-only-reset.ipynb");
    const oldCell = codeCell(document, 7);
    const newCell = codeCell(document, 1);
    for (const cell of [oldCell, newCell]) {
      Object.defineProperty(cell, "executionSummary", {
        configurable: true,
        value: { executionOrder: cell.executionSummary?.executionOrder, success: undefined }
      });
    }
    setCells(document, [oldCell, newCell]);
    const tracker = new NotebookCellResultTracker();
    tracker.start();

    tracker.recordDocumentChange(executionStartedEvent(oldCell, 7) as never);
    tracker.recordDocumentChange(outputOnlyEvent(oldCell) as never);
    await settleInspection();
    expect(notebookCellResultStatusItem(oldCell, tracker)).toBeDefined();

    tracker.recordDocumentChange(executionStartedEvent(newCell, 1) as never);
    expect(notebookCellResultStatusItem(oldCell, tracker)).toBeUndefined();
    tracker.recordDocumentChange(outputOnlyEvent(newCell) as never);
    await settleInspection();

    expect(notebookCellResultStatusItem(newCell, tracker)).toBeDefined();
    expect(notebookCellResultStatusItem(oldCell, tracker)).toBeUndefined();
    tracker.dispose();
  });
});
