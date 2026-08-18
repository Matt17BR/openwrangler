import { beforeEach, describe, expect, it } from "vitest";
import { link, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  appliedStep,
  command,
  exportableSnapshot,
  nativeMocks,
  noDraftSnapshot,
  pandasExportableSnapshot,
  register,
  resetNativeViewMocks,
  resourceUri,
  rDocumentSnapshot,
  rNotebookSnapshot,
  snapshot,
  vscodeUri
} from "./nativeViews.testFixtures";

describe("native export commands", () => {
  beforeEach(resetNativeViewMocks);

  it("ignores caller-provided export destinations and still opens the Save dialog", async () => {
    register(noDraftSnapshot());

    const hostileDestination = vscodeUri("/workspace/source.csv");
    await expect(command("openWrangler.exportCode")(hostileDestination)).resolves.toBe(false);

    expect(nativeMocks.showSaveDialog).toHaveBeenCalledOnce();
    expect(nativeMocks.showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Export Open Wrangler Python Code",
        filters: { "Python script": ["py"] },
        saveLabel: "Export code"
      })
    );
    expect(nativeMocks.showErrorMessage).not.toHaveBeenCalled();
  });

  it("uses an R script name and filter when exporting generated R code", async () => {
    register(rNotebookSnapshot());

    await expect(command("openWrangler.exportCode")()).resolves.toBe(false);

    expect(nativeMocks.showSaveDialog).toHaveBeenCalledOnce();
    expect(nativeMocks.showSaveDialog).toHaveBeenCalledWith({
      title: "Export Open Wrangler R Code",
      defaultUri: expect.objectContaining({ fsPath: "/workspace/orders.clean.R" }),
      filters: { "R script": ["R", "r"] },
      saveLabel: "Export code"
    });
  });

  it("exports the exact webview session even when another dataframe becomes active during the dialogs", async () => {
    const origin = exportableSnapshot("origin-session", "orders.csv", 3);
    const other = exportableSnapshot("other-session", "customers.csv", 8);
    const registered = register(origin);
    nativeMocks.showQuickPick.mockImplementation(async (items) => {
      if (nativeMocks.showQuickPick.mock.calls.length === 1) registered.setActiveSession(other);
      return (items as unknown[])[0];
    });
    nativeMocks.showSaveDialog.mockResolvedValueOnce(vscodeUri("/workspace/orders.cleaned.csv"));

    await expect(command("openWrangler.internal.exportSessionData")("origin-session", 3)).resolves.toBe(true);

    expect(registered.exportData).toHaveBeenCalledWith("origin-session", 3, "/workspace/orders.cleaned.csv", {
      format: "csv",
      delimiter: ",",
      quoteChar: '"',
      encoding: "utf-8",
      header: true
    });
    expect(nativeMocks.showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultUri: expect.objectContaining({ fsPath: "/workspace/orders.cleaned.csv" })
      })
    );
  });

  it("pins a global cleaned-data export before a dialog can change the active session", async () => {
    const origin = exportableSnapshot("origin-session", "orders.csv", 3);
    const other = exportableSnapshot("other-session", "customers.csv", 8);
    const registered = register(origin);
    nativeMocks.showQuickPick.mockImplementationOnce(async (items) => {
      registered.setActiveSession(other);
      return (items as Array<{ format: "csv" | "parquet" }>)[1];
    });
    nativeMocks.showSaveDialog.mockResolvedValueOnce(vscodeUri("/workspace/orders.cleaned.parquet"));

    await expect(command("openWrangler.exportData")()).resolves.toBe(true);

    expect(registered.exportData).toHaveBeenCalledWith("origin-session", 3, "/workspace/orders.cleaned.parquet", {
      format: "parquet"
    });
  });

  it.each([
    {
      rowAxis: { kind: "positional" as const, levelNames: [] },
      expectedOrder: ["omit", "preserve"],
      expectedPolicy: "omit"
    },
    {
      rowAxis: { kind: "index" as const, levelNames: ["account"] },
      expectedOrder: ["preserve", "omit"],
      expectedPolicy: "preserve"
    },
    {
      rowAxis: { kind: "multiIndex" as const, levelNames: ["region", "account"] },
      expectedOrder: ["preserve", "omit"],
      expectedPolicy: "preserve"
    }
  ])(
    "requires an explicit Pandas index choice with the row-axis-derived default order",
    async ({ rowAxis, expectedOrder, expectedPolicy }) => {
      const registered = register(pandasExportableSnapshot("pandas-session", "orders.csv", 3, rowAxis));
      nativeMocks.showQuickPick.mockImplementation(async (items) => (items as unknown[])[0]);
      nativeMocks.showSaveDialog.mockResolvedValueOnce(vscodeUri("/workspace/orders.cleaned.csv"));

      await expect(command("openWrangler.exportData")()).resolves.toBe(true);

      const policyItems = nativeMocks.showQuickPick.mock.calls[1]?.[0] as Array<{ policy: string }>;
      expect(policyItems.map(({ policy }) => policy)).toEqual(expectedOrder);
      expect(nativeMocks.showQuickPick.mock.calls[1]?.[1]).toEqual({
        title: "Export Pandas Index",
        placeHolder: "Choose whether to preserve the dataframe index"
      });
      expect(registered.exportData).toHaveBeenCalledWith("pandas-session", 3, "/workspace/orders.cleaned.csv", {
        format: "csv",
        delimiter: ",",
        quoteChar: '"',
        encoding: "utf-8",
        header: true,
        rowAxisPolicy: expectedPolicy
      });
    }
  );

  it("honors an explicit non-default Pandas index choice", async () => {
    const registered = register(
      pandasExportableSnapshot("pandas-session", "orders.csv", 3, {
        kind: "index",
        levelNames: ["account"]
      })
    );
    nativeMocks.showQuickPick
      .mockImplementationOnce(async (items) => (items as unknown[])[0])
      .mockImplementationOnce(async (items) => (items as unknown[])[1])
      .mockImplementationOnce(async (items) => (items as unknown[])[0]);
    nativeMocks.showSaveDialog.mockResolvedValueOnce(vscodeUri("/workspace/orders.cleaned.csv"));

    await expect(command("openWrangler.exportData")()).resolves.toBe(true);

    expect(registered.exportData).toHaveBeenCalledWith("pandas-session", 3, "/workspace/orders.cleaned.csv", {
      format: "csv",
      delimiter: ",",
      quoteChar: '"',
      encoding: "utf-8",
      header: true,
      rowAxisPolicy: "omit"
    });
  });

  it("offers the confirmed import dialect as the CSV export default", async () => {
    const active = pandasExportableSnapshot("pandas-session", "orders.csv", 3, {
      kind: "index",
      levelNames: ["account"]
    });
    active.metadata = {
      ...active.metadata,
      source: {
        ...active.metadata.source,
        importOptions: {
          delimiter: ";",
          quoteChar: "'",
          encoding: "windows-1252",
          hasHeader: false
        }
      }
    };
    const registered = register(active);
    nativeMocks.showQuickPick.mockImplementation(async (items) => (items as unknown[])[0]);
    nativeMocks.showSaveDialog.mockResolvedValueOnce(vscodeUri("/workspace/orders.cleaned.csv"));

    await expect(command("openWrangler.exportData")()).resolves.toBe(true);

    const settings = nativeMocks.showQuickPick.mock.calls[2]?.[0] as Array<{ label: string; description: string }>;
    expect(settings[0]).toMatchObject({
      label: "Use confirmed source settings",
      description: `";" delimiter · windows-1252 · no header · "'" quote`
    });
    expect(registered.exportData).toHaveBeenCalledWith("pandas-session", 3, "/workspace/orders.cleaned.csv", {
      format: "csv",
      delimiter: ";",
      quoteChar: "'",
      encoding: "windows-1252",
      header: false,
      rowAxisPolicy: "preserve"
    });
  });

  it("does not reuse the import-only lossy UTF-8 sentinel as an export encoding", async () => {
    const active = pandasExportableSnapshot("pandas-session", "orders.csv", 3, {
      kind: "positional",
      levelNames: []
    });
    active.metadata = {
      ...active.metadata,
      source: { ...active.metadata.source, importOptions: { encoding: "utf8-lossy" } }
    };
    const registered = register(active);
    nativeMocks.showQuickPick.mockImplementation(async (items) => (items as unknown[])[0]);
    nativeMocks.showSaveDialog.mockResolvedValueOnce(vscodeUri("/workspace/orders.cleaned.csv"));

    await expect(command("openWrangler.exportData")()).resolves.toBe(true);

    expect(registered.exportData).toHaveBeenCalledWith("pandas-session", 3, "/workspace/orders.cleaned.csv", {
      format: "csv",
      delimiter: ",",
      quoteChar: '"',
      encoding: "utf-8",
      header: true,
      rowAxisPolicy: "omit"
    });
  });

  it("dispatches an explicitly configured engine-native CSV dialect", async () => {
    const registered = register(exportableSnapshot("polars-session", "orders.csv", 3));
    nativeMocks.showQuickPick.mockImplementation(async (items, options) => {
      const title = (options as { title?: string } | undefined)?.title;
      if (title === "CSV Export Settings") return (items as unknown[])[1];
      if (title === "CSV Delimiter") {
        return (items as Array<{ label: string }>).find(({ label }) => label === "Semicolon");
      }
      if (title === "CSV Header") return (items as unknown[])[1];
      return (items as unknown[])[0];
    });
    nativeMocks.showInputBox.mockResolvedValueOnce("'");
    nativeMocks.showSaveDialog.mockResolvedValueOnce(vscodeUri("/workspace/orders.cleaned.csv"));

    await expect(command("openWrangler.exportData")()).resolves.toBe(true);

    expect(nativeMocks.showInputBox).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "CSV Quote Character",
        value: '"'
      })
    );
    expect(registered.exportData).toHaveBeenCalledWith("polars-session", 3, "/workspace/orders.cleaned.csv", {
      format: "csv",
      delimiter: ";",
      quoteChar: "'",
      encoding: "utf-8",
      header: false
    });
  });

  it("rejects an unsupported multibyte Polars delimiter before Save", async () => {
    const registered = register(exportableSnapshot("polars-session", "orders.csv", 3));
    nativeMocks.showQuickPick.mockImplementation(async (items, options) => {
      const title = (options as { title?: string } | undefined)?.title;
      if (title === "CSV Export Settings") return (items as unknown[])[1];
      if (title === "CSV Delimiter") {
        return (items as Array<{ label: string }>).find(({ label }) => label === "Custom…");
      }
      return (items as unknown[])[0];
    });
    nativeMocks.showInputBox.mockResolvedValueOnce("§");

    await expect(command("openWrangler.exportData")()).resolves.toBe(false);

    expect(nativeMocks.showSaveDialog).not.toHaveBeenCalled();
    expect(registered.exportData).not.toHaveBeenCalled();
  });

  it("does not open the Save dialog when CSV settings are cancelled", async () => {
    const registered = register(exportableSnapshot("polars-session", "orders.csv", 3));
    nativeMocks.showQuickPick
      .mockImplementationOnce(async (items) => (items as unknown[])[0])
      .mockResolvedValueOnce(undefined);

    await expect(command("openWrangler.exportData")()).resolves.toBe(false);

    expect(nativeMocks.showSaveDialog).not.toHaveBeenCalled();
    expect(registered.exportData).not.toHaveBeenCalled();
  });

  it("rejects a backend change made while CSV settings are open", async () => {
    const origin = exportableSnapshot("origin-session", "orders.csv", 3);
    const registered = register(origin);
    nativeMocks.showQuickPick.mockImplementation(async (items, options) => {
      if ((options as { title?: string } | undefined)?.title === "CSV Export Settings") {
        const replacement = exportableSnapshot("origin-session", "orders.csv", 3);
        replacement.metadata = { ...replacement.metadata, backend: "duckdb" };
        registered.setSession(replacement);
      }
      return (items as unknown[])[0];
    });

    await expect(command("openWrangler.exportData")()).resolves.toBe(false);

    expect(nativeMocks.showSaveDialog).not.toHaveBeenCalled();
    expect(registered.exportData).not.toHaveBeenCalled();
    expect(nativeMocks.showWarningMessage).toHaveBeenCalledWith(
      "The dataframe backend changed while export was open. Review the current data and try again."
    );
  });

  it("does not open the Save dialog when the explicit Pandas index choice is cancelled", async () => {
    const registered = register(
      pandasExportableSnapshot("pandas-session", "orders.csv", 3, {
        kind: "index",
        levelNames: ["account"]
      })
    );
    nativeMocks.showQuickPick
      .mockImplementationOnce(async (items) => (items as unknown[])[0])
      .mockResolvedValueOnce(undefined);

    await expect(command("openWrangler.exportData")()).resolves.toBe(false);

    expect(nativeMocks.showSaveDialog).not.toHaveBeenCalled();
    expect(registered.exportData).not.toHaveBeenCalled();
  });

  it("rejects a backend change made while the Pandas index choice is open", async () => {
    const origin = pandasExportableSnapshot("pandas-session", "orders.csv", 3, {
      kind: "index",
      levelNames: ["account"]
    });
    const registered = register(origin);
    nativeMocks.showQuickPick
      .mockImplementationOnce(async (items) => (items as unknown[])[0])
      .mockImplementationOnce(async (items) => {
        registered.setSession(exportableSnapshot("pandas-session", "orders.csv", 3));
        return (items as unknown[])[0];
      });

    await expect(command("openWrangler.exportData")()).resolves.toBe(false);

    expect(nativeMocks.showSaveDialog).not.toHaveBeenCalled();
    expect(registered.exportData).not.toHaveBeenCalled();
    expect(nativeMocks.showWarningMessage).toHaveBeenCalledWith(
      "The dataframe backend changed while export was open. Review the current data and try again."
    );
  });

  it("offers only CSV when an editable R document session advertises native export", async () => {
    const active = rDocumentSnapshot();
    active.metadata.capabilities = {
      ...active.metadata.capabilities,
      exportCsv: true,
      exportParquet: false
    };
    const registered = register(active);
    nativeMocks.showQuickPick.mockImplementation(async (items) => (items as unknown[])[0]);
    nativeMocks.showSaveDialog.mockResolvedValueOnce(vscodeUri("/workspace/orders.cleaned.csv"));

    await expect(command("openWrangler.exportData")()).resolves.toBe(true);

    expect(nativeMocks.showQuickPick).toHaveBeenCalledWith(
      [{ label: "CSV", description: "Delimited text", format: "csv" }],
      { title: "Export Cleaned Data", placeHolder: "Choose a file format" }
    );
    expect(nativeMocks.showSaveDialog).toHaveBeenCalledWith({
      title: "Export Cleaned Data",
      defaultUri: expect.objectContaining({ fsPath: "/workspace/orders.cleaned.csv" }),
      filters: { CSV: ["csv"] },
      saveLabel: "Export data"
    });
    expect(registered.exportData).toHaveBeenCalledWith("session", 0, "/workspace/orders.cleaned.csv", {
      format: "csv",
      delimiter: ",",
      quoteChar: '"',
      encoding: "utf-8",
      header: true
    });
  });

  it("offers only R-native configurable CSV settings", async () => {
    const active = rDocumentSnapshot();
    active.metadata.capabilities = {
      ...active.metadata.capabilities,
      exportCsv: true,
      exportParquet: false
    };
    const registered = register(active);
    nativeMocks.showQuickPick.mockImplementation(async (items, options) => {
      const title = (options as { title?: string } | undefined)?.title;
      if (title === "CSV Export Settings") return (items as unknown[])[1];
      if (title === "CSV Delimiter") {
        return (items as Array<{ label: string }>).find(({ label }) => label === "Custom…");
      }
      if (title === "CSV Header") return (items as unknown[])[1];
      return (items as unknown[])[0];
    });
    nativeMocks.showInputBox.mockResolvedValueOnce("§");
    nativeMocks.showSaveDialog.mockResolvedValueOnce(vscodeUri("/workspace/orders.cleaned.csv"));

    await expect(command("openWrangler.exportData")()).resolves.toBe(true);

    const settings = nativeMocks.showQuickPick.mock.calls[1]?.[0] as Array<{ label: string; description: string }>;
    expect(settings[1]).toMatchObject({
      label: "Configure CSV settings",
      description: "Choose delimiter and header; R uses UTF-8 and double quotes"
    });
    expect(nativeMocks.showInputBox).toHaveBeenCalledOnce();
    expect(nativeMocks.showInputBox).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Custom CSV Delimiter",
        prompt: "Enter exactly one character."
      })
    );
    expect(registered.exportData).toHaveBeenCalledWith("session", 0, "/workspace/orders.cleaned.csv", {
      format: "csv",
      delimiter: "§",
      quoteChar: '"',
      encoding: "utf-8",
      header: false
    });
  });

  it("rejects a session-bound export when its originating revision advances during the Save dialog", async () => {
    const origin = exportableSnapshot("origin-session", "orders.csv", 3);
    const registered = register(origin);
    nativeMocks.showQuickPick.mockImplementation(async (items) => (items as unknown[])[0]);
    nativeMocks.showSaveDialog.mockImplementationOnce(async () => {
      registered.setSession(exportableSnapshot("origin-session", "orders.csv", 4));
      return vscodeUri("/workspace/orders.cleaned.csv");
    });

    await expect(command("openWrangler.internal.exportSessionData")("origin-session", 3)).resolves.toBe(false);

    expect(registered.exportData).not.toHaveBeenCalled();
    expect(nativeMocks.showWarningMessage).toHaveBeenCalledWith(
      "The dataframe changed while export was open. Review the current data and try again."
    );
  });

  it("rechecks Workspace Trust after the cleaned-data Save dialog", async () => {
    const registered = register(exportableSnapshot("origin-session", "orders.csv", 3));
    nativeMocks.showQuickPick.mockImplementation(async (items) => (items as unknown[])[0]);
    nativeMocks.showSaveDialog.mockImplementationOnce(async () => {
      nativeMocks.workspaceTrusted = false;
      return vscodeUri("/workspace/orders.cleaned.csv");
    });

    await expect(command("openWrangler.exportData")()).resolves.toBe(false);

    expect(registered.exportData).not.toHaveBeenCalled();
    expect(nativeMocks.showWarningMessage).toHaveBeenCalledWith(
      "Trust this workspace before Open Wrangler can export cleaned data."
    );
  });

  it.each([
    { args: [] },
    { args: ["origin-session"] },
    { args: ["", 3] },
    { args: ["origin-session", -1] },
    { args: ["origin-session", 1.5] },
    { args: [{ sessionId: "origin-session" }, 3] }
  ])("rejects malformed session-bound export arguments without opening a dialog", async ({ args }) => {
    register(exportableSnapshot("origin-session", "orders.csv", 3));

    await expect(command("openWrangler.internal.exportSessionData")(...args)).resolves.toBe(false);

    expect(nativeMocks.showQuickPick).not.toHaveBeenCalled();
    expect(nativeMocks.showSaveDialog).not.toHaveBeenCalled();
  });

  it("rechecks Workspace Trust after the Save dialog before writing", async () => {
    register(noDraftSnapshot());
    nativeMocks.showSaveDialog.mockImplementationOnce(async () => {
      nativeMocks.workspaceTrusted = false;
      return vscodeUri("/workspace/clean.py");
    });
    nativeMocks.showWarningMessage.mockImplementationOnce(() => new Promise<never>(() => undefined));

    await expect(command("openWrangler.exportCode")()).resolves.toBe(false);

    expect(nativeMocks.showSaveDialog).toHaveBeenCalledOnce();
    expect(nativeMocks.showWarningMessage).toHaveBeenCalledWith(
      "Trust this workspace before Open Wrangler can export code."
    );
    expect(nativeMocks.showInformationMessage).not.toHaveBeenCalledWith(
      expect.stringContaining("Exported Open Wrangler code")
    );
  });

  it("routes a hard-link source alias returned by the public Save dialog through the source guard", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "openwrangler-native-export-"));
    const source = path.join(directory, "source.csv");
    const alias = path.join(directory, "source-alias.py");
    const contents = "value\n1\n";
    try {
      await writeFile(source, contents);
      await link(source, alias);
      register(
        snapshot({
          mode: "editing",
          steps: [appliedStep],
          source: {
            kind: "file",
            label: "source.csv",
            path: source,
            uri: "file://malformed-source-metadata"
          }
        })
      );
      nativeMocks.showSaveDialog.mockResolvedValueOnce(resourceUri("file", alias));

      await expect(command("openWrangler.exportCode")()).resolves.toBe(false);

      expect(await readFile(source, "utf8")).toBe(contents);
      expect(await readFile(alias, "utf8")).toBe(contents);
      expect((await readdir(directory)).filter((name) => name.startsWith(".openwrangler-"))).toEqual([]);
      expect(nativeMocks.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining("never overwrites the active source")
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves an exact remote source URI in the default script destination", async () => {
    register(
      snapshot({
        mode: "editing",
        steps: [appliedStep],
        source: {
          kind: "file",
          label: "sales.csv",
          path: "/workspace/data/sales.csv",
          uri: "vscode-remote://ssh-remote+example/workspace/data/sales.csv"
        }
      })
    );

    await command("openWrangler.exportCode")();

    const calls = nativeMocks.showSaveDialog.mock.calls as unknown[][];
    const options = calls[0]?.[0] as {
      defaultUri?: { scheme?: string; authority?: string; fsPath?: string };
    };
    expect(options.defaultUri).toMatchObject({
      scheme: "vscode-remote",
      authority: "ssh-remote+example",
      fsPath: "/workspace/data/sales.clean.py"
    });
  });

  it("rejects a remote source authority that differs from the active workspace host", async () => {
    register(
      snapshot({
        mode: "editing",
        steps: [appliedStep],
        source: {
          kind: "file",
          label: "sales.csv",
          path: "/workspace/data/sales.csv",
          uri: "vscode-remote://ssh-remote+stale/workspace/data/sales.csv"
        }
      })
    );
    nativeMocks.workspaceFolders.push({
      uri: resourceUri("vscode-remote", "/workspace", "ssh-remote+current")
    });
    nativeMocks.showSaveDialog.mockResolvedValueOnce(
      resourceUri("vscode-remote", "/workspace/data/sales.clean.py", "ssh-remote+current")
    );

    await expect(command("openWrangler.exportCode")()).resolves.toBe(false);

    expect(nativeMocks.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("active source no longer belongs to the current VS Code remote workspace host")
    );
  });
});
