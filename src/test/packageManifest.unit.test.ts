import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface CommandContribution {
  command?: string;
  title?: string;
  shortTitle?: string;
  icon?: string | { light?: string; dark?: string };
}

interface MenuContribution {
  command?: string;
  when?: string;
  group?: string;
}

interface WalkthroughStep {
  id?: string;
  title?: string;
  description?: string;
}

interface PackageManifest {
  description?: string;
  keywords?: string[];
  activationEvents?: string[];
  contributes?: {
    configuration?: {
      properties?: Record<
        string,
        {
          type?: string;
          default?: unknown;
          minimum?: number;
          maximum?: number;
          description?: string;
          items?: { enum?: string[] };
        }
      >;
    };
    configurationDefaults?: Record<string, unknown>;
    commands?: CommandContribution[];
    jupyterVariableViewers?: Array<{
      command?: string;
      dataTypes?: string[];
    }>;
    menus?: Record<string, MenuContribution[]>;
    customEditors?: Array<{
      viewType?: string;
      selector?: Array<{ filenamePattern?: string }>;
    }>;
    notebookRenderer?: Array<{
      id?: string;
      requiresMessaging?: string;
    }>;
    walkthroughs?: Array<{
      id?: string;
      title?: string;
      description?: string;
      steps?: WalkthroughStep[];
    }>;
  };
}

const manifest = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as PackageManifest;
const repositoryMetadata = JSON.parse(
  readFileSync(resolve(process.cwd(), ".github", "repository-metadata.json"), "utf8")
) as { description: string };

describe("Marketplace and walkthrough copy", () => {
  it("keeps public metadata and engine boundaries current", () => {
    expect(manifest.description).toBe(repositoryMetadata.description);
    expect(manifest.keywords).toEqual(
      expect.arrayContaining([
        "dataframe",
        "data preview",
        "data wrangling",
        "python",
        "pyspark",
        "polars",
        "pandas",
        "duckdb",
        "r",
        "rstats",
        "tidyverse",
        "data.table",
        "quarto",
        "rmarkdown",
        "vscode",
        "cursor"
      ])
    );

    const walkthrough = manifest.contributes?.walkthroughs?.find((candidate) => candidate.id === "gettingStarted");
    expect(walkthrough?.description).toContain(
      "R notebooks and trusted .R, .Rmd, and .qmd documents support the current R cleaning set."
    );
    expect(walkthrough?.description).toContain(
      "DuckDB file sessions support cleaning and export; notebook relations are experimental and view-only."
    );
    expect(walkthrough?.description).toContain(
      "Local PySpark 4.2 Classic/Connect batch DataFrames are notebook-only and view-only."
    );
    expect(walkthrough?.steps?.find((step) => step.id === "openData")?.description).toContain(
      "Use the notebook toolbar for live Python or R dataframes."
    );
    expect(walkthrough?.steps?.find((step) => step.id === "openData")?.description).toContain(
      "On macOS or Linux, run a trusted .R file or the R cells in an .Rmd/.qmd document"
    );
    expect(walkthrough?.steps?.find((step) => step.id === "export")?.description).toContain("new CSV or Parquet file");
  });
});

describe("operation command contributions", () => {
  it("contributes a generic no-argument start-operation entry point", () => {
    expect(manifest.contributes?.commands).toContainEqual(
      expect.objectContaining({
        command: "openWrangler.startOperation",
        title: "Open Wrangler: Add Cleaning Step"
      })
    );
    expect(
      manifest.contributes?.walkthroughs
        ?.flatMap((walkthrough) => walkthrough.steps ?? [])
        .some((step) => step.description?.includes("(command:openWrangler.startOperation)"))
    ).toBe(true);
  });

  it("hides edit-latest from cleaning-step context menus while plan changes are unavailable", () => {
    expect(manifest.contributes?.menus?.["view/item/context"]).toContainEqual({
      command: "openWrangler.editLatestStep",
      when: "view == openWrangler.cleaningSteps && viewItem == openWrangler.latestCleaningStep && openWrangler.canChangePlan",
      group: "inline@10"
    });
  });

  it("keeps sort-priority actions in both inline controls and the row context menu", () => {
    const sortMenus = manifest.contributes?.menus?.["view/item/context"] ?? [];
    const expected = [
      {
        command: "openWrangler.moveViewSortUp",
        when: "view == openWrangler.filters && (viewItem == openWrangler.viewSortMiddle || viewItem == openWrangler.viewSortLast)",
        groups: ["inline@10", "navigation@10"]
      },
      {
        command: "openWrangler.moveViewSortDown",
        when: "view == openWrangler.filters && (viewItem == openWrangler.viewSortFirst || viewItem == openWrangler.viewSortMiddle)",
        groups: ["inline@11", "navigation@11"]
      },
      {
        command: "openWrangler.removeViewSort",
        when: "view == openWrangler.filters && (viewItem == openWrangler.viewSortOnly || viewItem == openWrangler.viewSortFirst || viewItem == openWrangler.viewSortMiddle || viewItem == openWrangler.viewSortLast)",
        groups: ["inline@12", "navigation@12"]
      }
    ];

    for (const { command, when, groups } of expected) {
      for (const group of groups) {
        expect(sortMenus).toContainEqual({ command, when, group });
      }
    }
  });
});

describe("file launch contributions", () => {
  const resourcePredicate =
    "resourceScheme =~ /^(file|vscode-remote)$/ && resourceExtname =~ /\\.(csv|tsv|parquet|jsonl|ndjson|xlsx|xls)$/i";

  it("uses compact launch commands for supported data files and R sources", () => {
    expect(manifest.contributes?.configurationDefaults?.["cursor.general.pinnedTitleActions"]).toEqual([
      "openWrangler.openFile",
      "openWrangler.changeImportOptions",
      "openWrangler.openNotebookVariable",
      "openWrangler.runPythonCellAndOpenVariable",
      "openWrangler.openRDataframe"
    ]);
    expect(manifest.contributes?.commands).toContainEqual({
      command: "openWrangler.openFile",
      title: "Open in Open Wrangler",
      icon: {
        light: "media/action-icon-light.svg",
        dark: "media/action-icon-dark.svg"
      }
    });

    expect(manifest.contributes?.menus?.["explorer/context"]).toContainEqual({
      command: "openWrangler.openFile",
      when: `!explorerResourceIsFolder && ${resourcePredicate}`,
      group: "navigation@50"
    });
    expect(manifest.contributes?.menus?.["editor/title"]).toContainEqual({
      command: "openWrangler.openFile",
      when: `${resourcePredicate} && ` + "(!activeCustomEditorId || activeCustomEditorId != openWrangler.viewer)",
      group: "navigation@1"
    });
    expect(manifest.contributes?.menus?.["editor/title/context"]).toContainEqual({
      command: "openWrangler.openFile",
      when: `${resourcePredicate} && (!activeCustomEditorId || activeCustomEditorId != openWrangler.viewer)`,
      group: "navigation@50"
    });
    expect(manifest.contributes?.commands).toContainEqual({
      command: "openWrangler.changeImportOptions",
      title: "Open Wrangler: Change Import Options",
      shortTitle: "Change Import Options",
      icon: "$(settings-gear)"
    });
    expect(manifest.contributes?.menus?.["editor/title"]).toContainEqual({
      command: "openWrangler.changeImportOptions",
      when: "openWrangler.canChangeImportOptions && (activeWebviewPanelId == openWrangler.session || activeCustomEditorId == openWrangler.viewer)",
      group: "navigation@2"
    });
    expect(manifest.contributes?.menus?.["editor/title/context"]).toContainEqual({
      command: "openWrangler.changeImportOptions",
      when: "openWrangler.canChangeImportOptions && (activeWebviewPanelId == openWrangler.session || activeCustomEditorId == openWrangler.viewer)",
      group: "navigation@51"
    });
    expect(manifest.contributes?.menus?.commandPalette).toContainEqual({
      command: "openWrangler.launchDataViewer",
      when: "false"
    });
  });

  it("offers one stable R action and keeps the explicit document command", () => {
    const rSourcePredicate =
      "isWorkspaceTrusted && (resourceScheme == vscode-remote || isLinux || isMac) && resourceScheme =~ /^(file|vscode-remote)$/ && resourceExtname =~ /\\.([Rr]|[Rr][Mm][Dd]|[Qq][Mm][Dd])$/";
    const rTitlePredicate =
      "isWorkspaceTrusted && resourceScheme =~ /^(file|vscode-remote)$/ && resourceExtname =~ /\\.([Rr]|[Rr][Mm][Dd]|[Qq][Mm][Dd])$/";

    expect(manifest.activationEvents).toContain("onCommand:openWrangler.openRDataframe");
    expect(manifest.activationEvents).toContain("onCommand:openWrangler.runRDocument");
    expect(manifest.contributes?.commands).toContainEqual({
      command: "openWrangler.openRDataframe",
      title: "Open Wrangler: Open R Dataframe",
      shortTitle: "Open in Open Wrangler",
      category: "Open Wrangler",
      icon: {
        light: "media/action-icon-light.svg",
        dark: "media/action-icon-dark.svg"
      }
    });
    expect(manifest.contributes?.commands).toContainEqual({
      command: "openWrangler.runRDocument",
      title: "Run R Document in Open Wrangler…",
      shortTitle: "Run in Open Wrangler…",
      category: "Open Wrangler",
      icon: {
        light: "media/action-icon-light.svg",
        dark: "media/action-icon-dark.svg"
      }
    });
    expect(manifest.contributes?.menus?.["explorer/context"]).toContainEqual({
      command: "openWrangler.runRDocument",
      when: `!explorerResourceIsFolder && ${rSourcePredicate}`,
      group: "navigation@49"
    });
    expect(manifest.contributes?.menus?.["editor/title"]).toContainEqual({
      command: "openWrangler.openRDataframe",
      when: rTitlePredicate,
      group: "navigation@1"
    });
    expect(rTitlePredicate).not.toMatch(/isLinux|isMac|editorLangId|resourceLangId/u);
    expect(manifest.contributes?.menus?.["editor/title"]).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ when: expect.stringContaining("openWrangler.activeRTerminal") })
      ])
    );
    expect(manifest.contributes?.menus?.["editor/title/context"]).toContainEqual({
      command: "openWrangler.runRDocument",
      when: rSourcePredicate,
      group: "navigation@49"
    });
    expect(manifest.contributes?.menus?.commandPalette).not.toContainEqual(
      expect.objectContaining({ command: "openWrangler.runRDocument" })
    );
  });

  it("opens existing dataframes from the official R Workspace without claiming private tree nodes", () => {
    expect(manifest.activationEvents).toEqual(
      expect.arrayContaining([
        "onCommand:openWrangler.openRDataframe",
        "onCommand:openWrangler.openRInteractiveVariable",
        "onCommand:openWrangler.refreshRInteractiveVariables",
        "onCommand:openWrangler.openCachedRInteractiveVariable"
      ])
    );
    expect(manifest.contributes?.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: "openWrangler.openRInteractiveVariable",
          title: "Open Wrangler: Open Dataframe from Active R Session…",
          shortTitle: "Open in Open Wrangler"
        }),
        expect.objectContaining({
          command: "openWrangler.refreshRInteractiveVariables",
          title: "Open Wrangler: Refresh R Dataframes",
          shortTitle: "Refresh R Dataframes",
          icon: "$(refresh)"
        }),
        expect.objectContaining({
          command: "openWrangler.openCachedRInteractiveVariable",
          title: "Open Wrangler: Open R Dataframe"
        })
      ])
    );
    const allMenuEntries = Object.values(manifest.contributes?.menus ?? {}).flat();
    expect(allMenuEntries.some((entry) => entry.when?.includes("view == workspaceViewer"))).toBe(false);
    const activeRSourcePredicate =
      "isWorkspaceTrusted && rSessionActive && resourceScheme =~ /^(file|vscode-remote)$/ && resourceExtname =~ /\\.([Rr]|[Rr][Mm][Dd]|[Qq][Mm][Dd])$/";
    expect(manifest.contributes?.menus?.["editor/title"]).not.toContainEqual(
      expect.objectContaining({ command: "openWrangler.openRInteractiveVariable" })
    );
    expect(manifest.contributes?.menus?.["editor/title/context"]).toContainEqual({
      command: "openWrangler.openRInteractiveVariable",
      when: activeRSourcePredicate,
      group: "navigation@48"
    });
    expect(manifest.contributes?.menus?.commandPalette).toContainEqual({
      command: "openWrangler.openCachedRInteractiveVariable",
      when: "false"
    });
    expect(manifest.contributes?.menus?.["editor/title"]).toContainEqual({
      command: "openWrangler.openRDataframe",
      when: "isWorkspaceTrusted && resourceScheme =~ /^(file|vscode-remote)$/ && resourceExtname =~ /\\.([Rr]|[Rr][Mm][Dd]|[Qq][Mm][Dd])$/",
      group: "navigation@1"
    });
  });

  it("spells out R source casing for VS Code menu matching", () => {
    const match = /\.([Rr]|[Rr][Mm][Dd]|[Qq][Mm][Dd])$/u;
    for (const first of ["r", "R", "q", "Q"]) {
      for (const middle of ["m", "M"]) {
        for (const last of ["d", "D"]) {
          expect(match.test(`report.${first}${middle}${last}`)).toBe(true);
        }
      }
    }
    expect(match.test("analysis.R")).toBe(true);
    expect(match.test("analysis.r")).toBe(true);
    expect(match.test("analysis.r.backup")).toBe(false);
    expect(match.test("notes.md")).toBe(false);
  });

  it("keeps the supported extension predicate case-insensitive and closed to unrelated files", () => {
    const match = /\.(csv|tsv|parquet|jsonl|ndjson|xlsx|xls)$/i;
    for (const file of [
      "data.csv",
      "DATA.TSV",
      "frame.PARQUET",
      "rows.jsonl",
      "events.NDJSON",
      "book.XLSX",
      "legacy.xls"
    ]) {
      expect(match.test(file)).toBe(true);
    }
    expect(match.test("notes.txt")).toBe(false);
    expect(match.test("data.csv.backup")).toBe(false);
    expect(match.test("untrusted.pkl")).toBe(false);
    expect(match.test("untrusted.pickle")).toBe(false);
  });

  it("offers .ndjson wherever JSONL files can launch without exposing pickle", () => {
    const editor = manifest.contributes?.customEditors?.find(
      (candidate) => candidate.viewType === "openWrangler.viewer"
    );
    const patterns = editor?.selector?.map((selector) => selector.filenamePattern);
    expect(patterns).toContain("*.jsonl");
    expect(patterns).toContain("*.ndjson");
    expect(patterns).not.toContain("*.pkl");
    expect(patterns).not.toContain("*.pickle");

    const fileTypes = manifest.contributes?.configuration?.properties?.["openWrangler.enabledFileTypes"];
    expect(fileTypes?.items?.enum).toContain("jsonl");
    expect(fileTypes?.items?.enum).not.toContain("ndjson");
    expect(fileTypes?.items?.enum).not.toContain("pkl");
    expect(fileTypes?.items?.enum).not.toContain("pickle");
    expect(fileTypes?.description).toMatch(/JSONL option includes both \.jsonl and \.ndjson/u);
  });

  it("offers trusted pickle conversion as a separate local-only action", () => {
    const picklePredicate = "resourceScheme == file && resourceExtname =~ /\\.(pkl|pickle)$/i";
    expect(manifest.activationEvents).toContain("onCommand:openWrangler.convertTrustedPickle");
    expect(manifest.contributes?.commands).toContainEqual({
      command: "openWrangler.convertTrustedPickle",
      title: "Convert Trusted Pickle to Parquet…",
      category: "Open Wrangler"
    });
    expect(manifest.contributes?.menus?.["explorer/context"]).toContainEqual({
      command: "openWrangler.convertTrustedPickle",
      when: `!explorerResourceIsFolder && ${picklePredicate}`,
      group: "navigation@51"
    });
    expect(manifest.contributes?.menus?.["editor/title/context"]).toContainEqual({
      command: "openWrangler.convertTrustedPickle",
      when: picklePredicate,
      group: "navigation@51"
    });
    expect(
      manifest.contributes?.customEditors
        ?.flatMap((editor) => editor.selector ?? [])
        .map((selector) => selector.filenamePattern)
    ).not.toEqual(expect.arrayContaining(["*.pkl", "*.pickle"]));
  });
});

describe("notebook launch contributions", () => {
  const supportedNotebookContext =
    "(notebookType == 'jupyter-notebook' || notebookType == 'interactive') && isWorkspaceTrusted";

  it("keeps the notebook action discoverable without Jupyter-private context keys", () => {
    expect(manifest.activationEvents).toEqual(
      expect.arrayContaining([
        "onNotebook:jupyter-notebook",
        "onNotebook:interactive",
        "onCommand:openWrangler.openNotebookCellResult"
      ])
    );
    expect(manifest.contributes?.commands).toContainEqual({
      command: "openWrangler.openNotebookVariable",
      title: "Open in Open Wrangler",
      shortTitle: "Open in Open Wrangler",
      category: "Open Wrangler",
      icon: {
        light: "media/action-icon-light.svg",
        dark: "media/action-icon-dark.svg"
      }
    });
    expect(manifest.contributes?.commands).toContainEqual({
      command: "openWrangler.openNotebookCellResult",
      title: "Open Executed Dataframe Result in Open Wrangler",
      category: "Open Wrangler"
    });
    expect(manifest.contributes?.menus?.commandPalette).toContainEqual({
      command: "openWrangler.openNotebookCellResult",
      when: "false"
    });
    expect(manifest.contributes?.menus?.["notebook/toolbar"]).toContainEqual({
      command: "openWrangler.openNotebookVariable",
      when:
        `${supportedNotebookContext} && config.notebook.globalToolbar == true && ` +
        "!openWrangler.forceNotebookEditorTitleAction",
      group: "navigation@50"
    });
    expect(manifest.contributes?.menus?.["editor/title"]).toContainEqual({
      command: "openWrangler.openNotebookVariable",
      when: `${supportedNotebookContext} && (config.notebook.globalToolbar != true || openWrangler.forceNotebookEditorTitleAction)`,
      group: "navigation@50"
    });
    for (const menu of ["notebook/toolbar", "editor/title"]) {
      const entries = manifest.contributes?.menus?.[menu]?.filter(
        (candidate) => candidate.command === "openWrangler.openNotebookVariable"
      );
      expect(entries).toHaveLength(1);
      const entry = entries?.[0];
      expect(entry?.when).not.toContain("jupyter.ispythonnotebook");
      expect(entry?.when).not.toContain("jupyter.kernel.isjupyter");
      expect(entry?.when).not.toContain("notebookKernel");
    }
  });

  it("runs the current Python cell before opening a live dataframe and offers an explicit refresh", () => {
    const pythonCellContext =
      "editorFocus && editorLangId == python && !notebookEditorFocused && isWorkspaceTrusted && resourceExtname =~ /\\.py$/i";
    expect(manifest.activationEvents).toEqual(
      expect.arrayContaining([
        "onCommand:openWrangler.runPythonCellAndOpenVariable",
        "onCommand:openWrangler.refreshLiveDataframes",
        "onCommand:openWrangler.refreshNotebookVariables"
      ])
    );
    expect(manifest.contributes?.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: "openWrangler.runPythonCellAndOpenVariable",
          title: "Open in Open Wrangler"
        }),
        expect.objectContaining({
          command: "openWrangler.refreshLiveDataframes",
          title: "Open Wrangler: Refresh Live Dataframes",
          icon: "$(refresh)"
        }),
        expect.objectContaining({
          command: "openWrangler.refreshNotebookVariables",
          title: "Open Wrangler: Refresh Notebook Dataframes",
          icon: "$(refresh)"
        })
      ])
    );
    for (const menu of ["editor/title", "editor/title/context"]) {
      expect(manifest.contributes?.menus?.[menu]).toContainEqual(
        expect.objectContaining({
          command: "openWrangler.runPythonCellAndOpenVariable",
          when: pythonCellContext
        })
      );
      expect(manifest.contributes?.menus?.[menu]).not.toContainEqual(
        expect.objectContaining({ command: "openWrangler.openPythonInteractiveVariable" })
      );
      const entry = manifest.contributes?.menus?.[menu]?.find(
        (candidate) => candidate.command === "openWrangler.runPythonCellAndOpenVariable"
      );
      expect(entry?.when).not.toContain("jupyter.hascodecells");
    }
    expect(manifest.contributes?.menus?.["view/title"]).toContainEqual({
      command: "openWrangler.refreshLiveDataframes",
      when: "view == openWrangler.operations",
      group: "navigation@1"
    });
    expect(manifest.contributes?.menus?.commandPalette).toContainEqual({
      command: "openWrangler.refreshNotebookVariables",
      when: "false"
    });
    expect(manifest.contributes?.menus?.commandPalette).toContainEqual({
      command: "openWrangler.openCachedNotebookVariable",
      when: "false"
    });
  });

  it("selects exactly one notebook action surface for every supported toolbar state", () => {
    const actionSurfaces = (notebookType: string, globalToolbar: boolean | undefined, forceEditorTitle: boolean) => {
      const supported = notebookType === "jupyter-notebook" || notebookType === "interactive";
      return {
        notebookToolbar: supported && globalToolbar === true && !forceEditorTitle,
        editorTitle: supported && (globalToolbar !== true || forceEditorTitle)
      };
    };

    for (const notebookType of ["jupyter-notebook", "interactive"]) {
      expect(actionSurfaces(notebookType, true, false)).toEqual({
        notebookToolbar: true,
        editorTitle: false
      });
      expect(actionSurfaces(notebookType, false, false)).toEqual({
        notebookToolbar: false,
        editorTitle: true
      });
      expect(actionSurfaces(notebookType, undefined, false)).toEqual({
        notebookToolbar: false,
        editorTitle: true
      });
      expect(actionSurfaces(notebookType, true, true)).toEqual({
        notebookToolbar: false,
        editorTitle: true
      });
    }
    expect(actionSurfaces("quarto-notebook", true, false)).toEqual({
      notebookToolbar: false,
      editorTitle: false
    });
  });

  it("registers DuckDB and PySpark native values with the Jupyter Variables view", () => {
    const viewer = manifest.contributes?.jupyterVariableViewers?.find(
      (candidate) => candidate.command === "openWrangler.launchDataViewer"
    );

    expect(viewer?.dataTypes).toEqual(
      expect.arrayContaining([
        "DuckDBPyRelation",
        "_duckdb.DuckDBPyRelation",
        "duckdb.duckdb.DuckDBPyRelation",
        "pyspark.sql.dataframe.DataFrame",
        "pyspark.sql.classic.dataframe.DataFrame",
        "pyspark.sql.connect.dataframe.DataFrame"
      ])
    );
  });
});

describe("grid block configuration", () => {
  it("bounds the default horizontal fetch block", () => {
    expect(manifest.contributes?.configuration?.properties?.["openWrangler.fetchColumnBlockSize"]).toEqual(
      expect.objectContaining({
        type: "number",
        default: 16,
        minimum: 1,
        maximum: 256
      })
    );
  });
});

describe("runtime deadline configuration", () => {
  it("keeps cold session initialization separate from steady-state recovery", () => {
    expect(manifest.contributes?.configuration?.properties?.["openWrangler.sessionOpenTimeoutMs"]).toEqual(
      expect.objectContaining({
        type: "number",
        default: 60_000,
        minimum: 1_000,
        maximum: 600_000
      })
    );
    expect(manifest.contributes?.configuration?.properties?.["openWrangler.requestTimeoutMs"]).toEqual(
      expect.objectContaining({
        type: "number",
        default: 30_000,
        minimum: 1_000,
        maximum: 600_000
      })
    );
  });
});

describe("runtime dependency recovery contributions", () => {
  it("contributes and activates the explicit dependency revalidation command", () => {
    expect(manifest.activationEvents).toContain("onCommand:openWrangler.revalidateRuntimeDependencies");
    expect(manifest.contributes?.commands).toContainEqual({
      command: "openWrangler.revalidateRuntimeDependencies",
      title: "Open Wrangler: Revalidate Runtime Dependencies"
    });
  });
});

describe("notebook renderer contribution", () => {
  it("keeps static output portable while always activating desktop messaging", () => {
    expect(manifest.activationEvents).toContain("onRenderer:openWrangler.renderer");
    expect(manifest.contributes?.notebookRenderer).toContainEqual(
      expect.objectContaining({ id: "openWrangler.renderer", requiresMessaging: "optional" })
    );
    expect(manifest.contributes?.configuration?.properties).not.toHaveProperty("openWrangler.renderer.enabled");
  });
});
