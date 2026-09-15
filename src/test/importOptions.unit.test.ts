import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

interface PromptOptions {
  readonly title?: string;
  readonly prompt?: string;
  readonly value?: string;
  readonly ignoreFocusOut?: boolean;
}

interface Pick {
  readonly label: string;
  readonly description?: string;
  readonly detail?: string;
  readonly value: unknown;
  readonly custom?: boolean;
}

const importOptionMocks = vi.hoisted(() => ({
  pickResponse: vi.fn<(items: readonly unknown[], options?: PromptOptions) => Promise<unknown>>(async () => undefined),
  inputResponse: vi.fn<(options?: PromptOptions) => Promise<string | undefined>>(async () => undefined),
  executeCommand: vi.fn<(command: string, ...args: unknown[]) => Promise<void>>(async () => undefined),
  read: vi.fn(),
  close: vi.fn(async () => undefined),
  open: vi.fn()
}));

vi.mock("node:fs/promises", () => ({
  default: { open: importOptionMocks.open },
  open: importOptionMocks.open
}));

vi.mock("vscode", () => ({
  Uri: {
    file: (fsPath: string) => ({
      scheme: "file",
      authority: "",
      path: fsPath,
      fsPath,
      toString: () => `file://${fsPath}`
    })
  },
  window: {
    createQuickPick: () => createPrompt("pick"),
    createInputBox: () => createPrompt("input")
  },
  commands: {
    executeCommand: importOptionMocks.executeCommand
  }
}));

import * as vscode from "vscode";
import {
  defaultImportOptions,
  detectImportOptions,
  ImportCancelledError,
  promptImportOptions
} from "../extension/files/importOptions";
import { IMPORT_DETECTION_SAMPLE_BYTES } from "../extension/files/importDetection";
import { formatQuickPickName } from "../extension/quickPickName";

interface Prompt {
  title: string;
  placeholder: string;
  prompt: string;
  value: string;
  ignoreFocusOut: boolean;
  items: Pick[];
  selectedItems: Pick[];
  validationMessage: string | undefined;
  onDidAccept(listener: () => void): vscode.Disposable;
  onDidHide(listener: () => void): vscode.Disposable;
  onDidChangeSelection(listener: (items: Pick[]) => void): vscode.Disposable;
  onDidChangeValue(listener: (value: string) => void): vscode.Disposable;
  edit(value: string): void;
  accept(): void;
  select(item: Pick): void;
  show: Mock<() => void>;
  hide: Mock<() => void>;
  dispose: Mock<() => void>;
  hideListeners: Set<() => void>;
}
const prompts: Prompt[] = [];
const promptEvents: string[] = [];
let visiblePrompt: Prompt | undefined;

function createPrompt(kind: "pick" | "input"): Prompt {
  const accept = new Set<() => void>();
  const hide = new Set<() => void>();
  const selection = new Set<(items: Pick[]) => void>();
  const change = new Set<(value: string) => void>();
  const subscribe = <T>(listeners: Set<T>, listener: T) => {
    listeners.add(listener);
    return { dispose: () => listeners.delete(listener) };
  };
  const input = {
    title: "",
    placeholder: "",
    prompt: "",
    value: "",
    ignoreFocusOut: false,
    items: [] as Pick[],
    selectedItems: [] as Pick[],
    validationMessage: undefined as string | undefined,
    onDidAccept: (listener: () => void) => subscribe(accept, listener),
    onDidHide: (listener: () => void) => subscribe(hide, listener),
    onDidChangeSelection: (listener: (items: Pick[]) => void) => subscribe(selection, listener),
    onDidChangeValue: (listener: (value: string) => void) => subscribe(change, listener),
    edit(value: string): void {
      input.value = value;
      for (const listener of change) listener(value);
    },
    accept(): void {
      for (const listener of accept) listener();
    },
    select(item: Pick): void {
      input.selectedItems = [item];
      for (const listener of selection) listener(input.selectedItems);
    },
    show: vi.fn<() => void>(() => {
      const previous = visiblePrompt;
      visiblePrompt = input;
      promptEvents.push(`show:${input.title}`);
      // Native controller replacement emits the old hide event without hiding
      // the shared Quick Input widget or restoring editor focus.
      for (const listener of previous ? previous.hideListeners : []) listener();
      const options = {
        title: input.title,
        placeHolder: input.placeholder,
        prompt: input.prompt,
        value: input.value,
        ignoreFocusOut: input.ignoreFocusOut
      };
      const response =
        kind === "pick"
          ? importOptionMocks.pickResponse(input.items, options)
          : importOptionMocks.inputResponse(options);
      void response.then((value) => {
        if (input.dispose.mock.calls.length) return;
        if (value === undefined) input.hide();
        else {
          if (kind === "pick") input.selectedItems = [value as Pick];
          else input.edit(value as string);
          input.accept();
        }
      });
    }),
    hide: vi.fn<() => void>(() => {
      if (visiblePrompt === input) visiblePrompt = undefined;
      promptEvents.push(`hide:${input.title}`);
      for (const listener of hide) listener();
    }),
    dispose: vi.fn<() => void>(() => {
      promptEvents.push(`dispose:${input.title}`);
      if (visiblePrompt === input) input.hide();
      accept.clear();
      hide.clear();
      selection.clear();
      change.clear();
    }),
    hideListeners: hide
  };
  prompts.push(input);
  return input;
}

describe("literal Quick Pick names", () => {
  it("keeps ordinary names and uses distinct JSON notation for special spellings", () => {
    const cases = [
      ["orders", "orders"],
      ["销售 total $", "销售 total $"],
      ["$(add)", String.raw`"\u0024(add)"`],
      [String.raw`\$(add)`, String.raw`"\\\u0024(add)"`],
      [String.raw`\u0024(add)`, String.raw`"\\u0024(add)"`],
      ["$(bad_name)", String.raw`"\u0024(bad_name)"`],
      ['"orders"', String.raw`"\"orders\""`],
      [" orders ", '" orders "'],
      ["\u00a0orders", '"\u00a0orders"'],
      ["a\nb", String.raw`"a\nb"`],
      ["a\rb", String.raw`"a\rb"`],
      ["a\r\nb", String.raw`"a\r\nb"`],
      [String.raw`a\nb`, String.raw`"a\\nb"`],
      ["a⏎b", "a⏎b"],
      ["a\tb", String.raw`"a\tb"`],
      ["a\u001bb", String.raw`"a\u001bb"`]
    ] as const;
    const displayed = cases.map(([name, expected]) => {
      const label = formatQuickPickName(name);
      expect(label).toBe(expected);
      expect(label).not.toContain("$(");
      expect(label.startsWith('"') ? JSON.parse(label) : label).toBe(name);
      return label;
    });
    expect(new Set(displayed).size).toBe(cases.length);
  });
});

describe("import option defaults", () => {
  it.each(["workbook.xlsx", "legacy.xls", "UPPER.XLS"])("uses the public zero-based sheet index for %s", (name) => {
    expect(defaultImportOptions(vscode.Uri.file(`/tmp/${name}`))).toEqual({ sheetIndex: 0 });
  });

  it("does not invent options for formats without interactive import settings", () => {
    expect(defaultImportOptions(vscode.Uri.file("/tmp/data.parquet"))).toBeUndefined();
  });
});

describe("automatic import option sampling", () => {
  beforeEach(() => {
    importOptionMocks.read.mockReset();
    importOptionMocks.close.mockClear();
    importOptionMocks.open.mockReset();
    importOptionMocks.open.mockResolvedValue({
      read: importOptionMocks.read,
      close: importOptionMocks.close
    });
  });

  it.each(["\n", "\r"])(
    "performs one bounded positional local read for %j records and closes the descriptor",
    async (ending) => {
      const bytes = new TextEncoder().encode(["name\tvalue", "one\t1", "two\t2", ""].join(ending));
      importOptionMocks.read.mockImplementationOnce(
        async (buffer: Uint8Array, offset: number, _length: number, position: number) => {
          expect(position).toBe(0);
          buffer.set(bytes, offset);
          return { bytesRead: bytes.length, buffer };
        }
      );

      await expect(detectImportOptions(vscode.Uri.file("/tmp/misleading.csv"))).resolves.toEqual({
        delimiter: "\t",
        encoding: "utf-8",
        quoteChar: '"',
        hasHeader: true,
        ...(ending === "\r" ? { lineEnding: "cr" } : {})
      });

      expect(importOptionMocks.open).toHaveBeenCalledWith("/tmp/misleading.csv", "r");
      expect(importOptionMocks.read).toHaveBeenCalledOnce();
      const [buffer, offset, length, position] = importOptionMocks.read.mock.calls[0] ?? [];
      expect(Buffer.isBuffer(buffer)).toBe(true);
      expect(buffer).toHaveLength(IMPORT_DETECTION_SAMPLE_BYTES + 3);
      expect([offset, length, position]).toEqual([0, IMPORT_DETECTION_SAMPLE_BYTES + 3, 0]);
      expect(importOptionMocks.close).toHaveBeenCalledOnce();
    }
  );

  it("reads enough lookahead to preserve a UTF-8 scalar across the nominal boundary", async () => {
    const heading = "name;value\none;1\n";
    const bytes = new TextEncoder().encode(
      `${heading}${"x".repeat(IMPORT_DETECTION_SAMPLE_BYTES - heading.length - 1)}😀;2\n`
    );
    importOptionMocks.read.mockImplementationOnce(async (buffer: Uint8Array, offset: number, length: number) => {
      const returned = bytes.subarray(0, length);
      buffer.set(returned, offset);
      return { bytesRead: returned.length, buffer };
    });

    await expect(detectImportOptions(vscode.Uri.file("/tmp/boundary.csv"))).resolves.toEqual({
      delimiter: ";",
      encoding: "utf-8",
      quoteChar: '"',
      hasHeader: true
    });
    expect(importOptionMocks.read).toHaveBeenCalledOnce();
    expect(importOptionMocks.close).toHaveBeenCalledOnce();
  });

  it("uses the same bounded host-local read for remote-workspace files", async () => {
    const remote = {
      scheme: "vscode-remote",
      fsPath: "/workspace/data.tsv"
    } as vscode.Uri;
    const bytes = new TextEncoder().encode("name;value\none;1\n");
    importOptionMocks.read.mockImplementationOnce(async (buffer: Uint8Array) => {
      buffer.set(bytes);
      return { bytesRead: bytes.length, buffer };
    });

    await expect(detectImportOptions(remote)).resolves.toEqual({
      delimiter: ";",
      encoding: "utf-8",
      quoteChar: '"',
      hasHeader: true
    });
    expect(importOptionMocks.open).toHaveBeenCalledWith("/workspace/data.tsv", "r");
    expect(importOptionMocks.read).toHaveBeenCalledOnce();
    expect(importOptionMocks.close).toHaveBeenCalledOnce();
  });

  it("falls back safely and closes the descriptor when sampling fails", async () => {
    importOptionMocks.read.mockRejectedValueOnce(new Error("unreadable"));

    await expect(detectImportOptions(vscode.Uri.file("/tmp/data.csv"))).resolves.toEqual({
      delimiter: ",",
      encoding: "utf-8",
      quoteChar: '"',
      hasHeader: true
    });
    expect(importOptionMocks.close).toHaveBeenCalledOnce();
  });
});

describe("Excel import prompts", () => {
  beforeEach(resetPromptMocks);

  it("shows actual worksheet names and promotes the current zero-based sheet without a text prompt", async () => {
    importOptionMocks.pickResponse.mockImplementationOnce(async (items) => items[0]);

    await expect(
      promptImportOptions(vscode.Uri.file("/tmp/data.xlsx"), { sheetIndex: 1 }, undefined, [
        "Overview",
        "Sales",
        "2024"
      ])
    ).resolves.toEqual({ sheetName: "Sales" });

    expect(picksAt(0).map(({ label, value }) => ({ label, value }))).toEqual([
      { label: "Sales", value: "Sales" },
      { label: "Overview", value: "Overview" },
      { label: "2024", value: "2024" }
    ]);
    expect(picksAt(0)[0]).toMatchObject({
      description: "Current",
      detail: "Worksheet 2 of 3"
    });
    expect(importOptionMocks.pickResponse.mock.calls[0]?.[1]).toMatchObject({
      title: "Excel sheet",
      placeHolder: "Choose a worksheet. Search shown names (special names use JSON escapes).",
      ignoreFocusOut: true
    });
    expect(importOptionMocks.inputResponse).not.toHaveBeenCalled();
  });

  it("keeps numeric worksheet names name-addressed when selected from workbook metadata", async () => {
    importOptionMocks.pickResponse.mockImplementationOnce(async (items) =>
      (items as Pick[]).find(({ value }) => value === "2024")
    );

    await expect(
      promptImportOptions(vscode.Uri.file("/tmp/data.xls"), { sheetName: "Overview" }, undefined, ["Overview", "2024"])
    ).resolves.toEqual({ sheetName: "2024" });
    expect(importOptionMocks.inputResponse).not.toHaveBeenCalled();
  });

  it.each([
    ["$(add)\n", String.raw`"\u0024(add)\n"`],
    [" ", '" "']
  ])("retains literal worksheet name %j in selection and current values", async (name, label) => {
    importOptionMocks.pickResponse.mockImplementationOnce(async (items) => items[0]);
    await expect(
      promptImportOptions(vscode.Uri.file("/tmp/data.xlsx"), { sheetName: name }, undefined, [
        "Overview",
        name,
        "Sales"
      ])
    ).resolves.toEqual({ sheetName: name });
    expect(picksAt(0)[0]).toMatchObject({ label, value: name, description: "Current" });
    expect(picksAt(0).map(({ value }) => value)).toEqual([name, "Overview", "Sales"]);
    expect(importOptionMocks.inputResponse).not.toHaveBeenCalled();

    importOptionMocks.pickResponse.mockImplementationOnce(async (items) => items[0]);
    importOptionMocks.inputResponse.mockResolvedValueOnce(name);
    await expect(promptImportOptions(vscode.Uri.file("/tmp/data.xlsx"), { sheetName: name })).resolves.toEqual({
      sheetName: name
    });
    expect(picksAt(1)[0]).toMatchObject({ detail: `Current: ${label}`, value: "name" });
    expect(inputOptionsAt(0).value).toBe(name);
  });

  it("keeps a numeric worksheet name unambiguously name-addressed and prefills the current name", async () => {
    importOptionMocks.pickResponse.mockImplementationOnce(async (items) => items[0]);
    importOptionMocks.inputResponse.mockResolvedValueOnce("0");

    await expect(promptImportOptions(vscode.Uri.file("/tmp/data.xlsx"), { sheetName: "2024" })).resolves.toEqual({
      sheetName: "0"
    });

    expect(picksAt(0).map(({ value }) => value)).toEqual(["name", "index"]);
    expect(picksAt(0)[0]).toMatchObject({
      label: "Sheet name",
      detail: "Current: 2024",
      value: "name"
    });
    expect(inputOptionsAt(0)).toMatchObject({
      title: "Excel sheet name",
      value: "2024",
      ignoreFocusOut: true
    });
    expect(importOptionMocks.pickResponse.mock.calls.map(([, options]) => options?.ignoreFocusOut)).toEqual([true]);
  });

  it("uses an explicit zero-based index mode and prefills the current index", async () => {
    importOptionMocks.pickResponse.mockImplementationOnce(async (items) => items[0]);
    importOptionMocks.inputResponse.mockResolvedValueOnce("7");

    await expect(promptImportOptions(vscode.Uri.file("/tmp/data.xls"), { sheetIndex: 3 })).resolves.toEqual({
      sheetIndex: 7
    });

    expect(picksAt(0).map(({ value }) => value)).toEqual(["index", "name"]);
    expect(picksAt(0)[0]).toMatchObject({
      label: "Sheet index",
      detail: "Current: 3",
      value: "index"
    });
    expect(inputOptionsAt(0)).toMatchObject({
      title: "Excel sheet index",
      value: "3",
      ignoreFocusOut: true
    });
    expect(importOptionMocks.pickResponse.mock.calls.map(([, options]) => options?.ignoreFocusOut)).toEqual([true]);
  });

  it("switches from a current index to an exact numeric name without coercion", async () => {
    importOptionMocks.pickResponse.mockImplementationOnce(async (items) =>
      (items as Pick[]).find(({ value }) => value === "name")
    );
    importOptionMocks.inputResponse.mockResolvedValueOnce("12");

    await expect(promptImportOptions(vscode.Uri.file("/tmp/data.xlsx"), { sheetIndex: 4 })).resolves.toEqual({
      sheetName: "12"
    });

    expect(inputOptionsAt(0).value).toBe("");
  });

  it("switches from a current name to a zero-based index with a safe default", async () => {
    importOptionMocks.pickResponse.mockImplementationOnce(async (items) =>
      (items as Pick[]).find(({ value }) => value === "index")
    );
    importOptionMocks.inputResponse.mockResolvedValueOnce("0");

    await expect(promptImportOptions(vscode.Uri.file("/tmp/data.xlsx"), { sheetName: "Data" })).resolves.toEqual({
      sheetIndex: 0
    });

    expect(inputOptionsAt(0).value).toBe("0");
  });

  it("validates blank names and invalid index syntax before the input can be accepted", async () => {
    importOptionMocks.pickResponse
      .mockImplementationOnce(async (items) => (items as Pick[]).find(({ value }) => value === "name"))
      .mockImplementationOnce(async (items) => (items as Pick[]).find(({ value }) => value === "index"));
    importOptionMocks.inputResponse.mockImplementation(async (options) => {
      const input = visiblePrompt!;
      const cases: [string, string | undefined][] =
        options?.title === "Excel sheet name"
          ? [
              ["", "Enter a non-empty sheet name."],
              ["   ", undefined],
              ["0", undefined]
            ]
          : [
              ["", "Enter a non-negative whole number."],
              ["true", "Enter a non-negative whole number."],
              ["-1", "Enter a non-negative whole number."],
              ["1.5", "Enter a non-negative whole number."],
              ["01", "Enter a non-negative whole number."],
              ["0", undefined],
              ["12", undefined],
              ["9007199254740992", "Enter a smaller sheet index."]
            ];
      for (const [value, message] of cases) {
        input.edit(value);
        expect(input.validationMessage).toBe(message);
        if (message) {
          input.accept();
          expect(visiblePrompt).toBe(input);
        }
      }
      return options?.title === "Excel sheet name" ? "Data" : "2";
    });
    await expect(promptImportOptions(vscode.Uri.file("/tmp/data.xlsx"))).resolves.toEqual({ sheetName: "Data" });
    await expect(promptImportOptions(vscode.Uri.file("/tmp/data.xlsx"))).resolves.toEqual({ sheetIndex: 2 });
  });

  it("keeps an invalid index open until the user cancels", async () => {
    chooseFirstItems();
    let reached!: () => void;
    const shown = new Promise<void>((resolve) => {
      reached = resolve;
    });
    importOptionMocks.inputResponse.mockImplementationOnce(async () => {
      reached();
      return "true";
    });
    const prompt = promptImportOptions(vscode.Uri.file("/tmp/data.xlsx"));
    const rejection = expect(prompt).rejects.toBeInstanceOf(ImportCancelledError);
    await shown;
    await Promise.resolve();
    expect(visiblePrompt?.validationMessage).toBe("Enter a non-negative whole number.");
    expect(visiblePrompt?.dispose).not.toHaveBeenCalled();
    visiblePrompt!.hide();
    await rejection;
    expect(prompts.every((input) => input.dispose.mock.calls.length === 1)).toBe(true);
  });

  it("preserves cancellation at the mode and value prompts", async () => {
    await expect(promptImportOptions(vscode.Uri.file("/tmp/data.xlsx"))).rejects.toBeInstanceOf(ImportCancelledError);

    importOptionMocks.pickResponse.mockImplementationOnce(async (items) => items[0]);
    await expect(promptImportOptions(vscode.Uri.file("/tmp/data.xlsx"))).rejects.toBeInstanceOf(ImportCancelledError);
  });
});

describe("delimited-file import prompts", () => {
  beforeEach(resetPromptMocks);

  it("prefills and preserves every current CSV field, including custom values", async () => {
    chooseFirstItems();
    importOptionMocks.inputResponse.mockImplementation(async (options) => options?.value);

    await expect(
      promptImportOptions(vscode.Uri.file("/tmp/data.csv"), {
        delimiter: "§",
        encoding: "windows-1252",
        quoteChar: "'",
        hasHeader: false
      })
    ).resolves.toEqual({
      delimiter: "§",
      encoding: "windows-1252",
      quoteChar: "'",
      hasHeader: false
    });

    expect(picksAt(0)[0]).toMatchObject({
      label: "Current: §",
      description: "Custom delimiter",
      value: "§"
    });
    expect(picksAt(1)[0]).toMatchObject({
      description: "Current",
      value: "windows-1252"
    });
    expect(picksAt(2)[0]).toMatchObject({
      label: "Generate column names",
      description: "Current",
      value: false
    });
    expect(inputOptionsAt(0)).toMatchObject({
      title: "Quote character",
      value: "'",
      ignoreFocusOut: true
    });
    expect(importOptionMocks.pickResponse.mock.calls.map(([, options]) => options?.ignoreFocusOut)).toEqual([
      true,
      true,
      true,
      true
    ]);
    expect(importOptionMocks.executeCommand.mock.calls.map(([command]) => command)).toEqual([
      "workbench.action.focusActiveEditorGroup"
    ]);
  });

  it.each([
    { current: undefined, selected: "lf", expected: undefined },
    { current: undefined, selected: "cr", expected: "cr" },
    { current: "cr", selected: "cr", expected: "cr" },
    { current: "cr", selected: "lf", expected: "lf" },
    { current: "lf", selected: "lf", expected: "lf" }
  ] as const)("preserves line-ending intent from $current to $selected", async ({ current, selected, expected }) => {
    const options = {
      delimiter: ";",
      encoding: "utf-8",
      quoteChar: '"',
      hasHeader: true,
      ...(current ? { lineEnding: current } : {})
    };
    importOptionMocks.pickResponse.mockImplementation(async (items, prompt) =>
      prompt?.title === "Line ending" ? (items as Pick[]).find(({ value }) => value === selected) : items[0]
    );
    importOptionMocks.inputResponse.mockImplementation(async (prompt) => prompt?.value);
    await expect(promptImportOptions(vscode.Uri.file("/tmp/data.csv"), options)).resolves.toEqual({
      delimiter: ";",
      encoding: "utf-8",
      quoteChar: '"',
      hasHeader: true,
      ...(expected ? { lineEnding: expected } : {})
    });
    expect(
      picksAt(3)
        .map(({ label }) => label)
        .sort()
    ).toEqual(["CR", "LF or CRLF"]);
    expect(picksAt(3)[0]).toMatchObject({ value: current ?? "lf", description: "Current" });
  });

  it("rechecks cancellation after the line-ending choice settles", async () => {
    let cancelled = false;
    const cancellation = {
      get isCancellationRequested() {
        return cancelled;
      },
      onCancellationRequested: () => ({ dispose() {} })
    } as vscode.CancellationToken;
    importOptionMocks.pickResponse.mockImplementation(async (items, options) => {
      if (options?.title === "Line ending") cancelled = true;
      return items[0];
    });
    importOptionMocks.inputResponse.mockImplementation(async (options) => options?.value);
    await expect(promptImportOptions(vscode.Uri.file("/tmp/data.csv"), undefined, cancellation)).rejects.toBeInstanceOf(
      ImportCancelledError
    );
  });

  it("offers explicit UTF-16 byte-order recovery choices", async () => {
    chooseFirstItems();
    importOptionMocks.inputResponse.mockImplementation(async (options) => options?.value);

    await expect(
      promptImportOptions(vscode.Uri.file("/tmp/data.tsv"), {
        delimiter: "\t",
        encoding: "utf-16be",
        quoteChar: '"',
        hasHeader: true
      })
    ).resolves.toEqual({
      delimiter: "\t",
      encoding: "utf-16be",
      quoteChar: '"',
      hasHeader: true
    });

    expect(picksAt(1).map(({ value }) => value)).toEqual([
      "utf-16be",
      "utf-8",
      "utf8-lossy",
      "utf-16le",
      "iso-8859-1",
      "windows-1252"
    ]);
    expect(picksAt(1)[0]).toMatchObject({ description: "Current", value: "utf-16be" });
  });

  it("prefills the custom-delimiter field from the current value", async () => {
    importOptionMocks.pickResponse.mockImplementation(async (items, options) => {
      const choices = items as Pick[];
      if (options?.title === "Delimiter") return choices.find(({ custom }) => custom === true);
      return choices[0];
    });
    importOptionMocks.inputResponse.mockImplementation(async (options) =>
      options?.title === "Custom delimiter" ? ":" : options?.value
    );

    await expect(
      promptImportOptions(vscode.Uri.file("/tmp/data.tsv"), {
        delimiter: "\t",
        encoding: "utf-8",
        quoteChar: '"',
        hasHeader: true
      })
    ).resolves.toEqual({
      delimiter: ":",
      encoding: "utf-8",
      quoteChar: '"',
      hasHeader: true
    });

    expect(inputOptionsAt(0)).toMatchObject({
      title: "Custom delimiter",
      value: "\t",
      ignoreFocusOut: true
    });
    expect(inputOptionsAt(1)).toMatchObject({
      title: "Quote character",
      ignoreFocusOut: true
    });
    expect(promptEvents).toEqual([
      "show:Delimiter",
      "show:Custom delimiter",
      "dispose:Delimiter",
      "show:Text encoding",
      "dispose:Custom delimiter",
      "show:Header row",
      "dispose:Text encoding",
      "show:Quote character",
      "dispose:Header row",
      "show:Line ending",
      "dispose:Quote character",
      "dispose:Line ending",
      "hide:Line ending"
    ]);
    expect(prompts.every((input) => input.dispose.mock.calls.length === 1)).toBe(true);
    expect(visiblePrompt).toBeUndefined();
  });

  it("does not publish the first prompt before active-editor focus settles", async () => {
    chooseFirstItems();
    importOptionMocks.inputResponse.mockImplementation(async (options) => options?.value);
    let settleFocus!: () => void;
    importOptionMocks.executeCommand.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          settleFocus = resolve;
        })
    );

    const prompt = promptImportOptions(vscode.Uri.file("/tmp/data.csv"));
    try {
      expect(importOptionMocks.executeCommand).toHaveBeenCalledOnce();
      expect(importOptionMocks.executeCommand).toHaveBeenCalledWith("workbench.action.focusActiveEditorGroup");
      expect(importOptionMocks.pickResponse).not.toHaveBeenCalled();
      expect(importOptionMocks.inputResponse).not.toHaveBeenCalled();
    } finally {
      settleFocus();
    }

    await expect(prompt).resolves.toEqual({
      delimiter: ",",
      encoding: "utf-8",
      quoteChar: '"',
      hasHeader: true
    });
    expect(importOptionMocks.pickResponse).toHaveBeenCalledTimes(4);
    expect(importOptionMocks.inputResponse).toHaveBeenCalledOnce();
    expect(importOptionMocks.executeCommand.mock.calls.map(([command]) => command)).toEqual([
      "workbench.action.focusActiveEditorGroup"
    ]);
  });

  it("accepts mouse selections once and ignores events from the previous prompt during handoff", async () => {
    importOptionMocks.pickResponse.mockImplementation(async (items, options) => {
      const input = visiblePrompt!;
      const previous = prompts.at(-2);
      previous?.accept();
      previous?.hide();
      const selected =
        options?.title === "Delimiter" ? (items as Pick[]).find(({ value }) => value === "|")! : (items[0] as Pick);
      input.select(selected);
      // A queued accept event must not reread a changed selection or submit the
      // successor; the mouse choice was already captured synchronously.
      input.selectedItems = [];
      input.accept();
      return items[0];
    });
    importOptionMocks.inputResponse.mockImplementation(async (options) => options?.value);
    await expect(promptImportOptions(vscode.Uri.file("/tmp/data.csv"))).resolves.toEqual({
      delimiter: "|",
      encoding: "utf-8",
      quoteChar: '"',
      hasHeader: true
    });
    expect(prompts).toHaveLength(5);
    expect(prompts.every((input) => input.dispose.mock.calls.length === 1)).toBe(true);
    expect(visiblePrompt).toBeUndefined();
  });

  it.each(["hide", "token"] as const)(
    "cancels on %s after acceptance before a successor or result is published",
    async (cause) => {
      for (const title of ["Delimiter", "Line ending"]) {
        resetPromptMocks();
        const listeners = new Set<() => void>();
        let cancelled = false;
        const cancellation: vscode.CancellationToken = {
          get isCancellationRequested() {
            return cancelled;
          },
          onCancellationRequested(listener: (event: unknown) => unknown) {
            const notify = () => {
              listener(undefined);
            };
            listeners.add(notify);
            return {
              dispose: () => {
                listeners.delete(notify);
              }
            };
          }
        };
        importOptionMocks.pickResponse.mockImplementation(async (items, options) => {
          if (options?.title === title) {
            visiblePrompt!.select(items[0] as Pick);
            if (cause === "hide") visiblePrompt!.hide();
            else {
              cancelled = true;
              for (const listener of listeners) listener();
            }
          }
          return items[0];
        });
        importOptionMocks.inputResponse.mockImplementation(async (options) => options?.value);
        await expect(
          promptImportOptions(vscode.Uri.file("/tmp/data.csv"), undefined, cancellation)
        ).rejects.toBeInstanceOf(ImportCancelledError);
        expect(prompts.at(-1)?.title).toBe(title);
        expect(prompts.every((input) => input.dispose.mock.calls.length === 1)).toBe(true);
        expect(listeners.size).toBe(0);
        expect(visiblePrompt).toBeUndefined();
      }
    }
  );

  it("disposes both owned prompts if showing the successor fails", async () => {
    importOptionMocks.pickResponse.mockImplementation(async (items) => items[0]);
    importOptionMocks.pickResponse
      .mockImplementationOnce(async (items) => items[0])
      .mockImplementationOnce(() => {
        throw new Error("Native input unavailable");
      });
    await expect(promptImportOptions(vscode.Uri.file("/tmp/data.csv"))).rejects.toThrow("Native input unavailable");
    expect(prompts.map(({ title }) => title)).toEqual(["Delimiter", "Text encoding"]);
    expect(prompts.every((input) => input.dispose.mock.calls.length === 1)).toBe(true);
    expect(visiblePrompt).toBeUndefined();
  });

  it("falls back to the editor's native focus behavior when a fork omits the focus command", async () => {
    chooseFirstItems();
    importOptionMocks.inputResponse.mockImplementation(async (options) => options?.value);
    importOptionMocks.executeCommand.mockRejectedValue(new Error("Command not found"));

    await expect(promptImportOptions(vscode.Uri.file("/tmp/data.csv"))).resolves.toEqual({
      delimiter: ",",
      encoding: "utf-8",
      quoteChar: '"',
      hasHeader: true
    });
    expect(importOptionMocks.executeCommand.mock.calls.map(([command]) => command)).toEqual([
      "workbench.action.focusActiveEditorGroup"
    ]);
  });

  it("rechecks cancellation after active-editor focus settles", async () => {
    let cancelled = false;
    const cancellation = {
      get isCancellationRequested() {
        return cancelled;
      },
      onCancellationRequested: () => ({ dispose() {} })
    } as vscode.CancellationToken;
    importOptionMocks.executeCommand.mockImplementationOnce(async () => {
      cancelled = true;
    });

    await expect(promptImportOptions(vscode.Uri.file("/tmp/data.csv"), undefined, cancellation)).rejects.toBeInstanceOf(
      ImportCancelledError
    );
    expect(importOptionMocks.executeCommand).toHaveBeenCalledOnce();
    expect(importOptionMocks.executeCommand).toHaveBeenCalledWith("workbench.action.focusActiveEditorGroup");
    expect(importOptionMocks.pickResponse).not.toHaveBeenCalled();
    expect(importOptionMocks.inputResponse).not.toHaveBeenCalled();
  });

  it.each(["delimiter", "custom delimiter", "encoding", "header", "quote", "line ending"] as const)(
    "preserves cancellation at the %s prompt",
    async (stage) => {
      importOptionMocks.pickResponse.mockImplementation(async (items, options) => {
        const choices = items as Pick[];
        if (options?.title === "Delimiter") {
          if (stage === "delimiter") return undefined;
          if (stage === "custom delimiter") return choices.find(({ custom }) => custom === true);
          return choices[0];
        }
        if (options?.title === "Text encoding" && stage === "encoding") return undefined;
        if (options?.title === "Header row" && stage === "header") return undefined;
        if (options?.title === "Line ending" && stage === "line ending") return undefined;
        return choices[0];
      });
      importOptionMocks.inputResponse.mockImplementation(async (options) => {
        if (options?.title === "Custom delimiter" && stage === "custom delimiter") return undefined;
        if (options?.title === "Quote character" && stage === "quote") return undefined;
        return options?.value;
      });

      await expect(promptImportOptions(vscode.Uri.file("/tmp/data.csv"))).rejects.toBeInstanceOf(ImportCancelledError);
      expect(prompts.every((input) => input.dispose.mock.calls.length === 1)).toBe(true);
      expect(visiblePrompt).toBeUndefined();
    }
  );

  it("does not prompt for a format without interactive import settings", async () => {
    await expect(promptImportOptions(vscode.Uri.file("/tmp/data.parquet"))).resolves.toBeUndefined();
    expect(importOptionMocks.pickResponse).not.toHaveBeenCalled();
    expect(importOptionMocks.inputResponse).not.toHaveBeenCalled();
    expect(importOptionMocks.executeCommand).not.toHaveBeenCalled();
  });
});

function resetPromptMocks(): void {
  prompts.length = 0;
  promptEvents.length = 0;
  visiblePrompt = undefined;
  importOptionMocks.pickResponse.mockReset();
  importOptionMocks.pickResponse.mockResolvedValue(undefined);
  importOptionMocks.inputResponse.mockReset();
  importOptionMocks.inputResponse.mockResolvedValue(undefined);
  importOptionMocks.executeCommand.mockReset();
  importOptionMocks.executeCommand.mockResolvedValue(undefined);
}

function chooseFirstItems(): void {
  importOptionMocks.pickResponse.mockImplementation(async (items) => items[0]);
}

function picksAt(call: number): Pick[] {
  return importOptionMocks.pickResponse.mock.calls[call]?.[0] as Pick[];
}

function inputOptionsAt(call: number): PromptOptions {
  return importOptionMocks.inputResponse.mock.calls[call]?.[0] as PromptOptions;
}
