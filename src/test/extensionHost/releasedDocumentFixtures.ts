import * as assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { R_KERNEL_RUNTIME_BINDING } from "../../extension/r/rKernelRuntimeBundle";
import { RELEASED_NOTEBOOK_R_SETUP_FAILURE_PREFIX } from "./releasedNotebookFailure";

export const RELEASED_JUPYTER_R_KERNEL_RESULT = "__OW_RELEASED_R_KERNEL__";
export const RELEASED_JUPYTER_R_SETUP_RESULT = "__OW_RELEASED_R_SETUP__";
export const RELEASED_JUPYTER_R_BINDING_RESULT = "__OW_RELEASED_R_BINDING__";
export const RELEASED_JUPYTER_R_MEDIA_RESULT = "__OW_RELEASED_R_MEDIA__";

export interface ReleasedRDocumentFixture {
  readonly sourceUri: vscode.Uri;
  readonly decoyUri: vscode.Uri;
  readonly processIdPath: string;
  readonly immutableFiles: ReadonlyArray<Readonly<{ path: string; bytes: Buffer }>>;
}

export interface ReleasedRLiterateDocumentFixture {
  readonly kind: "rmarkdown" | "quarto";
  readonly sourceUri: vscode.Uri;
  readonly processIdPath?: string;
  readonly variableName: string;
  readonly immutableFiles: ReadonlyArray<Readonly<{ path: string; bytes: Buffer }>>;
}

export interface ReleasedPythonQuartoDocumentFixture {
  readonly sourceUri: vscode.Uri;
  readonly variableName: string;
  readonly sentinelName: string;
  readonly immutableFiles: ReadonlyArray<Readonly<{ path: string; bytes: Buffer }>>;
}

export function writeReleasedRDocumentFixture(directory: string): ReleasedRDocumentFixture {
  const fixtureDirectory = path.join(directory, "plain-r");
  mkdirSync(fixtureDirectory, { recursive: true });
  const sourcePath = path.join(fixtureDirectory, "orders-analysis.R");
  const decoyPath = path.join(fixtureDirectory, "decoy.R");
  const helperPath = path.join(fixtureDirectory, "helpers.R");
  const csvPath = path.join(fixtureDirectory, "orders.csv");
  const processIdPath = path.join(fixtureDirectory, "open-wrangler-r.pid");
  const sourceBytes = Buffer.from(
    [
      'source("helpers.R", local = TRUE)',
      'orders_frame <- prepare_orders(utils::read.csv("orders.csv", check.names = FALSE, stringsAsFactors = FALSE))',
      'orders_tibble <- tibble::as_tibble(orders_frame, .name_repair = "minimal")',
      "orders_table <- data.table::as.data.table(orders_frame)",
      "data.table::setkey(orders_table, row_id)",
      'writeLines(as.character(Sys.getpid()), "open-wrangler-r.pid", useBytes = TRUE)',
      ""
    ].join("\n"),
    "utf8"
  );
  const helperBytes = Buffer.from(
    [
      "prepare_orders <- function(frame) {",
      '  stopifnot(identical(names(frame), c("row_id", "group", "score", "label")))',
      "  frame$score <- as.numeric(frame$score)",
      "  frame$label <- as.character(frame$label)",
      "  frame",
      "}",
      ""
    ].join("\n"),
    "utf8"
  );
  const csvBytes = Buffer.from(
    [
      "row_id,group,score,label",
      ...Array.from({ length: 240 }, (_, index) => {
        const row = index + 1;
        return `${row},${row % 2 === 0 ? "B" : "A"},${row},order-${String(row).padStart(3, "0")}`;
      }),
      ""
    ].join("\n"),
    "utf8"
  );
  const decoyBytes = Buffer.from('decoy_frame <- data.frame(value = "do not edit")\n', "utf8");
  for (const [file, bytes] of [
    [sourcePath, sourceBytes],
    [decoyPath, decoyBytes],
    [helperPath, helperBytes],
    [csvPath, csvBytes]
  ] as const) {
    writeFileSync(file, bytes);
  }
  return {
    sourceUri: vscode.Uri.file(sourcePath),
    decoyUri: vscode.Uri.file(decoyPath),
    processIdPath,
    immutableFiles: [
      { path: sourcePath, bytes: sourceBytes },
      { path: decoyPath, bytes: decoyBytes },
      { path: helperPath, bytes: helperBytes },
      { path: csvPath, bytes: csvBytes }
    ]
  };
}

export function releasedRDocumentCleanedCsv(): Buffer {
  return Buffer.from(
    [
      '"record_id","group","score","label"',
      ...Array.from({ length: 240 }, (_, index) => {
        const row = index + 1;
        const group = row % 2 === 0 ? "B" : "A";
        return `${row},"${group}",${row},"order-${String(row).padStart(3, "0")}"`;
      }),
      ""
    ].join("\n"),
    "utf8"
  );
}

export function writeReleasedRLiterateDocumentFixture(
  directory: string,
  kind: "rmarkdown" | "quarto"
): ReleasedRLiterateDocumentFixture {
  const extension = kind === "quarto" ? "qmd" : "Rmd";
  const fixtureDirectory = path.join(directory, kind);
  mkdirSync(fixtureDirectory, { recursive: true });
  const sourcePath = path.join(fixtureDirectory, `orders-analysis.${extension}`);
  const csvPath = path.join(fixtureDirectory, "orders.csv");
  const processIdPath = path.join(fixtureDirectory, "open-wrangler-r.pid");
  const variableName = kind === "quarto" ? "regional_orders" : "literate_orders";
  const loadCell = [
    kind === "quarto" ? "```{r}" : "```{r load-orders, echo=FALSE}",
    ...(kind === "quarto" ? ["#| label: load-regional-orders", "#| echo: false"] : []),
    `${variableName} <- utils::read.csv("orders.csv", check.names = FALSE, stringsAsFactors = FALSE)`,
    `${variableName}$order_date <- as.Date(${variableName}$order_date)`,
    `${variableName}$score[2L] <- NA_real_`,
    ...(kind === "rmarkdown" ? ['writeLines(as.character(Sys.getpid()), "open-wrangler-r.pid", useBytes = TRUE)'] : []),
    "```",
    ""
  ];
  const sourceLines =
    kind === "quarto"
      ? [
          "---",
          "title: Regional orders",
          "format:",
          "  html:",
          "    toc: true",
          "    df-print: kable",
          "---",
          "",
          "# Regional orders",
          "",
          "Load the latest regional order export and inspect it in Open Wrangler.",
          "",
          ...loadCell,
          "## Recent orders",
          "",
          "```{r}",
          "#| label: regional-orders-preview",
          "#| echo: false",
          'knitr::kable(utils::head(regional_orders, 8L), caption = "Regional orders preview")',
          "```",
          ""
        ]
      : [
          "---",
          "title: Regional orders",
          "output: html_document",
          "payload: |",
          "  ```{r}",
          "  stop('A YAML block scalar is not an executable cell')",
          "  ```",
          "---",
          "",
          "# Regional orders",
          "",
          "This prose contains `data.frame(id = 0L)` but is not R code.",
          "",
          ...loadCell,
          "## Recent orders",
          "",
          "```{r orders-preview, echo=FALSE}",
          'knitr::kable(utils::head(literate_orders, 8L), caption = "Regional orders preview")',
          "```",
          "",
          "<!--",
          "```{r}",
          "stop('An HTML comment is not an executable cell')",
          "```",
          "-->",
          "",
          "```{python, eval=FALSE}",
          "raise RuntimeError('A Python cell must not run in the R document process')",
          "```",
          "",
          "```{r disabled, eval=FALSE}",
          "stop('A disabled R cell must not run')",
          "```",
          ""
        ];
  const sourceBytes = Buffer.from(sourceLines.join("\n"), "utf8");
  const csvBytes = Buffer.from(
    [
      "order_id,market,score,order_date",
      ...Array.from({ length: 60 }, (_, index) => {
        const row = index + 1;
        const market = ["DACH", "Nordics", "France", "Iberia"][index % 4];
        const date = `2026-01-${String((index % 28) + 1).padStart(2, "0")}`;
        return `${2400000 + row},${market},${(row * 1.25).toFixed(2)},${date}`;
      }),
      ""
    ].join("\n"),
    "utf8"
  );
  writeFileSync(sourcePath, sourceBytes);
  writeFileSync(csvPath, csvBytes);
  return {
    kind,
    sourceUri: vscode.Uri.file(sourcePath),
    ...(kind === "rmarkdown" ? { processIdPath } : {}),
    variableName,
    immutableFiles: [
      { path: sourcePath, bytes: sourceBytes },
      { path: csvPath, bytes: csvBytes }
    ]
  };
}

export function writeReleasedPythonQuartoDocumentFixture(directory: string): ReleasedPythonQuartoDocumentFixture {
  const fixtureDirectory = path.join(directory, "python-quarto");
  mkdirSync(fixtureDirectory, { recursive: true });
  const sourcePath = path.join(fixtureDirectory, "regional-orders-python.qmd");
  const variableName = "python_quarto_orders";
  const sentinelName = "python_quarto_sentinel_not_run";
  const sourceBytes = Buffer.from(
    [
      "---",
      "title: Regional orders in Python",
      "format: html",
      "jupyter: python3",
      "---",
      "",
      "# Regional orders",
      "",
      "Run the current Python chunk and inspect its dataframe.",
      "",
      "```{python}",
      "import pandas as pd",
      `${variableName} = pd.DataFrame({`,
      '    "order_id": [2500001, 2500002, 2500003],',
      '    "market": ["DACH", "Nordics", "France"],',
      '    "revenue": [620.5, 699.69, 778.88],',
      "})",
      variableName,
      "```",
      "",
      "## Later work",
      "",
      "```{python}",
      `${sentinelName} = pd.DataFrame({"unexpected": [1]})`,
      "```",
      ""
    ].join("\n"),
    "utf8"
  );
  writeFileSync(sourcePath, sourceBytes);
  return {
    sourceUri: vscode.Uri.file(sourcePath),
    variableName,
    sentinelName,
    immutableFiles: [{ path: sourcePath, bytes: sourceBytes }]
  };
}
export interface ReleasedRNotebookKernelTarget {
  readonly label: string;
  readonly name: string;
}

export function writeReleasedRNotebook(
  notebookPath: string,
  phase: "jupyter-r" | "jupyter-r-remote",
  target: ReleasedRNotebookKernelTarget
): void {
  const kernelProbe = [
    `cat(${JSON.stringify(RELEASED_JUPYTER_R_KERNEL_RESULT)}, as.character(getRversion()), '\\n', sep = '')`
  ];
  const source = [
    ".ow_setup_stage <- 'base-frame'",
    "tryCatch({",
    "row_count <- 1205L",
    "orders_frame <- data.frame(",
    "  row_id = seq_len(row_count),",
    "  group = c(rep('A', 602L), rep('B', row_count - 602L)),",
    "  score = as.numeric(seq_len(row_count)),",
    "  label = sprintf('row-%04d', seq_len(row_count)),",
    "  fractional_score = ifelse(seq_len(row_count) %% 2L == 0L, -as.numeric(seq_len(row_count)) - 0.25, as.numeric(seq_len(row_count)) + 0.25),",
    "  check.names = FALSE,",
    "  stringsAsFactors = FALSE",
    ")",
    "for (column_index in seq_len(20L)) {",
    "  orders_frame[[sprintf('extra_%02d', column_index)]] <- sprintf('value-%02d-%04d', column_index, seq_len(row_count))",
    "}",
    "orders_frame$extra_18 <- ifelse(seq_len(row_count) %% 2L == 1L, 'A|B', 'B')",
    "orders_frame$extra_19 <- as.Date('2026-01-01') + (seq_len(row_count) - 1L)",
    "orders_frame$extra_20[1L] <- NA_character_",
    "orders_frame$fractional_score[603L] <- NA_real_",
    "row.names(orders_frame) <- sprintf('case-%04d', seq_len(row_count))",
    ".ow_setup_stage <- 'tibble'",
    "orders_tibble <- tibble::as_tibble(orders_frame, .name_repair = 'minimal')",
    ".ow_setup_stage <- 'data-table'",
    "orders_table <- data.table::as.data.table(orders_frame)",
    "data.table::setkey(orders_table, row_id)",
    ".ow_setup_stage <- 'collapse-load'",
    "invisible(loadNamespace('collapse'))",
    ".ow_setup_stage <- 'collapse-data-frame'",
    "collapse_frame <- collapse::qDF(orders_frame)",
    ".ow_setup_stage <- 'collapse-tibble'",
    "collapse_tibble <- collapse::qTBL(orders_frame)",
    ".ow_setup_stage <- 'collapse-data-table'",
    "collapse_table <- collapse::qDT(orders_frame)",
    ".ow_setup_stage <- 'collapse-grouped'",
    "collapse_grouped <- collapse::fgroup_by(collapse_frame, group)",
    ".ow_setup_stage <- 'collapse-indexed'",
    "collapse_indexed <- collapse::findex_by(collapse_frame, group, row_id)",
    ".ow_setup_stage <- 'snapshots'",
    "orders_frame_before <- serialize(orders_frame, NULL, version = 3L)",
    "orders_tibble_before <- serialize(orders_tibble, NULL, version = 3L)",
    "orders_table_before <- serialize(orders_table, NULL, version = 3L)",
    ".ow_setup_stage <- 'result'",
    ...(phase === "jupyter-r"
      ? [
          ".ow_library_attestation <- local({",
          "  path_key <- function(path) {",
          "    normalized <- normalizePath(path, winslash = '/', mustWork = TRUE)",
          "    if (.Platform$OS.type == 'windows') tolower(normalized) else normalized",
          "  }",
          "  private_library <- path_key(Sys.getenv('R_LIBS_USER', unset = ''))",
          "  list(",
          "    privateLibraryFirst = identical(path_key(.libPaths()[[1L]]), private_library),",
          "    irKernelFromPrivateLibrary = identical(path_key(dirname(find.package('IRkernel'))), private_library)",
          "  )",
          "})"
        ]
      : [".ow_library_attestation <- list(privateLibraryFirst = NA, irKernelFromPrivateLibrary = NA)"]),
    `cat(${JSON.stringify(RELEASED_JUPYTER_R_SETUP_RESULT)}, as.character(jsonlite::toJSON(list(`,
    "  pid = Sys.getpid(), rows = nrow(orders_frame), columns = ncol(orders_frame),",
    "  rVersion = as.character(getRversion()),",
    "  collapseVersion = as.character(utils::packageVersion('collapse')),",
    "  privateLibraryFirst = .ow_library_attestation$privateLibraryFirst,",
    "  irKernelFromPrivateLibrary = .ow_library_attestation$irKernelFromPrivateLibrary,",
    "  remoteRunId = Sys.getenv('OPEN_WRANGLER_REMOTE_RUN_ID', unset = ''),",
    "  hostname = unname(Sys.info()[['nodename']])",
    "), auto_unbox = TRUE)), '\\n', sep = '')",
    "}, error = function(.ow_setup_error) {",
    `  cat(${JSON.stringify(RELEASED_NOTEBOOK_R_SETUP_FAILURE_PREFIX)}, .ow_setup_stage, '\\n', sep = '')`,
    "})"
  ];
  const bindingProbe = [
    `cat(${JSON.stringify(RELEASED_JUPYTER_R_BINDING_RESULT)}, as.character(jsonlite::toJSON(list(`,
    `  runtimeBindingPresent = exists(${JSON.stringify(R_KERNEL_RUNTIME_BINDING)}, envir = .GlobalEnv, inherits = FALSE),`,
    `  exportArtifacts = if (exists(${JSON.stringify(R_KERNEL_RUNTIME_BINDING)}, envir = .GlobalEnv, inherits = FALSE)) local({`,
    `    runtime <- get(${JSON.stringify(R_KERNEL_RUNTIME_BINDING)}, envir = .GlobalEnv, inherits = FALSE)`,
    "    agent_environment <- environment(runtime$agent$dispatch_json)",
    "    exports <- get('exports', envir = agent_environment, inherits = FALSE)",
    "    export_root <- get('export_root', envir = agent_environment, inherits = FALSE)",
    "    length(ls(envir = exports, all.names = TRUE)) + length(list.files(export_root, all.files = TRUE, no.. = TRUE))",
    "  }) else 0L,",
    "  sourceUnchanged = isTRUE(identical(serialize(orders_frame, NULL, version = 3L), orders_frame_before)),",
    "  tibbleSourceUnchanged = isTRUE(identical(serialize(orders_tibble, NULL, version = 3L), orders_tibble_before)),",
    "  tableSourceUnchanged = isTRUE(identical(serialize(orders_table, NULL, version = 3L), orders_table_before)),",
    "  mediaSourceUnchanged = !exists('regional_orders', envir = .GlobalEnv, inherits = FALSE) ||",
    "    isTRUE(identical(serialize(regional_orders, NULL, version = 3L), regional_orders_before))",
    "), auto_unbox = TRUE)), '\\n', sep = '')"
  ];
  const mediaSource = [
    "media_row_count <- 2400L",
    "media_index <- seq_len(media_row_count)",
    "media_revenue <- as.numeric(500 + media_index * 10)",
    "regional_orders <- data.frame(",
    "  order_id = 2400000L + media_index,",
    "  market = rep(c('DACH', 'Nordics', 'France', 'Iberia'), length.out = media_row_count),",
    "  revenue = media_revenue,",
    "  fulfilled = media_index %% 5L != 0L,",
    "  order_date = as.Date('2026-01-01') + ((media_index - 1L) %% 365L),",
    "  segment = rep(c('Enterprise', 'Mid-market', 'Public sector', 'Small business'), length.out = media_row_count),",
    "  channel = rep(c('Direct', 'Partner', 'Online'), length.out = media_row_count),",
    "  product_family = rep(c('Analytics', 'Automation', 'Data platform', 'Planning'), length.out = media_row_count),",
    "  units = 1L + (media_index %% 12L),",
    "  unit_price = round(45 + (media_index %% 250L) * 1.25, 2L),",
    "  discount_pct = round((media_index %% 15L) * 0.5, 1L),",
    "  gross_margin = round(media_revenue * (0.18 + (media_index %% 7L) / 100), 2L),",
    "  priority = rep(c('Standard', 'High', 'Strategic'), length.out = media_row_count),",
    "  renewal_date = as.Date('2027-01-01') + ((media_index - 1L) %% 365L),",
    "  account_status = rep(c('Active', 'Expansion', 'Renewal review'), length.out = media_row_count),",
    "  currency = rep(c('EUR', 'GBP', 'CHF'), length.out = media_row_count),",
    "  sales_rep = sprintf('Rep %02d', 1L + (media_index %% 36L)),",
    "  region = rep(c('Central Europe', 'Northern Europe', 'Southern Europe'), length.out = media_row_count),",
    "  country_code = rep(c('DE', 'SE', 'FR', 'ES'), length.out = media_row_count),",
    "  customer_tier = rep(c('Gold', 'Silver', 'Platinum'), length.out = media_row_count),",
    "  payment_terms = rep(c('Net 30', 'Net 45', 'Net 60'), length.out = media_row_count),",
    "  risk_score = round((media_index %% 100L) / 100, 2L),",
    "  account_name = sprintf('Account %04d', 1L + ((media_index - 1L) %% 850L)),",
    "  notes = sprintf('Renewal wave %02d', 1L + (media_index %% 24L)),",
    "  check.names = FALSE,",
    "  stringsAsFactors = FALSE",
    ")",
    "regional_orders$notes[17L] <- NA_character_",
    "row.names(regional_orders) <- sprintf('OW-%07d', regional_orders$order_id)",
    "regional_orders_before <- serialize(regional_orders, NULL, version = 3L)",
    `cat(${JSON.stringify(RELEASED_JUPYTER_R_MEDIA_RESULT)}, as.character(jsonlite::toJSON(list(`,
    "  rows = nrow(regional_orders), columns = ncol(regional_orders)",
    "), auto_unbox = TRUE)), '\\n', sep = '')"
  ];
  writeFileSync(
    notebookPath,
    JSON.stringify({
      cells: [
        {
          cell_type: "code",
          execution_count: null,
          metadata: {},
          outputs: [],
          source: kernelProbe.map((line) => `${line}\n`)
        },
        {
          cell_type: "code",
          execution_count: null,
          metadata: {},
          outputs: [],
          source: source.map((line) => `${line}\n`)
        },
        {
          cell_type: "code",
          execution_count: null,
          metadata: {},
          outputs: [],
          source: bindingProbe.map((line) => `${line}\n`)
        },
        {
          cell_type: "code",
          execution_count: null,
          metadata: {},
          outputs: [],
          source: mediaSource.map((line) => `${line}\n`)
        },
        {
          cell_type: "code",
          execution_count: null,
          metadata: {},
          outputs: [],
          source: ["# Browse an R data frame with Open Wrangler\n", "orders_frame\n"]
        }
      ],
      metadata: {
        kernelspec: { display_name: target.label, language: "R", name: target.name },
        language_info: { name: "R" }
      },
      nbformat: 4,
      nbformat_minor: 5
    })
  );
}

export function releasedRNotebookCleanedCsvHeader(): string {
  return [
    "record_id",
    "group",
    "score",
    "label",
    "fractional_score",
    ...Array.from({ length: 20 }, (_, index) => `extra_${String(index + 1).padStart(2, "0")}`)
  ]
    .map((name) => `"${name}"`)
    .join(",");
}

export function releasedRNotebookCleanedCsvRow(row: number): string {
  assert.ok(Number.isSafeInteger(row) && row >= 1 && row <= 1_205);
  const fractionalScore = row % 2 === 0 ? `-${row}.25` : `${row}.25`;
  const values = [
    String(row),
    `"${row <= 602 ? "A" : "B"}"`,
    String(row),
    `"row-${String(row).padStart(4, "0")}"`,
    fractionalScore,
    ...Array.from({ length: 20 }, (_, index) => {
      const column = index + 1;
      if (column === 19) {
        return new Date(Date.UTC(2026, 0, row)).toISOString().slice(0, 10);
      }
      if (column === 18) return row % 2 === 1 ? '"A|B"' : '"B"';
      if (row === 1 && column === 20) return "";
      return `"value-${String(column).padStart(2, "0")}-${String(row).padStart(4, "0")}"`;
    })
  ];
  return values.join(",");
}
