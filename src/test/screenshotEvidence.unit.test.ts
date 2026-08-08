import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PACKAGED_FIRST_USE_ROW_COUNT,
  PACKAGED_NOTEBOOK_WORKBENCH_VIEWPORT,
  PACKAGED_OPERATION_DIALOG_VIEWPORT,
  PACKAGED_PANDAS_NOTEBOOK_OUTPUT,
  PACKAGED_PANDAS_NOTEBOOK_VIEWPORT,
  PACKAGED_PRODUCT_VIEWPORT,
  PACKAGED_SCREENSHOT_COLUMNS,
  PACKAGED_SCREENSHOT_DATA_PROVENANCE,
  PACKAGED_SCREENSHOT_FEATURED_COLUMNS,
  PACKAGED_SCREENSHOT_MARKETS,
  PACKAGED_SCREENSHOT_MINIMUM_FEATURED_WIDTHS,
  PACKAGED_SCREENSHOT_ROW_COUNT,
  PACKAGED_SCREENSHOT_SCENES,
  PACKAGED_SCREENSHOT_VIEWPORT,
  packagedScreenshotFeaturedColumnWidths,
  packagedScreenshotFileName,
  packagedViewportHeightWithoutPartialBottomRow,
  packagedFirstUseAccountNoteKind,
  packagedFirstUseFixtureCsv,
  packagedProductFixtureCsv,
  packagedScreenshotFixtureCsv,
  packagedScreenshotRow
} from "./extensionHost/screenshotEvidence";

describe("packaged editor screenshot evidence", () => {
  it("generates a realistic first-use CSV dialect for the native editor journey", () => {
    const csv = packagedFirstUseFixtureCsv();
    const lines = csv.trimEnd().split("\n");

    expect(PACKAGED_FIRST_USE_ROW_COUNT).toBe(10_000);
    expect(lines).toHaveLength(PACKAGED_FIRST_USE_ROW_COUNT + 1);
    expect(lines[0]).toBe(`\uFEFF${PACKAGED_SCREENSHOT_COLUMNS.join(";")}`);
    expect(parseDelimitedRecord(lines[1] ?? "", ";")).toEqual(packagedScreenshotRow(0));
    expect(parseDelimitedRecord(lines.at(-1) ?? "", ";")).toEqual(
      packagedScreenshotRow(PACKAGED_FIRST_USE_ROW_COUNT - 1)
    );
    expect(lines.slice(1).every((line) => parseDelimitedRecord(line, ";").length === 15)).toBe(true);
    expect(csv).toContain(
      '"Renewal review follows the Q2 pilot, with ""steady adoption"" reported across the regional account"'
    );
    const explicitEmptyIndex = Array.from({ length: PACKAGED_FIRST_USE_ROW_COUNT }, (_, index) => index).find(
      (index) => packagedFirstUseAccountNoteKind(index) === "empty"
    );
    const nullIndex = Array.from({ length: PACKAGED_FIRST_USE_ROW_COUNT }, (_, index) => index).find(
      (index) => packagedFirstUseAccountNoteKind(index) === "null"
    );
    expect(explicitEmptyIndex).toBeTypeOf("number");
    expect(nullIndex).toBeTypeOf("number");
    expect(lines[(explicitEmptyIndex ?? -1) + 1]).toMatch(/;""$/u);
    expect(lines[(nullIndex ?? -1) + 1]).toMatch(/;$/u);
    expect(csv).toContain("Zürich and São Paulo");
  });

  it("keeps final product scenes on a separate full-size automatically inferred dialect", () => {
    const csv = packagedProductFixtureCsv();
    const lines = csv.trimEnd().split("\n");

    expect(lines).toHaveLength(PACKAGED_SCREENSHOT_ROW_COUNT + 1);
    expect(lines[0]).toBe(`\uFEFF${PACKAGED_SCREENSHOT_COLUMNS.join(";")}`);
    expect(parseDelimitedRecord(lines[1] ?? "", ";")).toEqual(packagedScreenshotRow(0));
    expect(parseDelimitedRecord(lines.at(-1) ?? "", ";")).toEqual(
      packagedScreenshotRow(PACKAGED_SCREENSHOT_ROW_COUNT - 1)
    );
  });

  it("generates one deterministic, realistic business fixture without private data", () => {
    const csv = packagedScreenshotFixtureCsv();
    const lines = csv.trimEnd().split("\n");
    const rows = Array.from({ length: PACKAGED_SCREENSHOT_ROW_COUNT }, (_, index) => packagedScreenshotRow(index));
    const orderIds = rows.map((row) => row[0]);
    const markets = rows.map((row) => row[1]);
    const revenues = rows.map((row) => row[2]);
    const fulfillment = rows.map((row) => row[3]);
    const dates = rows.map((row) => row[4]);
    const units = rows.map((row) => row[8]);
    const notes = rows.map((row) => row[14]);

    expect(PACKAGED_SCREENSHOT_DATA_PROVENANCE).toContain("Deterministic synthetic");
    expect(PACKAGED_SCREENSHOT_ROW_COUNT).toBe(100_000);
    expect(PACKAGED_SCREENSHOT_COLUMNS).toHaveLength(15);
    expect(lines).toHaveLength(PACKAGED_SCREENSHOT_ROW_COUNT + 1);
    expect(lines[0]).toBe(PACKAGED_SCREENSHOT_COLUMNS.join(","));
    expect(parseCsvRecord(lines[1] ?? "")).toEqual(rows[0]);
    expect(parseCsvRecord(lines.at(-1) ?? "")).toEqual(rows.at(-1));
    expect(lines.slice(1).every((line) => parseCsvRecord(line).length === PACKAGED_SCREENSHOT_COLUMNS.length)).toBe(
      true
    );
    expect(rows.every((row) => row.length === PACKAGED_SCREENSHOT_COLUMNS.length)).toBe(true);
    expect(new Set(orderIds).size).toBe(PACKAGED_SCREENSHOT_ROW_COUNT);
    expect(new Set(markets)).toEqual(new Set(PACKAGED_SCREENSHOT_MARKETS));
    for (const market of PACKAGED_SCREENSHOT_MARKETS) {
      expect(markets.filter((value) => value === market).length).toBeGreaterThan(10_000);
    }
    expect(revenues.filter((value) => value === "").length).toBeGreaterThan(50);
    expect(new Set(revenues.filter(Boolean)).size).toBeGreaterThan(20_000);
    expect(Math.min(...revenues.filter(Boolean).map(Number))).toBeGreaterThan(50);
    expect(Math.max(...revenues.filter(Boolean).map(Number))).toBeGreaterThan(10_000);
    expect(fulfillment).toContain("true");
    expect(fulfillment).toContain("false");
    expect(fulfillment).toContain("");
    expect(units).toContain("");
    expect(units.filter(Boolean).every((value) => Number.isSafeInteger(Number(value)))).toBe(true);
    expect(dates.filter((value) => value === "").length).toBeGreaterThan(20);
    const populatedDates = dates.filter(Boolean).sort();
    expect(populatedDates[0]).toBe("2024-01-01");
    expect(populatedDates.at(-1)).toBe("2025-12-30");
    expect(notes).toContain("");
    expect(notes.some((value) => value.length > 80 && value.includes(","))).toBe(true);
    expect(notes.some((value) => value.includes('"'))).toBe(true);
    expect(notes.some((value) => value.includes("Zürich") && value.includes("São Paulo"))).toBe(true);
    expect(csv).not.toMatch(
      /(?:celonis|mmazzarelli|dropbox|@(?:gmail|celonis)|\/home\/|\\users\\|(?:sample|fixture|test)[-_ ]?(?:data|value)?)/iu
    );
    expect(createHash("sha256").update(csv).digest("hex")).toBe(
      "68da203d980c6ce56c4be5f2fc8b953ed753a86b1e12848f69f9fbb99cfb61dd"
    );
    expect(packagedScreenshotRow(0)).toEqual([
      "2400001",
      "Benelux",
      "79.00",
      "true",
      "2024-01-01",
      "Enterprise",
      "Direct",
      "Analytics",
      "1",
      "79.00",
      "0.00",
      "18.96",
      "High",
      "2024-12-31",
      'Renewal review follows the Q2 pilot, with "steady adoption" reported across the regional account'
    ]);
    expect(packagedScreenshotRow(PACKAGED_SCREENSHOT_ROW_COUNT - 1)).toEqual([
      "2500000",
      "DACH",
      "782.72",
      "true",
      "2024-05-23",
      "Public sector",
      "Online",
      "Analytics",
      "1",
      "873.18",
      "10.36",
      "377.43",
      "Standard",
      "2025-06-10",
      "Procurement requested a consolidated proposal covering support levels and implementation milestones"
    ]);
    expect(() => packagedScreenshotRow(-1)).toThrow(RangeError);
    expect(() => packagedScreenshotRow(PACKAGED_SCREENSHOT_ROW_COUNT)).toThrow(RangeError);
  });

  it("fits a complete featured prefix while retaining a realistic horizontally scrollable schema", () => {
    const gridClientWidth = 1_050;
    const rowHeaderWidth = 48;
    const widths = packagedScreenshotFeaturedColumnWidths(gridClientWidth, rowHeaderWidth);

    expect(PACKAGED_SCREENSHOT_VIEWPORT).toEqual({ width: 1_920, height: 860 });
    expect(PACKAGED_SCREENSHOT_FEATURED_COLUMNS).toEqual(PACKAGED_SCREENSHOT_COLUMNS.slice(0, 5));
    expect(PACKAGED_SCREENSHOT_COLUMNS.length).toBeGreaterThan(PACKAGED_SCREENSHOT_FEATURED_COLUMNS.length);
    expect(
      PACKAGED_SCREENSHOT_FEATURED_COLUMNS.every(
        (name) => widths[name] >= PACKAGED_SCREENSHOT_MINIMUM_FEATURED_WIDTHS[name] && widths[name] <= 640
      )
    ).toBe(true);
    expect(widths.order_date).toBeGreaterThan(Math.max(widths.order_id, widths.market, widths.fulfilled));
    expect(Object.values(widths).reduce((total, width) => total + width, 0) + rowHeaderWidth).toBe(gridClientWidth);
    const wideWidths = packagedScreenshotFeaturedColumnWidths(1_500, rowHeaderWidth);
    expect(Object.values(wideWidths).reduce((total, width) => total + width, 0) + rowHeaderWidth).toBe(1_500);
    expect(Object.values(wideWidths).every((width) => width <= 640)).toBe(true);
    expect(packagedScreenshotFeaturedColumnWidths(943, rowHeaderWidth)).toEqual(
      PACKAGED_SCREENSHOT_MINIMUM_FEATURED_WIDTHS
    );
    expect(Object.values(packagedScreenshotFeaturedColumnWidths(3_248, rowHeaderWidth))).toEqual([
      640, 640, 640, 640, 640
    ]);
    expect(() => packagedScreenshotFeaturedColumnWidths(0, rowHeaderWidth)).toThrow(TypeError);
    expect(() => packagedScreenshotFeaturedColumnWidths(942, rowHeaderWidth)).toThrow(RangeError);
    expect(() => packagedScreenshotFeaturedColumnWidths(3_249, rowHeaderWidth)).toThrow(RangeError);
  });

  it("uses a readable notebook README viewport without changing the full workbench capture", () => {
    expect(PACKAGED_SCREENSHOT_VIEWPORT).toEqual({ width: 1_920, height: 860 });
    expect(PACKAGED_NOTEBOOK_WORKBENCH_VIEWPORT).toEqual({ width: 1_440, height: 900 });
    expect(PACKAGED_PRODUCT_VIEWPORT).toEqual({ width: 1_440, height: 900 });
    expect(PACKAGED_OPERATION_DIALOG_VIEWPORT).toEqual({ width: 1_280, height: 900 });
    expect(PACKAGED_PANDAS_NOTEBOOK_VIEWPORT).toEqual({ width: 1_280, height: 700 });
    expect(PACKAGED_PANDAS_NOTEBOOK_OUTPUT).toEqual({ width: 1_280, height: 600 });
    expect(PACKAGED_PANDAS_NOTEBOOK_OUTPUT.width).toBe(PACKAGED_PANDAS_NOTEBOOK_VIEWPORT.width);
    expect(PACKAGED_PANDAS_NOTEBOOK_OUTPUT.height).toBeLessThan(PACKAGED_PANDAS_NOTEBOOK_VIEWPORT.height);
    expect(PACKAGED_PANDAS_NOTEBOOK_OUTPUT.width / PACKAGED_PANDAS_NOTEBOOK_OUTPUT.height).toBeLessThan(2.2);
  });

  it("aligns a screenshot viewport to the measured bottom-row boundary", () => {
    expect(packagedViewportHeightWithoutPartialBottomRow(900, 13.2, 28)).toBe(886);
    expect(packagedViewportHeightWithoutPartialBottomRow(886, 2, 28)).toBe(884);
    expect(() => packagedViewportHeightWithoutPartialBottomRow(0, 2, 28)).toThrow(TypeError);
    expect(() => packagedViewportHeightWithoutPartialBottomRow(900, Number.NaN, 28)).toThrow(TypeError);
    expect(() => packagedViewportHeightWithoutPartialBottomRow(900, 0, 28)).toThrow(RangeError);
    expect(() => packagedViewportHeightWithoutPartialBottomRow(900, 28, 28)).toThrow(RangeError);
    expect(() => packagedViewportHeightWithoutPartialBottomRow(1, 0.5, 28)).toThrow(RangeError);
  });

  it("keeps README scene names explicit across file and notebook workflows", () => {
    expect(PACKAGED_SCREENSHOT_SCENES).toEqual([
      "hero",
      "file-explorer-action",
      "explore",
      "high-contrast-explore",
      "filter-result",
      "workflow",
      "sidebar-overview",
      "operation-catalog",
      "operation-configuration",
      "applied-step-inspection",
      "latest-step-edited",
      "latest-step-undone",
      "notebook-pandas",
      "notebook-code-insertion",
      "notebook-variable-picker",
      "notebook-r-picker",
      "notebook-pyspark-picker",
      "notebook-polars",
      "notebook-duckdb",
      "notebook-pyspark",
      "notebook-r",
      "notebook-r-editing",
      "notebook-r-code-insertion",
      "r-quarto-variable-picker"
    ]);
    expect(packagedScreenshotFileName("vscode", "hero", "dark")).toBe("vscode-hero-dark.png");
    expect(packagedScreenshotFileName("vscode", "hero", "light")).toBe("vscode-hero-light.png");
    expect(packagedScreenshotFileName("vscode", "explore", "dark")).toBe("vscode-explore-dark.png");
    expect(packagedScreenshotFileName("vscode", "file-explorer-action", "dark")).toBe(
      "vscode-file-explorer-action-dark.png"
    );
    expect(packagedScreenshotFileName("vscode", "high-contrast-explore", "high-contrast")).toBe(
      "vscode-high-contrast-explore-high-contrast.png"
    );
    expect(packagedScreenshotFileName("vscode", "filter-result", "dark")).toBe("vscode-filter-result-dark.png");
    expect(packagedScreenshotFileName("vscode", "workflow", "dark")).toBe("vscode-workflow-dark.png");
    expect(packagedScreenshotFileName("vscode", "latest-step-edited", "dark")).toBe(
      "vscode-latest-step-edited-dark.png"
    );
    expect(packagedScreenshotFileName("vscode", "latest-step-undone", "dark")).toBe(
      "vscode-latest-step-undone-dark.png"
    );
    expect(packagedScreenshotFileName("vscode", "notebook-code-insertion", "dark")).toBe(
      "vscode-notebook-code-insertion-dark.png"
    );
    expect(packagedScreenshotFileName("vscode", "notebook-pandas", "dark")).toBe("vscode-notebook-pandas-dark.png");
    expect(packagedScreenshotFileName("vscode", "notebook-polars", "dark")).toBe("vscode-notebook-polars-dark.png");
    expect(packagedScreenshotFileName("vscode", "notebook-duckdb", "dark")).toBe("vscode-notebook-duckdb-dark.png");
    expect(packagedScreenshotFileName("vscode", "notebook-pyspark", "dark")).toBe("vscode-notebook-pyspark-dark.png");
    expect(packagedScreenshotFileName("vscode", "notebook-variable-picker", "dark")).toBe(
      "vscode-notebook-variable-picker-dark.png"
    );
    expect(packagedScreenshotFileName("vscode", "notebook-pyspark-picker", "dark")).toBe(
      "vscode-notebook-pyspark-picker-dark.png"
    );
    expect(packagedScreenshotFileName("vscode", "notebook-r-picker", "dark")).toBe("vscode-notebook-r-picker-dark.png");
    expect(packagedScreenshotFileName("vscode", "notebook-r", "dark")).toBe("vscode-notebook-r-dark.png");
    expect(packagedScreenshotFileName("vscode", "notebook-r-editing", "dark")).toBe(
      "vscode-notebook-r-editing-dark.png"
    );
    expect(packagedScreenshotFileName("vscode", "notebook-r-code-insertion", "dark")).toBe(
      "vscode-notebook-r-code-insertion-dark.png"
    );
    expect(packagedScreenshotFileName("vscode", "r-quarto-variable-picker", "dark")).toBe(
      "vscode-r-quarto-variable-picker-dark.png"
    );
    expect(() => packagedScreenshotFileName("../outside", "hero", "dark")).toThrow(TypeError);
  });

  it("captures R notebook media from the local released-Jupyter journey", () => {
    const extensionHost = readFileSync(resolve("src/test/extensionHost/index.ts"), "utf8");
    const rJourney = extensionHost.slice(
      extensionHost.indexOf("async function exerciseReleasedRJupyterExtension"),
      extensionHost.indexOf("async function assertReleasedProfileStat")
    );

    expect(rJourney).toMatch(
      /const screenshotOutput =\s+phase === "jupyter-r" && process\.platform === "linux"[\s\S]{0,120}OPEN_WRANGLER_CAPTURE_EDITOR_SCREENSHOTS/u
    );
    expect(extensionHost).toContain('source: ["# Browse an R data frame with Open Wrangler\\n", "orders_frame\\n"]');
    expect(rJourney).toContain('["orders_frame", "data.frame"]');
    expect(rJourney).toContain('["orders_tibble", "tibble"]');
    expect(rJourney).toContain('["orders_table", "data.table"]');
    expect(extensionHost).not.toContain('"base_frame <- data.frame("');
    expect(rJourney).toContain("prepareReleasedRNotebookScreenshotWorkbench(workbench, notebook, notebookEditor)");
    expect(rJourney).toContain("captureReleasedRJupyterVariablePicker(workbench, picker, screenshotOutput)");
    expect(rJourney).toContain(
      "captureReleasedRJupyterWorkbench(workbench, testing, mediaSession.sessionId, screenshotOutput)"
    );
    expect(rJourney).toContain(
      "captureReleasedRNotebookGroupByDraft(workbench, testing, mediaSession.sessionId, screenshotOutput)"
    );
    expect(extensionHost).toContain('"regional_orders <- data.frame("');
    expect(extensionHost).toContain('"  order_id = 2400000L + media_index,"');
    expect(extensionHost).toContain("\"  market = rep(c('DACH', 'Nordics', 'France', 'Iberia')");
    expect(extensionHost).toContain('"  revenue = media_revenue,"');
    expect(extensionHost).toContain(
      'packagedScreenshotFileName(process.env.OPEN_WRANGLER_TEST_EDITOR ?? "editor", "notebook-r-picker", "dark")'
    );
    expect(rJourney).toContain(
      'packagedScreenshotFileName(process.env.OPEN_WRANGLER_TEST_EDITOR ?? "editor", "notebook-r", "dark")'
    );
    expect(extensionHost).toContain(
      'packagedScreenshotFileName(process.env.OPEN_WRANGLER_TEST_EDITOR ?? "editor", "notebook-r-editing", "dark")'
    );
    expect(extensionHost).toContain('scene: "notebook-r-code-insertion"');
    expect(extensionHost).toContain('recordAcceptanceProgress("jupyter-r:screenshot:editing")');
    expect(extensionHost).toContain('recordAcceptanceProgress("jupyter-r:screenshot:quarto-picker")');
    expect(extensionHost).toContain('progress: "jupyter-r:screenshot:code-insertion"');
    expect(extensionHost).toContain("PACKAGED_NOTEBOOK_WORKBENCH_VIEWPORT");
    expect(extensionHost).toContain('recordAcceptanceProgress("jupyter-r:screenshot:variable-picker")');
    expect(rJourney).toContain('recordAcceptanceProgress("jupyter-r:screenshot:workbench")');
    expect(rJourney).toContain('selectOption("gte")');
    expect(rJourney).toContain('selectOption("equals")');
    expect(rJourney).toContain('await assertReleasedProfileStat(profile, "Min", "20,000")');
    expect(rJourney).toContain("/^priority, Priority 1 · Ascending · nulls last/u");
    expect(rJourney).toContain("/^revenue, Priority 2 · Descending · nulls last/u");
    expect(rJourney).toContain('fitReleasedRMediaColumns(testing, app, sessionId, ["order_id", "market", "revenue"])');
    expect(rJourney).toContain(
      'assertOnlyCompleteMediaColumnsVisible(app, ["order_id", "market", "revenue"], "The R notebook media scene")'
    );
    expect(rJourney).toContain("const alignedViewport = await alignPackagedSceneRowBoundary(workbench, app)");
    expect(rJourney).toContain("alignedViewport\n    );");
    expect(extensionHost).toContain("assertReleasedRPrivateNotebookContentHidden(workbench)");
  });

  it("keeps public notebook captures free of acceptance-only fixture labels", () => {
    const extensionHost = readFileSync(resolve("src/test/extensionHost/index.ts"), "utf8");
    const jupyterEnvironment = readFileSync(resolve("scripts/jupyter-acceptance-environment.mjs"), "utf8");
    const deprecatedKernelLabel = ["Open Wrangler", "Acceptance"].join(" ");
    const deprecatedVariableName = ["notebook", "showcase"].join("_");
    const pickerCapture = extensionHost.slice(
      extensionHost.indexOf("async function captureReleasedJupyterVariablePicker"),
      extensionHost.indexOf("async function assertReleasedJupyterCaptureInternalMarkerHidden")
    );

    expect(extensionHost).toContain('const RELEASED_JUPYTER_LOCAL_KERNEL_LABEL = "Python 3.12 (Open Wrangler)"');
    expect(extensionHost).toContain('"orders_df = pd.DataFrame({"');
    expect(extensionHost).toContain('"orders_preview_df = orders_df.loc[:, showcase_preview_columns].copy()"');
    expect(extensionHost).toContain('"# Explore recent orders in Open Wrangler\\n"');
    expect(extensionHost).not.toContain('"notebook.cell.collapseAllCellInputs"');
    expect(extensionHost).not.toContain('"notebook.cell.collapseAllCellOutputs"');
    expect(extensionHost).toContain('"notebook.cell.collapseCellInput"');
    expect(extensionHost).toContain('"notebook.cell.collapseCellOutput"');
    expect(extensionHost).toContain("for (const internalIndex of [0, 3, 4])");
    expect(extensionHost).toContain(
      "the private notebook cell ${internalIndex} to become visible before it is collapsed"
    );
    expect(extensionHost).toContain(
      "The public notebook showcase cell must be visible before its media journey begins."
    );
    expect(pickerCapture).toContain(
      'waitForNotebookRendererButton(workbench, "orders_preview_df", "Open in Open Wrangler")'
    );
    expect(pickerCapture).toContain('scrollIntoView({ block: "center" })');
    expect(extensionHost).toContain("assertReleasedJupyterCaptureInternalMarkerHidden(workbench)");
    expect(extensionHost).not.toContain("Public notebook screenshots must retain the readable showcase source cell.");
    expect(extensionHost).toContain('const internalMarkerVisible = await workbench.locator("body").evaluate');
    expect(extensionHost).toContain("bounds.top < page.innerHeight");
    expect(extensionHost).toContain('pageSize.value = "10"');
    expect(extensionHost).toContain("scrollerBounds.top + scroller.clientTop + scroller.clientHeight");
    expect(pickerCapture.indexOf("assertReleasedJupyterCaptureInternalMarkerHidden(workbench)")).toBeGreaterThan(0);
    expect(pickerCapture.indexOf("captureNotebookWorkbenchScreenshot(workbench, destination)")).toBeGreaterThan(
      pickerCapture.indexOf("assertReleasedJupyterCaptureInternalMarkerHidden(workbench)")
    );
    expect(jupyterEnvironment).toContain('display_name: "Python 3.12 (Open Wrangler)"');
    expect(extensionHost).not.toContain(deprecatedKernelLabel);
    expect(extensionHost).not.toContain(deprecatedVariableName);
    expect(jupyterEnvironment).not.toContain(deprecatedKernelLabel);
  });

  it("captures the real Explorer, plan-history, insertion, and high-contrast journeys", () => {
    const extensionHost = readFileSync(resolve("src/test/extensionHost/index.ts"), "utf8");
    const mediaSpec = readFileSync(resolve("docs/media-spec-v1.2.md"), "utf8");
    const testing = readFileSync(resolve("docs/testing.md"), "utf8");
    const notebookInsertion = extensionHost.slice(
      extensionHost.indexOf("async function assertReleasedNotebookCodeInsertion"),
      extensionHost.indexOf("async function captureReleasedJupyterCodeInsertion")
    );

    expect(extensionHost).toContain('packagedScreenshotFileName(editor, "file-explorer-action", "dark")');
    expect(extensionHost).toContain("await action.click();");
    expect(extensionHost).toContain('packagedScreenshotFileName(editor, "high-contrast-explore", "high-contrast")');
    expect(extensionHost).toContain("draft.params.value === 750");
    expect(extensionHost).toContain('packagedScreenshotFileName(editor, "latest-step-edited", "dark")');
    expect(extensionHost).toContain('packagedScreenshotFileName(editor, "latest-step-undone", "dark")');
    expect(extensionHost).toContain(
      'await revealPackagedProductSceneColumn(testing, workbench, sessionId, "market_upper");'
    );
    expect(extensionHost).toContain("const boundaryTolerance = 1;");
    const finalDraftHydration = extensionHost.indexOf(
      "The draft preview and final Code Preview layout must be acknowledged before the generated column is inspected."
    );
    const generatedColumnInspection = extensionHost.indexOf("const addedHeader =");
    expect(finalDraftHydration).toBeGreaterThan(0);
    expect(generatedColumnInspection).toBeGreaterThan(finalDraftHydration);
    expect(extensionHost).toContain('"notebook-code-insertion"');
    expect(extensionHost).toContain('insertionInputColumn: "units"');
    expect(extensionHost).toContain('insertionOutputColumn: "units_plus_10"');
    expect(extensionHost).toContain("RELEASED_JUPYTER_VARIABLES_PANDAS.insertionOutputColumn");
    expect(notebookInsertion).toContain("newColumn: outputColumnName");
    expect(notebookInsertion).toContain("const code = insertionActive?.code;");
    expect(notebookInsertion).not.toContain("setCodeForExport");
    expect(extensionHost).toContain('await vscode.commands.executeCommand("notebook.cell.edit");');
    expect(extensionHost).not.toContain('.filter({ hasText: "def clean_data(df):" })');
    expect(extensionHost).not.toContain(".monaco-list-row.code-cell-row");
    expect(extensionHost).toContain("editor.visibleRanges.some");
    expect(mediaSpec).toContain("### Workbench and files");
    expect(mediaSpec).toContain("Generated-code insertion is verified through the public `NotebookDocument`");
    expect(mediaSpec).not.toContain("## Remaining capture backlog");
    expect(testing).toMatch(/Private Monaco DOM structure is\s+not part of that proof\./u);
  });

  it("keeps the README to a concise portable v1.2 product story", () => {
    const readme = readFileSync(resolve("README.md"), "utf8");
    const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
      icon?: string;
      scripts?: Record<string, string>;
    };
    const buildWebviews = readFileSync(resolve("scripts/build-webviews.mjs"), "utf8");
    const icon = readFileSync(resolve("assets/icon.png"));
    const standardIcon = readFileSync(resolve("assets/icon-256.png"));
    const compactIcon = readFileSync(resolve("assets/icon-128.png"));
    const iconSvg = readFileSync(resolve("assets/icon.svg"), "utf8");
    const actionIconDarkSvg = readFileSync(resolve("assets/action-icon-dark.svg"), "utf8");
    const actionIconLightSvg = readFileSync(resolve("assets/action-icon-light.svg"), "utf8");
    const activityIconSvg = readFileSync(resolve("assets/activity-icon.svg"), "utf8");
    const viteConfig = readFileSync(resolve("vite.config.ts"), "utf8");
    const images = [
      ["explore.png", 1_440, 870, 50_000],
      ["filter-result.png", 1_440, 861, 50_000],
      ["gallery/sidebar-overview.png", 1_440, 874, 50_000],
      ["gallery/file-explorer-action.png", 1_440, 870, 50_000],
      ["gallery/file-explorer-action-detail.png", 920, 616, 20_000],
      ["gallery/column-search-wide.png", 1_440, 865, 50_000],
      ["gallery/column-search-wide-detail.png", 540, 420, 10_000],
      ["workflow.png", 1_440, 870, 50_000],
      ["gallery/histogram-hover.png", 448, 480, 20_000],
      ["gallery/sort-priority.png", 448, 480, 20_000],
      ["gallery/latest-step-edited.png", 1_440, 860, 50_000],
      ["gallery/latest-step-edited-detail.png", 448, 440, 10_000],
      ["gallery/latest-step-undone.png", 1_440, 860, 50_000],
      ["gallery/latest-step-undone-detail.png", 448, 440, 10_000],
      ["gallery/export-script.png", 1_440, 870, 50_000],
      ["gallery/export-data.png", 1_440, 870, 50_000],
      ["gallery/export-script-detail.png", 995, 230, 20_000],
      ["gallery/export-data-detail.png", 995, 344, 20_000],
      ["gallery/notebook-variable-picker.png", 1_040, 590, 50_000],
      ["gallery/notebook-variable-picker-detail.png", 602, 380, 20_000],
      ["gallery/notebook-code-insertion.png", 1_000, 288, 10_000],
      ["notebook-pandas.png", 1_210, 540, 50_000],
      ["gallery/notebook-pandas-detail.png", 698, 535, 20_000],
      ["gallery/notebook-polars.png", 1_440, 900, 50_000],
      ["gallery/notebook-polars-detail.png", 884, 675, 50_000],
      ["gallery/notebook-duckdb.png", 1_440, 900, 50_000],
      ["gallery/notebook-duckdb-detail.png", 872, 700, 50_000],
      ["gallery/notebook-pyspark.png", 1_440, 900, 50_000],
      ["gallery/notebook-pyspark-detail.png", 820, 610, 50_000]
    ] as const;

    expect(icon.readUInt32BE(16)).toBe(512);
    expect(icon.readUInt32BE(20)).toBe(512);
    expect(standardIcon.readUInt32BE(16)).toBe(256);
    expect(standardIcon.readUInt32BE(20)).toBe(256);
    expect(compactIcon.readUInt32BE(16)).toBe(128);
    expect(compactIcon.readUInt32BE(20)).toBe(128);
    expect(iconSvg).toContain('viewBox="0 0 512 512"');
    expect(iconSvg).toContain("Open Wrangler data-cell off-road vehicle");
    expect(iconSvg).not.toMatch(/<(?:script|foreignObject|image|use|filter)\b/iu);
    expect(activityIconSvg).toContain('viewBox="0 0 24 24"');
    expect(activityIconSvg).toContain("currentColor");
    expect(activityIconSvg).not.toMatch(/#[\da-f]{3,8}\b/iu);
    expect(actionIconDarkSvg).toContain('width="16" height="16" viewBox="0 0 16 16"');
    expect(actionIconLightSvg).toContain('width="16" height="16" viewBox="0 0 16 16"');
    expect(actionIconDarkSvg).toContain("#C5C5C5");
    expect(actionIconLightSvg).toContain("#424242");
    expect(actionIconDarkSvg).not.toContain("currentColor");
    expect(actionIconLightSvg).not.toContain("currentColor");
    expect(packageJson.scripts?.check).toContain("npm run brand:check");
    expect(packageJson.scripts?.["brand:render-check"]).toContain("--render-check");
    expect(packageJson.scripts?.["test:webview-acceptance"]).toBe("npm run test:webview-acceptance:run");
    expect(packageJson.scripts?.["test:webview-acceptance:run"]).toContain("npm run brand:render-check");
    expect(packageJson.icon).toBe("media/icon.png");
    expect(viteConfig).toContain('publicDir: notebookRendererBuild ? false : "assets"');
    expect(viteConfig).toContain('outDir: "media"');
    for (const asset of [
      "action-icon-dark.svg",
      "action-icon-light.svg",
      "activity-icon.svg",
      "icon.svg",
      "icon-128.png",
      "icon-256.png",
      "icon.png"
    ]) {
      expect(buildWebviews).toContain(`"${asset}"`);
    }
    expect(buildWebviews).toContain('readFileSync(resolve("assets", asset))');
    expect(buildWebviews).toContain('readFileSync(resolve("media", asset))');
    expect(buildWebviews).toContain("packaged.equals(source)");
    expect(readme).not.toMatch(/<(?:picture|source)\b/iu);
    expect(readme).toMatch(
      /<img src="https:\/\/raw\.githubusercontent\.com\/Matt17BR\/openwrangler\/[0-9a-f]{40}\/assets\/icon\.png" width="128" height="128"/u
    );
    expect(readme).not.toMatch(/<img[^>]+assets\/icon\.svg[^>]+Open Wrangler logo/iu);
    expect(readme).toContain('<h1 align="center">Open Wrangler</h1>');
    expect(readme).not.toContain("The image automatically follows your GitHub theme.");
    expect(readme).not.toMatch(/\b10,?000-row\b/iu);
    for (const [name, logicalWidth, logicalHeight, minimumBytes] of images) {
      expect(readme).toContain(name);
      const png = readFileSync(resolve("docs/images/readme/v1.2", name));
      expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(png.readUInt32BE(16)).toBe(logicalWidth * 2);
      expect(png.readUInt32BE(20)).toBe(logicalHeight * 2);
      expect(png.byteLength).toBeGreaterThan(minimumBytes);
    }
    for (const omitted of [
      "vscode-hero-light.png",
      "vscode-hero-dark.png",
      "vscode-notebook-pandas-dark.png",
      "vscode-notebook-polars-dark.png",
      "vscode-columns-dark.png",
      "vscode-columns-light.png",
      "vscode-transform-dark.png",
      "vscode-transform-light.png"
    ]) {
      expect(readme).not.toContain(omitted);
    }
    expect(readme).not.toMatch(/docs\/images\/(?:grid-view|filter-panel|wide-grid|notebook-preview)\.png/u);
    expect(readme).toContain("https://marketplace.visualstudio.com/items?itemName=Matt17BR.openwrangler");
    expect(readme).toContain("https://open-vsx.org/extension/Matt17BR/openwrangler");
    expect(readme).toContain("https://github.com/Matt17BR/openwrangler/releases");
  });
});

function parseCsvRecord(record: string): string[] {
  return parseDelimitedRecord(record, ",");
}

function parseDelimitedRecord(record: string, delimiter: string): string[] {
  const values: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < record.length; index += 1) {
    const character = record[index];
    if (character === '"') {
      if (quoted && record[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === delimiter && !quoted) {
      values.push(value);
      value = "";
    } else {
      value += character;
    }
  }
  if (quoted) throw new Error("Unterminated quoted delimited fixture field.");
  values.push(value);
  return values;
}
