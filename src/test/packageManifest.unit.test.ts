import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface CommandContribution {
  command?: string;
  title?: string;
  shortTitle?: string;
  icon?: string;
}

interface MenuContribution {
  command?: string;
  when?: string;
  group?: string;
}

interface WalkthroughStep {
  description?: string;
}

interface PackageManifest {
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
    walkthroughs?: Array<{ steps?: WalkthroughStep[] }>;
  };
}

const manifest = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as PackageManifest;

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
});

describe("file launch contributions", () => {
  const resourcePredicate =
    "resourceScheme =~ /^(file|vscode-remote)$/ && resourceExtname =~ /\\.(csv|tsv|parquet|jsonl|ndjson|xlsx|xls)$/i";

  it("uses one canonical, compact command for every file launch surface", () => {
    expect(manifest.contributes?.configurationDefaults?.["cursor.general.pinnedTitleActions"]).toEqual([
      "openWrangler.openFile",
      "openWrangler.changeImportOptions",
      "openWrangler.openNotebookVariable"
    ]);
    expect(manifest.contributes?.commands).toContainEqual({
      command: "openWrangler.openFile",
      title: "Open in Open Wrangler",
      icon: "media/activity-icon.svg"
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
    expect(fileTypes?.description).toMatch(/JSONL option includes both \.jsonl and \.ndjson/u);
  });
});

describe("notebook launch contributions", () => {
  const stableJupyterContext = "notebookType == 'jupyter-notebook' && isWorkspaceTrusted";

  it("keeps the notebook action discoverable without Jupyter-private context keys", () => {
    expect(manifest.activationEvents).toContain("onNotebook:jupyter-notebook");
    expect(manifest.contributes?.commands).toContainEqual({
      command: "openWrangler.openNotebookVariable",
      title: "Open Wrangler: Open Notebook Variable",
      shortTitle: "Open Variable",
      icon: "media/activity-icon.svg"
    });
    expect(manifest.contributes?.menus?.["notebook/toolbar"]).toContainEqual({
      command: "openWrangler.openNotebookVariable",
      when: stableJupyterContext,
      group: "navigation@50"
    });
    expect(manifest.contributes?.menus?.["editor/title"]).toContainEqual({
      command: "openWrangler.openNotebookVariable",
      when: `${stableJupyterContext} && (config.notebook.globalToolbar != true || openWrangler.forceNotebookEditorTitleAction)`,
      group: "navigation@50"
    });
    for (const menu of ["notebook/toolbar", "editor/title"]) {
      const entry = manifest.contributes?.menus?.[menu]?.find(
        (candidate) => candidate.command === "openWrangler.openNotebookVariable"
      );
      expect(entry?.when).not.toContain("jupyter.ispythonnotebook");
      expect(entry?.when).not.toContain("jupyter.kernel.isjupyter");
      expect(entry?.when).not.toContain("notebookKernel");
    }
  });

  it("registers classic and Connect PySpark DataFrames with the Jupyter Variables view", () => {
    const viewer = manifest.contributes?.jupyterVariableViewers?.find(
      (candidate) => candidate.command === "openWrangler.launchDataViewer"
    );

    expect(viewer?.dataTypes).toEqual(
      expect.arrayContaining([
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
