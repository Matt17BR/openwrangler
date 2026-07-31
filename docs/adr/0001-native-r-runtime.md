# ADR 0001: Native R runtime and notebook boundary

- Status: accepted for the Open Wrangler 2.0 development branch
- Date: 2026-07-31
- Scope: base `data.frame`, tibble, `data.table`, IRkernel, Quarto, and R Markdown

## Context

Open Wrangler's released runtime is Python-owned, but its coordinator, typed grid, immutable-source model, viewing/cleaning split, and transformation IR are language-neutral. R support must preserve R semantics and generate executable R code. Treating an R object as Pandas through `reticulate`, Arrow, or another conversion layer would make factors, typed `NA`, S3/vctrs classes, row names, grouped tibbles, list columns, time zones, and `data.table` mutation behavior unreliable.

The editor integrations do not expose one interchangeable R session:

- The stable Jupyter extension API exposes an exact notebook kernel, its language, correlated code execution, status, and cancellation. R-backed `.ipynb` notebooks therefore have a sound first host through IRkernel or another compatible R Jupyter kernel.
- Quarto's current R executor delegates blocks to `r.runSelection`. Its exported extension API exposes Quarto installation metadata, not a correlated R session or result handle.
- vscode-R's current exported API exposes its help panel. Its internal session watcher and transport are not a supported cross-extension execution API.
- `.Rmd` and ordinary R-backed `.qmd` documents are source documents rendered through Knitr. Stable text edits can insert generated `{r}` chunks into an exact document, but document editing alone cannot identify or read the live R process that executed another chunk.

These observations were checked against the public upstream sources on 2026-07-31: [Jupyter kernel API](https://github.com/microsoft/vscode-jupyter/blob/eb3597ff0739386d99382c2f68aa6c9c15041ed1/src/api.d.ts#L210-L241), [IRkernel](https://github.com/IRkernel/IRkernel/tree/124f2347f15cfadeabc6738868e05e6087f4c456), [Quarto executor](https://github.com/quarto-dev/quarto/blob/63eebf6039c74573f54a87edbc9d29b30d26ceab/apps/vscode/src/host/executors.ts#L91-L101), [Quarto public API](https://github.com/quarto-dev/quarto/blob/63eebf6039c74573f54a87edbc9d29b30d26ceab/apps/vscode/src/api.ts#L53-L73), and [vscode-R public API](https://github.com/REditorSupport/vscode-R/blob/c02ace52911430a2831922ff69ae3c971478ae5e/src/api.d.ts).

## Decision

### Keep three identities independent

Every future R session must name these separately:

1. runtime language: `r`;
2. frame flavor: base `data.frame`, tibble, grouped/rowwise tibble, or `data.table`;
3. generated-code dialect: base R, dplyr/tidyr, or `data.table`.

A tibble may deliberately generate base R code, and a `data.table` value is never inferred to authorize by-reference generated code. No R value is represented as the existing `pandas`, `polars`, `duckdb`, or `pyspark` backend.

### Use one R core with owned transports

The R adapter is pure R. It returns versioned ordinary R lists containing schema, native metadata, and bounded typed pages. The first checked-in contract is `r/openwrangler_runtime/frame_contract.R`, validated independently by `src/shared/rRuntimeContract.ts`. It does not import Python, Pandas, Polars, DuckDB, Arrow, or `reticulate`.

Production work should give that core two transports:

- `RKernelBridge`: execute the bundled R agent in the exact Jupyter-owned R kernel and retain all existing notebook provenance, lifecycle, stale-response, and cleanup guarantees;
- `RProcessBridge`: an Open Wrangler-owned `Rscript --vanilla` process using versioned NDJSON for file and explicit-helper workflows.

Both transports must fail closed before bootstrap or execution unless the exact workspace remains trusted. R dependency installation or mutation, generated/custom R code, and `.R`/`.Rmd`/`.qmd` or notebook source insertion require their own fresh extension-host trust check immediately before dispatch; a webview message cannot grant trust. The runtime source may use optional R packages only behind explicit capability/dependency diagnostics and an exact confirm-before-install action. It never silently mutates an R library. The contract itself remains base-R-only. Notebook bootstrap must transfer bundled source through the Jupyter API because a remote kernel cannot read the extension filesystem.

### Start read-only, with typed semantics

The first contract supports bounded native pages and records:

- `NA` separately from `NaN` and infinities;
- factor levels and ordering;
- `Date`, `POSIXct` time zone, and `difftime` units;
- exact `bit64::integer64` text rather than a lossy JavaScript number;
- row names, duplicate/non-syntactic column names, tibble grouping, and `data.table` keys;
- stable positional column IDs independent of duplicate names.

Unknown dataframe subclasses fail closed. The probe never mutates its source; its tests compare serialized source bytes before and after base, tibble, and `data.table` reads.

### Do not attach to private Quarto or vscode-R sessions

R-backed `.ipynb` is the first live-variable target. For `.qmd`/`.Rmd`, Open Wrangler may later add exact-origin source-mode chunk insertion and an explicit Open Wrangler-owned helper endpoint. It must not scrape terminals, discovery files, private commands, sockets, pipes, or authentication tokens to simulate live-session ownership.

Seamless live `.qmd`/`.Rmd` variable opening remains blocked until an upstream public API or supported broker provides exact session identity, correlated execution/completion, cancellation, restart, disposal, and remote semantics. Visual Editor insertion also remains out of scope until its document mapping is public and provable.

## Consequences

- R support is an Open Wrangler 2.0 capability, not a 1.x compatibility claim.
- The existing protocol v2 remains unchanged while the experimental R contract proves semantics. A production protocol revision must incorporate runtime language, R metadata, and generated-code descriptors deliberately.
- `data.table::copy()` is mandatory before every draft, custom-code execution, derivation, or generated mutating function. Read-only paging must still prove no by-reference mutation.
- Arrow may later optimize compatible blocks, but it cannot be the semantic source of truth.
- R code insertion uses `.R`, `.Rmd`, or `.qmd` text-document provenance; R-backed `.ipynb` insertion uses exact notebook provenance. The two paths do not substitute for each other.

## Next bounded slices

1. Add an `RKernelBridge` that bootstraps this contract in an exact R Jupyter kernel and opens one read-only base `data.frame` page.
2. Add native filtering, sorting, and progressive profiles with golden typed-value tests for base frames and tibbles.
3. Complete one base-R rename draft → diff → apply/discard → executable generated-code slice.
4. Add exact-source `{r}` chunk insertion for `.Rmd`/`.qmd`, without claiming live-session attachment.
5. Add dplyr/tidyr explicitly, then `data.table` only after copy-isolation and by-reference failure tests are green.

No support claim is valid until local/remote kernel restart, cancellation, cleanup, package diagnostics, executable generated-code parity, editor acceptance, and original-object immutability are green in a documented R/version matrix.
