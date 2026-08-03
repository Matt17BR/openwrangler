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

IRkernel is the first supported R transport. A notebook launch must stay bound to the exact `NotebookDocument` and
kernel captured when the user starts it. Kernel lookup, dispatch, recovery, and cleanup may not retarget through the
active editor, a matching URI, a replacement document, or another R session. A timed-out or closed view may detach
from the UI, but cleanup still waits for the original kernel operation to settle before it disposes any resulting
session.

Support for `.R`, `.Rmd`, and `.qmd` documents requires a dedicated integration helper that owns all of the following:

- the exact source document and version;
- the R process or session in which the object exists;
- object discovery and request dispatch;
- code insertion and confirmation in that same document.

Open Wrangler will not infer this ownership from the active terminal, global R state, or a document path. Each document
type remains unsupported until its helper and real-editor acceptance exist.

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
- A preview label does not relax notebook ownership, cleanup, or packaged-editor acceptance.
