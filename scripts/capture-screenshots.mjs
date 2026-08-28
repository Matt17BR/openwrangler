import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pixelmatch from "pixelmatch";
import { chromium } from "playwright-core";
import { PNG } from "pngjs";
import { stringifyForInlineScript } from "./capture-screenshots-json.mjs";
import { createFilterPanelScreenshotReadiness } from "./capture-screenshots-readiness.mjs";
import { createGridColumnClipboardHarness } from "./grid-column-clipboard-harness.mjs";
import { resolveAndPreflightAcceptancePython } from "./packaged-python-preflight.mjs";
import { PUBLIC_MEDIA_PIXEL_RATIO } from "./public-media-contract.mjs";
import {
  captureWebviewScreenshot,
  createWebviewSelectorReadiness,
  preflightWebviewBrowser
} from "./webview-browser.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tmpDir = resolve(root, "tmp", "screenshots");
const actualDir = resolve(root, "tmp", "screenshots-actual");
const diffDir = resolve(root, "tmp", "screenshots-diff");
const docsDir = resolve(root, "docs", "images");
const python = resolveAndPreflightAcceptancePython({
  profile: "visual",
  repositoryRoot: root,
  environment: process.env,
  platform: process.platform
});
const verify = process.argv.includes("--verify");
const browserIsolation = Object.freeze({
  workspaceTmp: resolve(root, "tmp"),
  rootPrefix: "screenshot-browser-",
  aliasPrefix: "ow-capture-"
});
const browser = await preflightWebviewBrowser({ chromium, cwd: root, workspaceTmp: browserIsolation.workspaceTmp });
let screenshotQueue = Promise.resolve();

rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(tmpDir, { recursive: true });
mkdirSync(docsDir, { recursive: true });
if (verify) {
  rmSync(actualDir, { recursive: true, force: true });
  rmSync(diffDir, { recursive: true, force: true });
  mkdirSync(actualDir, { recursive: true });
}

const payloads = JSON.parse(
  execFileSync(
    python,
    [
      "-c",
      String.raw`
import json
import __main__
from decimal import Decimal
from pathlib import Path
import duckdb
import nbformat
from nbclient import NotebookClient
import pandas as pd
import polars as pl
from openwrangler_runtime.session import SessionManager

root = Path.cwd()
manager = SessionManager()
opened = manager.open_session(
    {"kind": "file", "label": "sample.csv", "path": str(root / "fixtures" / "sample.csv")},
    backend="polars",
    page_size=4,
)
opened["harnessSummaries"] = manager.get_summary(
    opened["metadata"]["sessionId"],
    opened["metadata"]["revision"],
    {"logic": "and", "filters": [], "sort": []},
)["summaries"]
filter_model = {
    "logic": "and",
    "filters": [
        {
            "column": "city",
            "type": "string",
            "logic": "and",
            "valueFilter": {
                "kind": "values",
                "selectedValues": ["Berlin", "Milan"],
                "includeNulls": False,
                "includeNaN": False,
                "search": "",
            },
            "predicates": [{"kind": "predicate", "operator": "contains", "value": "i"}],
        }
    ],
    "sort": [{"column": "sales", "direction": "desc", "nulls": "last"}],
}
session_id = opened["metadata"]["sessionId"]
sales_column = next(column for column in opened["metadata"]["schema"] if column["name"] == "sales")
opened["metadata"]["stats"] = manager.get_dataset_stats(session_id, 0, {"logic": "and", "filters": [], "sort": []})["stats"]
filtered_page = manager.get_page(session_id, 0, 0, 4, filter_model)
filtered_page["metadata"]["stats"] = manager.get_dataset_stats(session_id, 0, filter_model)["stats"]
filtered_summary = manager.get_summary(session_id, 0, filter_model)
values = manager.get_column_values(session_id, 0, "city", filter_model, None, 100)
draft = manager.preview_step(
    session_id,
    0,
    {
        "id": "adjusted-sales",
        "kind": "formula",
        "params": {
            "leftColumn": {"id": sales_column["id"], "name": sales_column["name"]},
            "operator": "multiply",
            "value": 1.1,
            "newColumn": "adjusted_sales",
        },
    },
    0,
    4,
)
draft["summaries"] = manager.get_summary(
    session_id,
    draft["revision"],
    {"logic": "and", "filters": [], "sort": []},
)["summaries"]
draft["metadata"]["stats"] = manager.get_dataset_stats(
    session_id,
    draft["revision"],
    {"logic": "and", "filters": [], "sort": []},
)["stats"]
applied = manager.apply_draft(session_id, draft["revision"], 0, 4)
applied["harnessSummaries"] = manager.get_summary(
    session_id,
    applied["revision"],
    {"logic": "and", "filters": [], "sort": []},
)["summaries"]
applied["metadata"]["stats"] = manager.get_dataset_stats(
    session_id,
    applied["revision"],
    {"logic": "and", "filters": [], "sort": []},
)["stats"]
inspection = manager.inspect_step(session_id, applied["revision"], "adjusted-sales", 0, 4)

example_path = root / "tmp" / "screenshots" / "by-example.csv"
example_path.write_text(
    "account_code\n"
    "DACH-DE-00482\n"
    "NORDICS-SE-01940\n"
    "IBERIA-ES-00731\n"
    "BENELUX-NL-01108\n"
    "DACH-AT-00217\n"
    "DACH-CH-00864\n"
    "NORDICS-DK-00395\n"
    "NORDICS-FI-01642\n"
    "BENELUX-BE-00576\n"
    "FRANCE-FR-01308\n",
    encoding="utf-8",
)
example_manager = SessionManager()
example_opened = example_manager.open_session(
    {"kind": "file", "label": "by-example.csv", "path": str(example_path)},
    backend="polars",
    page_size=10,
)
example_id = example_opened["metadata"]["sessionId"]
example_draft = example_manager.preview_step(
    example_id,
    0,
    {
        "id": "extract-country-code",
        "kind": "byExample",
        "params": {
            "sourceColumns": [{"id": "c:source:0", "name": "account_code"}],
            "newColumn": "country_code",
            "examples": [
                {"inputs": ["DACH-DE-00482"], "output": "DE"},
                {"inputs": ["NORDICS-SE-01940"], "output": "SE"},
            ],
        },
    },
    0,
    10,
)
example_draft["summaries"] = example_manager.get_summary(
    example_id,
    example_draft["revision"],
    {"logic": "and", "filters": [], "sort": []},
)["summaries"]
example_draft["metadata"]["stats"] = example_manager.get_dataset_stats(
    example_id,
    example_draft["revision"],
    {"logic": "and", "filters": [], "sort": []},
)["stats"]

wide_path = root / "tmp" / "screenshots" / "wide.csv"
pl.DataFrame({f"column_{column:02d}": [row + column for row in range(1000)] for column in range(40)}).write_csv(wide_path)
wide = manager.open_session(
    {"kind": "file", "label": "wide.csv", "path": str(wide_path)},
    backend="polars",
    page_size=200,
    column_offset=0,
    column_limit=16,
)
wide_id = wide["metadata"]["sessionId"]
wide["summaries"] = manager.get_summary(wide_id, 0, {"logic": "and", "filters": [], "sort": []})["summaries"]
wide_column_windows = ((0, 16), (0, 32), (16, 16), (16, 24), (32, 8), (32, 16))
wide_pages = {
    f"{offset}:200:{column_offset}:{column_limit}": manager.get_page(
        wide_id,
        0,
        offset,
        200,
        {"logic": "and", "filters": [], "sort": []},
        column_offset=column_offset,
        column_limit=column_limit,
    )["page"]
    for offset in range(0, 1000, 200)
    for column_offset, column_limit in wide_column_windows
}

empty_path = root / "tmp" / "screenshots" / "empty.csv"
empty_path.write_text("name,value\n", encoding="utf-8")
empty = manager.open_session(
    {"kind": "file", "label": "empty.csv", "path": str(empty_path)},
    backend="polars",
    page_size=20,
)
empty["harnessSummaries"] = manager.get_summary(
    empty["metadata"]["sessionId"],
    empty["metadata"]["revision"],
    {"logic": "and", "filters": [], "sort": []},
)["summaries"]

unicode_path = root / "tmp" / "screenshots" / "unicode.csv"
pl.DataFrame({
    "city 🧭": ["München", "東京", "São Paulo", "مرحبا"],
    "description": [
        "A very long value designed to verify truncation without losing the full accessible cell title " * 2,
        "combining marks: e\u0301 · emoji: 🧪📊 · CJK: 数据探索",
        "Português; naïve façade; Ελληνικά",
        "bidirectional text and punctuation (مرحبا بالعالم)",
    ],
}).write_csv(unicode_path)
unicode = manager.open_session(
    {"kind": "file", "label": "unicode 🧪.csv", "path": str(unicode_path)},
    backend="polars",
    page_size=20,
)
unicode["harnessSummaries"] = manager.get_summary(
    unicode["metadata"]["sessionId"],
    unicode["metadata"]["revision"],
    {"logic": "and", "filters": [], "sort": []},
)["summaries"]

summary_families_frame = pd.concat(
    [
        pd.Series([1.0, 2.0, 3.0, 4.0, 5.0, 6.0], name="value"),
        pd.Series(["alpha", "beta", "alpha", "gamma", "beta", "alpha"], name="value"),
        pd.Series([True, False, True, True, False, True], name="flag"),
        pd.Series(
            pd.to_datetime(
                ["2024-01-01", "2024-02-01", "2024-03-01", "2024-04-01", "2024-05-01", "2024-06-01"]
            ),
            name="when",
        ),
        pd.Series([None, "", "A", "é", "e\u0301", "😀"], dtype="string", name="account_note"),
    ],
    axis=1,
)
setattr(__main__, "openwrangler_summary_families", summary_families_frame)
summary_families = manager.open_session(
    {
        "kind": "notebookVariable",
        "label": "Summary families",
        "variableName": "openwrangler_summary_families",
    },
    backend="pandas",
    page_size=4,
    mode="viewing",
)
summary_families_id = summary_families["metadata"]["sessionId"]
summary_families["harnessSummaries"] = manager.get_summary(
    summary_families_id,
    0,
    {"logic": "and", "filters": [], "sort": []},
)["summaries"]
summary_families["metadata"]["stats"] = manager.get_dataset_stats(
    summary_families_id,
    0,
    {"logic": "and", "filters": [], "sort": []},
)["stats"]

summary_extrema_frame = pd.DataFrame(
    {
        "wide_contract_value": pd.Series(
            [
                -900719925474099312345678901,
                900719925474099312345678902,
                900719925474099312345678901,
            ],
            dtype=object,
        ),
        "precise_amount": pd.Series(
            [
                Decimal("-12345678901234567890.123456789012345678"),
                Decimal("98765432109876543210.987654321098765432"),
                Decimal("1.000000000000000001"),
            ],
            dtype=object,
        ),
    }
)
setattr(__main__, "openwrangler_summary_extrema", summary_extrema_frame)
summary_extrema = manager.open_session(
    {
        "kind": "notebookVariable",
        "label": "Exact numeric extrema",
        "variableName": "openwrangler_summary_extrema",
    },
    backend="pandas",
    page_size=3,
    mode="viewing",
)
summary_extrema_id = summary_extrema["metadata"]["sessionId"]
summary_extrema["harnessSummaries"] = manager.get_summary(
    summary_extrema_id,
    0,
    {"logic": "and", "filters": [], "sort": []},
)["summaries"]
summary_extrema["metadata"]["stats"] = manager.get_dataset_stats(
    summary_extrema_id,
    0,
    {"logic": "and", "filters": [], "sort": []},
)["stats"]

duckdb_path = root / "tmp" / "screenshots" / "regional-orders-rich.parquet"
duckdb_connection = duckdb.connect()
try:
    duckdb_connection.execute("SET TimeZone='UTC'")
    duckdb_connection.execute(
        """
        CREATE TABLE regional_orders AS
        WITH generated AS (
            SELECT
                row_id,
                (['DACH', 'Nordics', 'Benelux', 'UK & Ireland', 'France', 'Italy', 'Iberia'])[
                    1 + (row_id % 7)
                ] AS market,
                (['Active', 'Expansion', 'Renewal review', 'Pending'])[
                    1 + (row_id % 4)
                ] AS status,
                ([
                    'Alpine Systems',
                    'Northstar Labs',
                    'Atlas Retail',
                    'Meridian Works',
                    'Riviera Energy',
                    'Aster Mobility',
                    'Iberia Cloud',
                    'Baltic Horizon'
                ])[1 + (row_id % 8)] AS account_name
            FROM range(100000) AS rows(row_id)
        )
        SELECT
            CASE
                WHEN (row_id + 1) % 113 = 0 THEN NULL::DECIMAL(14, 2)
                ELSE CAST(5000 + ((row_id * 7919) % 2000000) / 100.0 AS DECIMAL(14, 2))
            END AS revenue,
            CASE
                WHEN (row_id + 1) % 127 = 0 THEN NULL::TIMESTAMPTZ
                ELSE TIMESTAMPTZ '2024-01-01 00:00:00+00:00' + row_id * INTERVAL '17 minutes'
            END AS processed_at,
            CASE row_id % 6
                WHEN 0 THEN ['renewal', 'priority']::VARCHAR[]
                WHEN 1 THEN ['new logo', 'partner']::VARCHAR[]
                WHEN 2 THEN ['enterprise']::VARCHAR[]
                WHEN 3 THEN ['self-service', 'growth']::VARCHAR[]
                WHEN 4 THEN ['strategic', 'multi-year']::VARCHAR[]
                ELSE []::VARCHAR[]
            END AS tags,
            CASE
                WHEN (row_id + 1) % 131 = 0 THEN NULL::STRUCT(label VARCHAR, score INTEGER)
                ELSE struct_pack(
                    label := account_name || ' ' || lpad(CAST(row_id + 1000 AS VARCHAR), 6, '0'),
                    score := CAST(60 + ((row_id * 7) % 40) AS INTEGER)
                )
            END AS account,
            market,
            status
        FROM generated
        """
    )
    duckdb_connection.execute("COPY regional_orders TO ? (FORMAT PARQUET)", [str(duckdb_path)])
finally:
    duckdb_connection.close()

duckdb_manager = SessionManager()
duckdb_rich = duckdb_manager.open_session(
    {"kind": "file", "label": "regional-orders-rich.parquet", "path": str(duckdb_path)},
    backend="duckdb",
    page_size=200,
    column_offset=0,
    column_limit=6,
)
duckdb_rich_id = duckdb_rich["metadata"]["sessionId"]
duckdb_rich["harnessSummaries"] = duckdb_manager.get_summary(
    duckdb_rich_id,
    0,
    {"logic": "and", "filters": [], "sort": []},
)["summaries"]
duckdb_rich["metadata"]["stats"] = duckdb_manager.get_dataset_stats(
    duckdb_rich_id,
    0,
    {"logic": "and", "filters": [], "sort": []},
)["stats"]

notebook = nbformat.read(root / "fixtures" / "example.ipynb", as_version=4)
client = NotebookClient(notebook, timeout=60, kernel_name="python3", resources={"metadata": {"path": str(root)}})
client.execute()
mime_payload = None
for cell in notebook.cells:
    for output in cell.get("outputs", []):
        data = output.get("data", {})
        if "application/vnd.openwrangler.viewer.v2+json" in data:
            mime_payload = data["application/vnd.openwrangler.viewer.v2+json"]
            break
    if mime_payload:
        break
if mime_payload is None:
    raise RuntimeError("Notebook did not emit an Open Wrangler MIME payload")

print(json.dumps({
    "opened": opened,
    "filtered": {
        "kind": "sessionOpened",
        "metadata": filtered_page["metadata"],
        "page": filtered_page["page"],
        "summaries": filtered_summary["summaries"],
        "harnessSummaries": filtered_summary["summaries"],
    },
    "values": values,
    "draft": draft,
    "applied": applied,
    "inspection": inspection,
    "exampleOpened": example_opened,
    "exampleDraft": example_draft,
    "wide": wide,
    "widePages": wide_pages,
    "empty": empty,
    "unicode": unicode,
    "summaryFamilies": summary_families,
    "summaryExtrema": summary_extrema,
    "duckdbRich": duckdb_rich,
    "notebook": mime_payload,
}))
`
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PYTHONPATH: resolve(root, "python") },
      maxBuffer: 32 * 1024 * 1024
    }
  )
);

const duplicateColumnPayload = JSON.parse(JSON.stringify(payloads.opened));
duplicateColumnPayload.metadata.schema = duplicateColumnPayload.metadata.schema.map((column, position) => ({
  ...column,
  id: `c:source:${position}`,
  name: ["value", "value", "7", ""][position]
}));
const rProfileAccessibilityPayload = structuredClone(payloads.summaryFamilies);
const rProfileRawTypes = ["double", "character", "logical", "POSIXct", "character"];
const rProfileColumnIds = rProfileAccessibilityPayload.metadata.schema.map((_, position) => `r:c:${position}`);
rProfileAccessibilityPayload.metadata = {
  ...rProfileAccessibilityPayload.metadata,
  backend: "r",
  rDataframeFlavor: "r.data.frame",
  mode: "viewing",
  source: {
    kind: "notebookVariable",
    label: "R profile accessibility",
    uri: "file:///workspace/r-profile-accessibility.ipynb",
    variableName: "r_profile_accessibility"
  },
  capabilities: {
    editable: false,
    lazy: false,
    cancel: false,
    exportCsv: false,
    exportParquet: false,
    notebookInsert: false,
    filter: false,
    sort: true,
    profile: true,
    columnValues: false
  },
  schema: rProfileAccessibilityPayload.metadata.schema.map((column, position) => ({
    ...column,
    id: rProfileColumnIds[position],
    rawType: rProfileRawTypes[position],
    nullable: true
  }))
};
rProfileAccessibilityPayload.page.columnIds = [...rProfileColumnIds];
rProfileAccessibilityPayload.page.rows = rProfileAccessibilityPayload.page.rows.map((row, index) => ({
  ...row,
  id: `r:r:${index}`,
  values: row.values.map((value, position) => {
    if (position === 0 && value.kind === "number") {
      return { ...value, display: String(value.raw) };
    }
    if (position === 2 && value.kind === "boolean") {
      return { ...value, display: value.raw ? "TRUE" : "FALSE" };
    }
    if (position === 3 && value.kind === "datetime") {
      const instant = new Date(`${value.raw}Z`);
      return {
        ...value,
        raw: String(instant.getTime() / 1000),
        display: instant.toISOString().replace(".000Z", ".000000")
      };
    }
    if (value.kind === "null") {
      return { ...value, display: "NA" };
    }
    return value;
  }),
  rowLabel: ["baseline", "candidate", "control", "follow-up"][index] ?? `row-${index + 1}`
}));
rProfileAccessibilityPayload.harnessSummaries = rProfileAccessibilityPayload.harnessSummaries.map(
  (summary, position) => {
    const next = {
      ...summary,
      columnId: rProfileColumnIds[position],
      rawType: rProfileRawTypes[position]
    };
    if (position === 2) {
      next.topValues = summary.topValues.map((entry) => ({
        ...entry,
        value: entry.value === "True" ? "TRUE" : entry.value === "False" ? "FALSE" : entry.value
      }));
    }
    if (position === 3) {
      const rDatetimeDisplay = (value) =>
        new Date(`${value.replace(" ", "T")}Z`).toISOString().replace(".000Z", ".000000");
      next.topValues = summary.topValues.map((entry) => ({ ...entry, value: rDatetimeDisplay(entry.value) }));
      if (summary.visualization?.kind === "datetime") {
        next.visualization = {
          ...summary.visualization,
          min: rDatetimeDisplay(summary.visualization.min),
          max: rDatetimeDisplay(summary.visualization.max)
        };
      }
    }
    return next;
  }
);
const terminalRangePayload = structuredClone(payloads.wide);
terminalRangePayload.metadata.shape.rows = 100_000_000;
terminalRangePayload.metadata.filteredShape.rows = 100_000_000;
terminalRangePayload.page.offset = 99_999_800;
terminalRangePayload.page.totalRows = 100_000_000;
terminalRangePayload.page.rows = terminalRangePayload.page.rows.map((row, index) => ({
  ...row,
  id: `r:${99_999_800 + index}`,
  rowNumber: 99_999_800 + index
}));
const byExampleHeaderCount = payloads.exampleDraft.page.columnIds.length;
if (byExampleHeaderCount !== 2) {
  throw new Error("The by-example preview fixture must expose exactly two projected columns.");
}
const byExamplePreviewReadiness = createWebviewSelectorReadiness({
  description: "by-example preview header profiles",
  selectors: [
    { selector: "th[data-grid-column]", count: byExampleHeaderCount },
    {
      selector: "th[data-grid-column] > .columnInsight:not(.emptyInsight)",
      count: byExampleHeaderCount
    },
    { selector: "th[data-grid-column] .emptyInsight", count: 0 }
  ],
  absentText: [{ selector: "th[data-grid-column] > .columnInsight", text: "Profiling…" }],
  emptyArrayGlobals: ["openWranglerHarnessErrors"]
});
const filterPanelReadiness = createFilterPanelScreenshotReadiness();

writeWebviewHarness("grid-view.html", payloads.opened, {}, "grid-view.png");
writeWebviewHarness(...createGridColumnClipboardHarness(payloads.opened));
writeWebviewHarness(
  "operation-dialog.html",
  payloads.opened,
  {},
  "acceptance/operation-dialog-dark-1280.png",
  {},
  { editorAction: { kind: "editorAction", action: "openOperation", operationKind: "formula" } }
);
writeWebviewHarness(
  "operation-dialog-duplicate-columns.html",
  duplicateColumnPayload,
  {},
  "acceptance/operation-dialog-duplicate-columns-dark-1280.png",
  {},
  { editorAction: { kind: "editorAction", action: "openOperation", operationKind: "formula" } }
);
writeWebviewHarness("draft-preview.html", payloads.draft, {}, "acceptance/draft-preview-dark-1280.png");
writeWebviewHarness(
  "draft-preview-dark-800.html",
  payloads.draft,
  {},
  "acceptance/draft-preview-dark-800.png",
  {},
  { width: 800 }
);
writeWebviewHarness(
  "step-inspection.html",
  payloads.applied,
  {},
  "acceptance/step-inspection-dark-1280.png",
  {},
  {
    editorAction: { kind: "editorAction", action: "selectStep", stepId: "adjusted-sales" },
    stepInspections: { "adjusted-sales:0": payloads.inspection }
  }
);
writeWebviewHarness(
  "by-example-dialog.html",
  payloads.exampleOpened,
  {},
  "acceptance/by-example-dialog-dark-1280.png",
  {},
  {
    height: 960,
    editorAction: { kind: "editorAction", action: "openOperation", operationKind: "byExample" }
  }
);
writeWebviewHarness(
  "by-example-preview.html",
  payloads.exampleDraft,
  {},
  "acceptance/by-example-preview-dark-1280.png",
  {},
  { readiness: byExamplePreviewReadiness }
);
writeWebviewHarness(
  "public-by-example-dialog.html",
  payloads.exampleOpened,
  {},
  "public-media-source/v1.2/browser/by-example-dialog.png",
  {},
  {
    height: 960,
    pixelRatio: PUBLIC_MEDIA_PIXEL_RATIO,
    editorAction: { kind: "editorAction", action: "openOperation", operationKind: "byExample" }
  }
);
writeWebviewHarness(
  "public-by-example-preview.html",
  payloads.exampleDraft,
  {},
  "public-media-source/v1.2/browser/by-example-preview.png",
  {},
  {
    pixelRatio: PUBLIC_MEDIA_PIXEL_RATIO,
    readiness: byExamplePreviewReadiness
  }
);
writeWebviewHarness(
  "by-example-preview-dark-zoom-200.html",
  payloads.exampleDraft,
  {},
  "acceptance/by-example-preview-dark-zoom-200.png",
  {},
  { zoom: 2, readiness: byExamplePreviewReadiness }
);
writeCodePreviewHarness("code-preview.html", payloads.draft.code, "acceptance/code-preview-dark-1280.png");
writeWebviewHarness(
  "filter-panel.html",
  payloads.filtered,
  { [payloads.values.column]: payloads.values },
  "filter-panel.png",
  {},
  { openColumnFilter: "city", readiness: filterPanelReadiness }
);
const truncatedNotebook = structuredClone(payloads.notebook);
const capturedNotebookRows = truncatedNotebook.page.rows.length;
const claimedNotebookRows = capturedNotebookRows + 7;
truncatedNotebook.metadata.shape.rows = claimedNotebookRows;
truncatedNotebook.metadata.filteredShape.rows = claimedNotebookRows;
truncatedNotebook.page.totalRows = claimedNotebookRows;
writeNotebookHarness("notebook-preview.html", truncatedNotebook, "notebook-preview.png");
writeWebviewHarness("wide-view.html", payloads.wide, {}, "wide-grid.png", payloads.widePages, {
  strictProjectedPages: true,
  fetchColumnBlockSize: 16
});
writeWebviewHarness("empty-state.html", payloads.empty, {}, "acceptance/empty-state-dark-1280.png");
writeWebviewHarness("unicode-state.html", payloads.unicode, {}, "acceptance/unicode-state-dark-1280.png");
writeWebviewHarness(
  "loading-state.html",
  payloads.opened,
  {},
  "acceptance/loading-state-dark-1280.png",
  {},
  { sendInitial: false }
);
writeWebviewHarness(
  "error-state.html",
  {
    kind: "error",
    code: "fixture_error",
    message: "Open Wrangler could not read this malformed fixture. Review the delimiter and encoding settings.",
    recoverable: true
  },
  {},
  "acceptance/error-state-dark-1280.png"
);
writeWebviewHarness(
  "recovery-state.html",
  payloads.opened,
  {},
  "acceptance/recovery-state-dark-1280.png",
  {},
  {
    followupMessage: {
      kind: "error",
      code: "runtime_restarted",
      message: "The Python runtime restarted. The saved plan is being replayed.",
      recoverable: true
    }
  }
);
writeWebviewHarness("grid-dark-800.html", payloads.opened, {}, "acceptance/grid-dark-800.png", {}, { width: 800 });
writeWebviewHarness(
  "grid-terminal-range-dark-320.html",
  terminalRangePayload,
  {},
  "acceptance/grid-terminal-range-dark-320.png",
  {},
  {
    width: 320,
    followupMessage: {
      kind: "viewState",
      state: {
        columnWidths: [],
        viewport: { firstVisibleRow: 99_999_800, scrollLeft: 0 }
      }
    }
  }
);
writeWebviewHarness(
  "grid-terminal-range-dark-zoom-200.html",
  terminalRangePayload,
  {},
  "acceptance/grid-terminal-range-dark-zoom-200.png",
  {},
  {
    width: 800,
    zoom: 2,
    followupMessage: {
      kind: "viewState",
      state: {
        columnWidths: [],
        viewport: { firstVisibleRow: 99_999_800, scrollLeft: 0 }
      }
    }
  }
);
writeWebviewHarness(
  "summary-families-dark-800.html",
  payloads.summaryFamilies,
  {},
  "acceptance/summary-families-dark-800.png",
  {},
  { width: 800, defaultColumnWidth: 140 }
);
writeWebviewHarness(
  "summary-families-dark-zoom-200.html",
  payloads.summaryFamilies,
  {},
  "acceptance/summary-families-dark-zoom-200.png",
  {},
  { zoom: 2, defaultColumnWidth: 140 }
);
const textSummaryColumnId = payloads.summaryFamilies.metadata.schema.find(
  (column) => column.name === "account_note"
)?.id;
if (!textSummaryColumnId) {
  throw new Error("The summary-family fixture did not expose its text column.");
}
writeWebviewHarness(
  "summary-text-dark-800.html",
  payloads.summaryFamilies,
  {},
  "acceptance/summary-text-dark-800.png",
  {},
  {
    width: 800,
    defaultColumnWidth: 140,
    openInsights: true,
    followupMessage: {
      kind: "viewState",
      state: {
        columnWidths: [],
        selectedColumnId: textSummaryColumnId,
        viewport: { firstVisibleRow: 0, scrollLeft: 0 }
      }
    }
  }
);
const exactExtremaColumnId = payloads.summaryExtrema.metadata.schema[0]?.id;
if (!exactExtremaColumnId) {
  throw new Error("The exact-extrema fixture did not expose its wide integer column.");
}
writeWebviewHarness(
  "summary-extrema-dark-800.html",
  payloads.summaryExtrema,
  {},
  "acceptance/summary-extrema-dark-800.png",
  {},
  {
    width: 800,
    defaultColumnWidth: 220,
    openInsights: true,
    followupMessage: {
      kind: "viewState",
      state: {
        columnWidths: [],
        selectedColumnId: exactExtremaColumnId,
        viewport: { firstVisibleRow: 0, scrollLeft: 0 }
      }
    }
  }
);
const maximumProtocolExtremum = "9".repeat(65_536);
const minimumProtocolExtremum = `-${"9".repeat(65_535)}`;
const protocolLimitExtremaPayload = structuredClone(payloads.summaryExtrema);
const protocolLimitSummary = protocolLimitExtremaPayload.harnessSummaries.find(
  (summary) => summary.columnId === exactExtremaColumnId
);
if (!protocolLimitSummary?.numeric) {
  throw new Error("The exact-extrema fixture did not expose its numeric summary.");
}
protocolLimitSummary.numeric.exactMin = {
  kind: "integer",
  raw: minimumProtocolExtremum,
  display: minimumProtocolExtremum,
  isNull: false,
  isNaN: false
};
protocolLimitSummary.numeric.exactMax = {
  kind: "integer",
  raw: maximumProtocolExtremum,
  display: maximumProtocolExtremum,
  isNull: false,
  isNaN: false
};
writeWebviewHarness(
  "summary-extrema-limit.html",
  protocolLimitExtremaPayload,
  {},
  "acceptance/summary-extrema-limit-unused.png",
  {},
  {
    width: 800,
    defaultColumnWidth: 220,
    openInsights: true,
    capture: false,
    followupMessage: {
      kind: "viewState",
      state: {
        columnWidths: [],
        selectedColumnId: exactExtremaColumnId,
        viewport: { firstVisibleRow: 0, scrollLeft: 0 }
      }
    }
  }
);
writeWebviewHarness(
  "r-profile-accessibility.html",
  rProfileAccessibilityPayload,
  {},
  "acceptance/r-profile-accessibility-unused.png",
  {},
  { capture: false, defaultColumnWidth: 190 }
);
writeWebviewHarness("grid-dark-1920.html", payloads.opened, {}, "acceptance/grid-dark-1920.png", {}, { width: 1920 });
writeWebviewHarness(
  "grid-light-1280.html",
  payloads.opened,
  {},
  "acceptance/grid-light-1280.png",
  {},
  { theme: "light" }
);
writeWebviewHarness(
  "grid-high-contrast-1280.html",
  payloads.opened,
  {},
  "acceptance/grid-high-contrast-1280.png",
  {},
  { theme: "highContrast" }
);
writeWebviewHarness(
  "grid-high-contrast-light-1280.html",
  payloads.opened,
  {},
  "acceptance/grid-high-contrast-light-1280.png",
  {},
  { theme: "highContrastLight" }
);
writeWebviewHarness(
  "duckdb-rich-parquet.html",
  payloads.duckdbRich,
  {},
  "public-media-source/v1.2/browser/duckdb-rich-parquet.png",
  {},
  { width: 1920, height: 640, defaultColumnWidth: 240, pixelRatio: PUBLIC_MEDIA_PIXEL_RATIO }
);
for (const zoom of [0.8, 1.5, 2]) {
  writeWebviewHarness(
    `grid-zoom-${String(zoom).replace(".", "-")}.html`,
    payloads.opened,
    {},
    `acceptance/grid-dark-zoom-${Math.round(zoom * 100)}.png`,
    {},
    { zoom }
  );
}

await screenshotQueue;

function writeWebviewHarness(fileName, sessionPayload, columnValues, outputName, suppliedPages = {}, appearance = {}) {
  const htmlPath = resolve(tmpDir, fileName);
  const outputPath = screenshotOutput(outputName);
  const mediaDir = "../../media";
  const theme = appearance.theme ?? "dark";
  const zoom = appearance.zoom ?? 1;
  const width = appearance.width ?? 1280;
  const height = appearance.height ?? 760;
  const editorAction = appearance.editorAction;
  const openInsights = appearance.openInsights === true;
  const openColumnFilter = appearance.openColumnFilter;
  const stepInspections = appearance.stepInspections ?? {};
  const fetchColumnBlockSize = appearance.fetchColumnBlockSize ?? 16;
  const fetchRowBlockSize = appearance.fetchRowBlockSize ?? 200;
  const clipboardColumnFixture = appearance.clipboardColumnFixture === true;
  const defaultColumnWidth = appearance.defaultColumnWidth ?? 190;
  const pixelRatio = appearance.pixelRatio ?? 1;
  const strictProjectedPages = appearance.strictProjectedPages === true;
  const zoomViewportStyles =
    zoom === 1
      ? ""
      : `
    body {
      height: ${100 / zoom}vh;
      overflow: hidden;
    }
    #root,
    .app {
      height: 100%;
    }`;
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Open Wrangler webview acceptance</title>
  <link rel="stylesheet" href="${mediaDir}/webview.css" />
  <style>
    ${themeTokens(theme)}
    body {
      background: var(--vscode-editor-background);
      color: var(--vscode-foreground);
      zoom: ${zoom};
    }
    ${zoomViewportStyles}
  </style>
  <script>
    const sessionPayload = ${stringifyForInlineScript(sessionPayload)};
    window.openWranglerSessionPayload = sessionPayload;
    const profileSummaries = sessionPayload.harnessSummaries ?? sessionPayload.summaries ?? [];
    const columnValues = ${stringifyForInlineScript(columnValues)};
    const pages = ${stringifyForInlineScript(suppliedPages)};
    const stepInspections = ${stringifyForInlineScript(stepInspections)};
    const strictProjectedPages = ${stringifyForInlineScript(strictProjectedPages)};
    const clipboardColumnFixture = ${stringifyForInlineScript(clipboardColumnFixture)};
    window.openWranglerMessages = [];
    window.openWranglerHarnessErrors = [];
    window.openWranglerProjectedResponses = [];
    window.openWranglerColumnBlockSize = ${stringifyForInlineScript(fetchColumnBlockSize)};
    window.acquireVsCodeApi = () => ({
      postMessage(message) {
        window.openWranglerMessages.push(message);
        if (message.kind === "ready") {
          ${appearance.sendInitial === false ? "" : 'setTimeout(() => window.dispatchEvent(new MessageEvent("message", { data: sessionPayload, origin: window.location.origin })), 20);'}
          ${editorAction ? `setTimeout(() => window.dispatchEvent(new MessageEvent("message", { data: ${stringifyForInlineScript(editorAction)}, origin: window.location.origin })), 90);` : ""}
          ${appearance.followupMessage ? `setTimeout(() => window.dispatchEvent(new MessageEvent("message", { data: ${stringifyForInlineScript(appearance.followupMessage)}, origin: window.location.origin })), 120);` : ""}
          ${
            openInsights
              ? `setTimeout(() => {
            const insights = document.querySelector('button[aria-label="Column profiles and filters"]');
            if (insights instanceof HTMLButtonElement && insights.getAttribute("aria-expanded") !== "true") {
              insights.click();
            }
          }, 180);`
              : ""
          }
          ${
            openColumnFilter
              ? `{
            let committed = false;
            const commitOpenColumnFilter = () => {
              if (committed) return;
            const header = document.querySelector(${stringifyForInlineScript(`th[data-column="${openColumnFilter}"]`)});
            const menu = header?.querySelector("details");
            const filter = [...(header?.querySelectorAll("button") ?? [])]
              .find(button => button.textContent?.trim() === "Filter…");
              if (!(menu instanceof HTMLDetailsElement) || !(filter instanceof HTMLButtonElement)) return;
              menu.open = true;
              filter.focus();
              filter.click();
              committed = true;
              observer.disconnect();
            };
            const observer = new MutationObserver(commitOpenColumnFilter);
            observer.observe(document.body, { childList: true, subtree: true });
            commitOpenColumnFilter();
          }`
              : ""
          }
        }
        if (message.kind === "runtimeRequest" && message.request.kind === "getColumnValues") {
          const value = columnValues[message.request.column];
          if (value) {
            setTimeout(() => window.dispatchEvent(new MessageEvent("message", {
              data: { ...value, viewRequestId: message.request.viewRequestId },
              origin: window.location.origin
            })), 20);
          }
        }
        if (message.kind === "runtimeRequest" && message.request.kind === "getPage") {
          const metadata = { ...sessionPayload.metadata, filterModel: message.request.filterModel };
          const request = message.request;
          const pageKey = [request.offset, request.limit, request.columnOffset, request.columnLimit].join(":");
          const page = message.purpose === "clipboardColumn" && clipboardColumnFixture
            ? clipboardColumnPage(metadata, request)
            : strictProjectedPages ? pages[pageKey] : (pages[String(request.offset)] ?? sessionPayload.page);
          if (!page) {
            window.openWranglerHarnessErrors.push(
              "No projected fixture page exists for row/column window " + pageKey + "."
            );
            return;
          }
          if (strictProjectedPages) {
            const validWindow = Number.isInteger(request.columnOffset) && request.columnOffset >= 0 &&
              Number.isInteger(request.columnLimit) && request.columnLimit >= 1 && request.columnLimit <= 256;
            const expectedColumnIds = validWindow
              ? metadata.schema
                  .slice(request.columnOffset, request.columnOffset + request.columnLimit)
                  .map((column) => column.id)
              : [];
            const exactIds = Array.isArray(page.columnIds) &&
              page.columnIds.length === expectedColumnIds.length &&
              page.columnIds.every((columnId, index) => columnId === expectedColumnIds[index]);
            const exactRows = Array.isArray(page.rows) &&
              page.rows.every((row) => Array.isArray(row.values) && row.values.length === expectedColumnIds.length);
            const exactRowWindow = page.offset === request.offset && page.limit === request.limit;
            if (!validWindow || !exactIds || !exactRows || !exactRowWindow) {
              window.openWranglerHarnessErrors.push(
                "Projected fixture page " + pageKey + " did not match its exact requested row/column window."
              );
              return;
            }
            window.openWranglerProjectedResponses.push({
              viewRequestId: request.viewRequestId,
              offset: request.offset,
              limit: request.limit,
              columnOffset: request.columnOffset,
              columnLimit: request.columnLimit,
              columnIds: [...page.columnIds],
              rowWidths: page.rows.map((row) => row.values.length)
            });
          }
          setTimeout(() => window.dispatchEvent(new MessageEvent("message", {
            data: { kind: "page", revision: metadata.revision, viewRequestId: message.request.viewRequestId, metadata, page },
            origin: window.location.origin
          })), 20);
        }
        if (message.kind === "runtimeRequest" && message.request.kind === "inspectStep") {
          const response = stepInspections[message.request.stepId + ":" + message.request.offset];
          if (response) {
            setTimeout(() => window.dispatchEvent(new MessageEvent("message", {
              data: {
                kind: "stepInspectionResult",
                stepId: message.request.stepId,
                offset: message.request.offset,
                limit: message.request.limit,
                columnOffset: message.request.columnOffset,
                columnLimit: message.request.columnLimit,
                response
              },
              origin: window.location.origin
            })), 20);
          }
        }
        if (message.kind === "runtimeRequest" && message.request.kind === "getSummary") {
          setTimeout(() => window.dispatchEvent(new MessageEvent("message", {
            data: { kind: "summary", revision: sessionPayload.metadata.revision, viewRequestId: message.request.viewRequestId, summaries: profileSummaries.filter(summary => message.request.columnIds?.includes(summary.columnId)) },
            origin: window.location.origin
          })), 20);
        }
        if (message.kind === "runtimeRequest" && message.request.kind === "getDatasetStats") {
          setTimeout(() => window.dispatchEvent(new MessageEvent("message", {
            data: { kind: "datasetStats", revision: sessionPayload.metadata.revision, viewRequestId: message.request.viewRequestId, stats: sessionPayload.metadata.stats },
            origin: window.location.origin
          })), 20);
        }
      },
      getState() { return undefined; },
      setState() {}
    });
    function clipboardColumnPage(metadata, request) {
      const rows = Array.from({ length: Math.min(request.limit, 64 - request.offset) }, (_, index) => {
        const rowNumber = request.offset + index;
        const column = request.columnOffset;
        let value;
        if (column === 0) {
          const display = rowNumber === 0
            ? " \\u0000=SUM(A1:A2)"
            : rowNumber === 1
              ? "\\t\\uFEFF@IMPORT()"
              : rowNumber === 2
                ? 'contains\\t"quote"'
                : "value-" + String(rowNumber + 1);
          value = { kind: "string", display, isNull: false, isNaN: false };
        } else if (column === 1) {
          const display = String(-(rowNumber + 1));
          value = { kind: "integer", raw: display, display, isNull: false, isNaN: false };
        } else {
          const headerAdjustment = rowNumber === 0 ? -9 : 0;
          const extra = column === 2
            ? 0
            : (rowNumber >= 62 ? 1 : 0);
          value = {
            kind: "string",
            display: "x".repeat(65_535 + headerAdjustment + extra),
            isNull: false,
            isNaN: false
          };
        }
        return { id: "r:clipboard-column:" + String(rowNumber), rowNumber, values: [value] };
      });
      return {
        offset: request.offset,
        limit: request.limit,
        totalRows: 64,
        columnIds: [metadata.schema[request.columnOffset].id],
        rows
      };
    }
  </script>
</head>
<body data-fetch-block-size="${fetchRowBlockSize}" data-fetch-column-block-size="${fetchColumnBlockSize}" data-default-column-width="${defaultColumnWidth}" data-insights-on-open="true" data-filter-mode="advanced">
  <div id="root"></div>
  <script type="module" src="${mediaDir}/webview.js"></script>
</body>
</html>`;
  writeFileSync(htmlPath, html);
  if (appearance.capture !== false) {
    screenshot(htmlPath, outputPath, width, height, pixelRatio, { readiness: appearance.readiness });
  }
}

function writeNotebookHarness(fileName, payload, outputName) {
  const htmlPath = resolve(tmpDir, fileName);
  const outputPath = screenshotOutput(outputName);
  const rendererUrl = "../../media/notebookRenderer.js";
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Open Wrangler notebook renderer acceptance</title>
  <style>
    :root {
      --vscode-panel-border: #3c3c3c;
      color: #d4d4d4;
      background: #1e1e1e;
      font-family: "Liberation Sans", Arial, sans-serif;
    }
    body { margin: 0; padding: 32px; background: #1e1e1e; }
    .notebook-shell { border: 1px solid #3c3c3c; border-radius: 10px; overflow: hidden; background: #202020; }
    .cell { padding: 18px 22px; border-bottom: 1px solid #3c3c3c; font-family: "Liberation Mono", monospace; white-space: pre; color: #d4d4d4; }
    .openwrangler-notebook header { padding: 14px 18px; background: #252526; font-weight: 700; }
    .openwrangler-notebook table { background: #202020; }
    .openwrangler-notebook th { background: #2d2d30; }
  </style>
</head>
<body>
  <div class="notebook-shell">
    <div class="cell">from pathlib import Path

import polars as pl
from openwrangler_runtime.notebook import show

candidates = (Path("fixtures/sample.csv"), Path("sample.csv"))
csv_path = next((path for path in candidates if path.exists()), None)
if csv_path is None:
    raise FileNotFoundError("Could not find sample.csv from the repo root or fixtures directory.")

df = pl.read_csv(csv_path)
show(df, label="sample.csv")</div>
    <div id="notebook-output"></div>
  </div>
  <script type="module">
    import { activate } from "${rendererUrl}";
    window.openWranglerNotebookMessages = [];
    const renderer = activate({
      postMessage(message) { window.openWranglerNotebookMessages.push(message); }
    });
    renderer.renderOutputItem({ json: () => (${stringifyForInlineScript(payload)}) }, document.getElementById("notebook-output"));
  </script>
</body>
</html>`;
  writeFileSync(htmlPath, html);
  screenshot(htmlPath, outputPath);
}

function writeCodePreviewHarness(fileName, code, outputName) {
  const htmlPath = resolve(tmpDir, fileName);
  const outputPath = screenshotOutput(outputName);
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Open Wrangler code preview acceptance</title>
  <style>
    ${themeTokens("dark")}
    html, body, #root { height: 100%; margin: 0; overflow: hidden; background: var(--vscode-editor-background); }
  </style>
  <script>
    window.acquireVsCodeApi = () => ({
      postMessage(message) {
        if (message.kind === "ready") {
          setTimeout(() => window.dispatchEvent(new MessageEvent("message", {
            data: {
              kind: "codePreview",
              code: ${stringifyForInlineScript(code)},
              editable: true,
              runtimeIdentity: {
                runtimeLanguage: "python",
                dataframeFlavor: "polars",
                codeDialect: "python.polars"
              }
            },
            origin: window.location.origin
          })), 20);
        }
      }
    });
  </script>
</head>
<body>
  <div id="root"></div>
  <script src="../../media/codePreview.js"></script>
</body>
</html>`;
  writeFileSync(htmlPath, html);
  screenshot(htmlPath, outputPath, 1280, 420);
}

function screenshot(htmlPath, outputPath, width = 1280, height = 760, pixelRatio = 1, { readiness } = {}) {
  if (!Number.isSafeInteger(pixelRatio) || (pixelRatio !== 1 && pixelRatio !== PUBLIC_MEDIA_PIXEL_RATIO)) {
    throw new TypeError("A browser screenshot pixel ratio must be ordinary 1x or the shared public-media ratio.");
  }
  mkdirSync(dirname(outputPath), { recursive: true });
  screenshotQueue = screenshotQueue.then(async () => {
    try {
      await captureWebviewScreenshot({
        chromium,
        browser,
        isolation: browserIsolation,
        label: "capture",
        url: pathToFileURL(htmlPath).href,
        outputPath,
        width,
        height,
        pixelRatio,
        virtualTime: 2500,
        readiness
      });
    } catch (error) {
      throw new Error(`Chrome screenshot failed for ${htmlPath}.`, { cause: error });
    }
    const portable = addSrgbChunk(readFileSync(outputPath));
    const image = PNG.sync.read(portable);
    if (image.width !== width * pixelRatio || image.height !== height * pixelRatio) {
      throw new Error(
        `Chrome screenshot produced ${image.width}x${image.height}; expected ${width * pixelRatio}x${height * pixelRatio}.`
      );
    }
    writeFileSync(outputPath, portable);
    const size = portable.byteLength;
    console.log(`Captured ${outputPath} (${size} bytes)`);
    if (verify) compareScreenshot(outputPath);
  });
}

function screenshotOutput(outputName) {
  return resolve(verify ? actualDir : docsDir, outputName);
}

function compareScreenshot(actualPath) {
  const relativePath = relative(actualDir, actualPath);
  const baselinePath = resolve(docsDir, relativePath);
  const baseline = PNG.sync.read(readFileSync(baselinePath));
  const actual = PNG.sync.read(readFileSync(actualPath));
  if (baseline.width !== actual.width || baseline.height !== actual.height) {
    throw new Error(
      `Visual regression for ${relativePath}: expected ${baseline.width}x${baseline.height}, received ${actual.width}x${actual.height}.`
    );
  }
  const diff = new PNG({ width: actual.width, height: actual.height });
  const changed = pixelmatch(baseline.data, actual.data, diff.data, actual.width, actual.height, {
    threshold: 0.2,
    includeAA: false
  });
  const ratio = changed / (actual.width * actual.height);
  if (ratio > 0.01) {
    const diffPath = resolve(diffDir, relativePath);
    mkdirSync(dirname(diffPath), { recursive: true });
    writeFileSync(diffPath, PNG.sync.write(diff));
    throw new Error(
      `Visual regression for ${relativePath}: ${(ratio * 100).toFixed(2)}% of pixels changed (limit 1.00%). Diff: ${diffPath}`
    );
  }
  console.log(`Verified ${relativePath} (${(ratio * 100).toFixed(3)}% changed).`);
}

function addSrgbChunk(png) {
  const chunks = pngChunkTypes(png);
  if (chunks.includes("sRGB")) return png;
  if (chunks[0] !== "IHDR") throw new Error("Screenshot media must start with a PNG IHDR chunk.");
  const ihdrLength = png.readUInt32BE(8);
  const insertOffset = 8 + 12 + ihdrLength;
  const type = Buffer.from("sRGB", "ascii");
  const data = Buffer.from([0]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
  const chunk = Buffer.concat([length, type, data, crc]);
  return Buffer.concat([png.subarray(0, insertOffset), chunk, png.subarray(insertOffset)]);
}

function pngChunkTypes(png) {
  if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error("Screenshot media must be a PNG file.");
  }
  const types = [];
  let offset = 8;
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    types.push(type);
    offset += length + 12;
    if (type === "IEND") break;
  }
  if (types.at(-1) !== "IEND" || offset !== png.length) {
    throw new Error("Screenshot media contains a malformed PNG chunk sequence.");
  }
  return types;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function themeTokens(theme) {
  const palettes = {
    dark: {
      foreground: "#d4d4d4",
      description: "#a8a8a8",
      editor: "#1e1e1e",
      header: "#252526",
      sidebar: "#181818",
      border: "#3c3c3c",
      input: "#313131",
      inputForeground: "#f0f0f0",
      button: "#0e639c",
      buttonForeground: "#ffffff",
      badge: "#4d4d4d",
      badgeForeground: "#ffffff",
      focus: "#007fd4",
      scrollbar: "#79797966",
      scrollbarHover: "#646464b3",
      scrollbarActive: "#bfbfbf66",
      selection: "#04395e",
      selectionForeground: "#ffffff"
    },
    light: {
      foreground: "#333333",
      description: "#616161",
      editor: "#ffffff",
      header: "#f3f3f3",
      sidebar: "#f8f8f8",
      border: "#d4d4d4",
      input: "#ffffff",
      inputForeground: "#333333",
      button: "#007acc",
      buttonForeground: "#ffffff",
      badge: "#c4c4c4",
      badgeForeground: "#333333",
      focus: "#0090f1",
      scrollbar: "#64646466",
      scrollbarHover: "#646464b3",
      scrollbarActive: "#00000099",
      selection: "#0060c0",
      selectionForeground: "#ffffff"
    },
    highContrast: {
      foreground: "#ffffff",
      description: "#ffffff",
      editor: "#000000",
      header: "#000000",
      sidebar: "#000000",
      border: "#ffffff",
      input: "#000000",
      inputForeground: "#ffffff",
      button: "#000000",
      buttonForeground: "#ffffff",
      badge: "#000000",
      badgeForeground: "#ffffff",
      focus: "#ffff00",
      scrollbar: "#ffffff99",
      scrollbarHover: "#ffffffcc",
      scrollbarActive: "#ffffff",
      selection: "#000000",
      selectionForeground: "#ffffff"
    },
    highContrastLight: {
      foreground: "#000000",
      description: "#000000",
      editor: "#ffffff",
      header: "#ffffff",
      sidebar: "#ffffff",
      border: "#000000",
      input: "#ffffff",
      inputForeground: "#000000",
      button: "#ffffff",
      buttonForeground: "#000000",
      badge: "#ffffff",
      badgeForeground: "#000000",
      focus: "#0f4a85",
      scrollbar: "#00000099",
      scrollbarHover: "#000000cc",
      scrollbarActive: "#000000",
      selection: "#ffffff",
      selectionForeground: "#000000"
    }
  };
  const palette = palettes[theme] ?? palettes.dark;
  return `:root {
    --vscode-foreground: ${palette.foreground};
    --vscode-descriptionForeground: ${palette.description};
    --vscode-editor-background: ${palette.editor};
    --vscode-editorGroupHeader-tabsBackground: ${palette.header};
    --vscode-sideBar-background: ${palette.sidebar};
    --vscode-panel-border: ${palette.border};
    --vscode-input-background: ${palette.input};
    --vscode-input-foreground: ${palette.inputForeground};
    --vscode-button-background: ${palette.button};
    --vscode-button-foreground: ${palette.buttonForeground};
    --vscode-badge-background: ${palette.badge};
    --vscode-badge-foreground: ${palette.badgeForeground};
    --vscode-focusBorder: ${palette.focus};
    --vscode-scrollbarSlider-background: ${palette.scrollbar};
    --vscode-scrollbarSlider-hoverBackground: ${palette.scrollbarHover};
    --vscode-scrollbarSlider-activeBackground: ${palette.scrollbarActive};
    --vscode-list-activeSelectionBackground: ${palette.selection};
    --vscode-list-activeSelectionForeground: ${palette.selectionForeground};
    --vscode-notifications-background: ${palette.header};
    --vscode-notifications-border: ${palette.border};
    --vscode-font-family: "Liberation Sans", Arial, sans-serif;
    --vscode-editor-font-family: "Liberation Mono", monospace;
    font-kerning: none;
    font-optical-sizing: none;
    font-variant-ligatures: none;
    font-synthesis: none;
  }`;
}
