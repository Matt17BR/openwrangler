# Native R runtime for Open Wrangler 2

- Status: Accepted
- Date: 2026-08-03

## Context

Open Wrangler currently runs dataframe work in Python. R support needs to preserve R objects and R package semantics,
including `data.frame`, tibble, and `data.table`. Sending those objects through Python would change types, null handling,
categorical behavior, and generated code. It would also make a Python environment an unnecessary requirement for an R
workflow.

R notebooks already have a well-defined execution owner: the selected IRkernel. Plain `.R` files, R Markdown, and
Quarto documents do not all share that ownership model. An active terminal or a matching document URI is not enough to
identify the R process that owns an object.

## Decision

Open Wrangler 2 will run R dataframes in R. It will not convert them through Python or use a Python compatibility
layer.

The shared architecture will keep three facts separate:

1. **Runtime language** identifies the process that executes a request, initially Python or R.
2. **Dataframe flavor** identifies the object and its semantics, such as Pandas, Polars, DuckDB, PySpark,
   `data.frame`, tibble, or `data.table`.
3. **Code dialect** identifies the code Open Wrangler previews and inserts, such as engine-specific Python, base R,
   dplyr, or data.table code.

These are separate properties rather than aliases for one `backend` value. Shared types will be introduced with the
runtime slice that uses them, not ahead of an implementation.

The first implementation slice is a transport-neutral frame/page contract. It has these invariants:

- The producer runs in R and accepts only canonical base `data.frame`, tibble, and `data.table` classes.
- Every capture owns an isolated R snapshot. `data.table` snapshots use `data.table::copy()`.
- Column identity is positional, so duplicate and non-syntactic names remain usable without rewriting the source.
- R-specific factor, ordered-factor, Date, POSIXct, difftime, and integer64 metadata crosses the boundary explicitly.
- Plain-double `NA`, `NaN`, positive infinity, and negative infinity remain distinct typed values. Non-finite
  classed temporal values and fractional Dates are rejected instead of being relabeled or rounded.
- Display text does not inherit `options(OutDec)` or the process time zone. POSIXct values with a null or empty
  timezone display in UTC while retaining that original metadata, and reserved integer missing-value sentinels are
  never accepted as ordinary values.
- Read-only sort rules use the captured positional column ID and name. They are stable, keep source row IDs, and can
  choose direction and missing-value placement independently for each key.
- Row, column, cell, factor-level, text, and encoded-payload limits are checked by the R producer and again by the
  TypeScript decoder. The producer accounts for metadata and cells while building a page and stops before allocating
  a complete oversized page or JSON string.
- Unsupported classes, explicit row names, nested columns, and unrecognized attributes fail before a page is
  published. The contract does not silently flatten them.

This contract is internal groundwork. It does not add R to the Python `DataBackend` union, Python protocol v2, the
session coordinator, commands, or the public support matrix.

IRkernel is the first supported R transport. A notebook launch must stay bound to the exact `NotebookDocument` and
kernel captured when the user starts it. Kernel lookup, dispatch, recovery, and cleanup may not retarget through the
active editor, a matching URI, a replacement document, or another R session.

The host creates the candidate session ID before dispatch and maps it to that kernel. A malformed, cancelled, timed
out, or stale open keeps a continuation on the original operation. When that operation settles, the host makes one
bounded direct close attempt for the known candidate on the same kernel; it does not look the kernel up again or retry
against a replacement. A kernel restart ends that kernel's sessions and invalidates the mapping. An operation that
never settles may detach from the UI, but its ownership record remains until the kernel ends or the continuation can
perform that close.

The live R object is immutable from Open Wrangler's point of view. Each session works from an isolated snapshot. Before
any draft, apply, generated-code check, or custom-code evaluation that could mutate an object, the runtime makes a
fresh isolated copy; `data.table` uses `data.table::copy()`. Acceptance tests must prove that success, failure,
cancellation, undo, and disposal leave the originating notebook object unchanged.

Support for `.R`, `.Rmd`, and `.qmd` documents requires a dedicated integration helper that owns all of the following:

- the exact source document and version;
- the R process or session in which the object exists;
- object discovery and request dispatch;
- code insertion and confirmation in that same document.

Open Wrangler will not infer this ownership from the active terminal, global R state, or a document path. Attaching to
a live variable may use only a documented stable public broker API or an Open Wrangler-owned helper and process. It may
not inspect private Quarto or vscode-R sockets, temporary state, extension storage, or process-discovery details. Exact
source-document code insertion can ship independently of live-variable attachment. Each document type remains
unsupported until its helper and real-editor acceptance exist.

The first public R build will use the `1.99.x` preview channel. It may start only after read-only `data.frame`, tibble,
and `data.table` sessions pass real IRkernel tests and packaged VS Code and Cursor acceptance. A stable 2.0 release must
also have native R transformation and generated-code coverage for the R surfaces it advertises. Quarto, R Markdown,
and plain R support may be advertised only after their exact-document helpers pass the same release gates.

## Consequences

- The existing Python runtime and stable v1 release line remain independent of R development.
- The grid and transformation model can be shared, but execution, object ownership, type handling, and generated code
  stay native to the selected language and dataframe flavor.
- The old R branches are design input only. Their speculative shared types and detached kernel timeout model will not
  be carried forward.
- R 4.4 and 4.5 contract tests must pass before a change to the producer or decoder can merge. Real IRkernel and
  packaged-editor tests remain required before any user-facing R claim.
- A preview label does not relax notebook ownership, cleanup, or packaged-editor acceptance.
