import { describe, expect, it, vi } from "vitest";
import type { Locator, Page } from "playwright-core";
import type { Uri } from "vscode";
import { createReleasedRDocumentVariableInvoker } from "./extensionHost/releasedRDocumentVariable";

const source = { fsPath: "/workspace/plain-orders.R" } as Pick<Uri, "fsPath">;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function fixture() {
  const command = deferred<boolean>();
  const pickerWait = vi.fn(async () => undefined);
  const inputFill = vi.fn(async () => undefined);
  const input = { fill: inputFill } as unknown as Locator;
  const pickerLocator = vi.fn(() => ({ first: () => input }));
  const picker = {
    locator: pickerLocator,
    waitFor: pickerWait
  } as unknown as Locator;
  const last = vi.fn(() => picker);
  const filter = vi.fn(() => ({ last }));
  const locator = vi.fn(() => ({ filter }));
  const workbench = { locator } as unknown as Page;
  const rows = new Map<string, Locator>();
  const rowClicks = new Map<string, ReturnType<typeof vi.fn>>();
  for (const [name, flavor] of [
    ["orders_frame", "data.frame"],
    ["orders_tibble", "tibble"],
    ["orders_table", "data.table"]
  ] as const) {
    const click = vi.fn(async () => {
      if (name === "orders_frame") command.resolve(true);
    });
    rowClicks.set(name, click);
    rows.set(name, {
      click,
      innerText: vi.fn(async () => `${name}  R · ${flavor}`)
    } as unknown as Locator);
  }
  const releasedJupyterQuickPickRow = vi.fn(async (_picker: Locator, name: string) => rows.get(name));
  const runReleasedRDocument = vi.fn(() => command.promise);
  const boundedCalls: Array<[PromiseLike<unknown>, number, string]> = [];
  const withBoundedAcceptancePromise = async <T>(
    promise: PromiseLike<T>,
    timeoutMs: number,
    description: string
  ): Promise<T> => {
    boundedCalls.push([promise, timeoutMs, description]);
    return promise;
  };
  const invoke = createReleasedRDocumentVariableInvoker({
    releasedJupyterQuickPickRow,
    runReleasedRDocument,
    withBoundedAcceptancePromise
  });
  return {
    boundedCalls,
    command,
    filter,
    inputFill,
    invoke,
    locator,
    picker,
    pickerWait,
    releasedJupyterQuickPickRow,
    rowClicks,
    rows,
    runReleasedRDocument,
    withBoundedAcceptancePromise,
    workbench
  };
}

describe("released R document variable", () => {
  it("requires the real picker, proves the discovery inventory, and selects the exact variable", async () => {
    const test = fixture();

    await expect(test.invoke(test.workbench, source, "orders_frame", true)).resolves.toBeUndefined();
    expect(test.runReleasedRDocument).toHaveBeenCalledExactlyOnceWith(source);
    expect(test.locator).toHaveBeenCalledExactlyOnceWith(".quick-input-widget:visible");
    expect(test.filter).toHaveBeenCalledExactlyOnceWith({
      hasText: "Open Wrangler: Choose a dataframe from plain-orders.R"
    });
    expect(test.pickerWait).toHaveBeenCalledExactlyOnceWith({ state: "visible", timeout: 30_000 });
    expect(test.releasedJupyterQuickPickRow.mock.calls.map((call) => call[1])).toEqual([
      "orders_frame",
      "orders_tibble",
      "orders_table",
      "orders_frame"
    ]);
    expect(test.inputFill).toHaveBeenCalledExactlyOnceWith("orders_frame");
    expect(test.rowClicks.get("orders_frame")).toHaveBeenCalledOnce();
    expect(test.boundedCalls).toEqual([[test.command.promise, 30_000, "the public R-file command for orders_frame"]]);
  });

  it("can select an exact variable without repeating discovery assertions", async () => {
    const test = fixture();

    await expect(test.invoke(test.workbench, source, "orders_frame", false)).resolves.toBeUndefined();
    expect(test.releasedJupyterQuickPickRow).toHaveBeenCalledExactlyOnceWith(test.picker, "orders_frame");
  });

  it("fails when the command ends before its picker becomes visible", async () => {
    const test = fixture();
    test.pickerWait.mockReturnValueOnce(new Promise(() => undefined));
    test.command.resolve(false);

    await expect(test.invoke(test.workbench, source, "orders_frame", false)).rejects.toThrow(
      /ended before showing its real picker/u
    );
    expect(test.inputFill).not.toHaveBeenCalled();
  });

  it("fails closed when the selected variable is absent", async () => {
    const test = fixture();
    test.rows.delete("orders_frame");

    await expect(test.invoke(test.workbench, source, "orders_frame", false)).rejects.toThrow(
      /did not expose "orders_frame"/u
    );
    expect(test.boundedCalls).toEqual([]);
  });

  it("requires the bounded command outcome to confirm success", async () => {
    const test = fixture();
    const row = test.rows.get("orders_frame")!;
    Object.assign(row, {
      click: vi.fn(async () => test.command.resolve(false))
    });

    await expect(test.invoke(test.workbench, source, "orders_frame", false)).rejects.toThrow();
    expect(test.boundedCalls).toEqual([[test.command.promise, 30_000, "the public R-file command for orders_frame"]]);
  });
});
