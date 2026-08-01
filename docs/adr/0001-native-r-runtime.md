# ADR 0001: Native R provider and editor-session boundary

- Status: Accepted for Open Wrangler 2 development
- Date: 2026-08-01
- Scope: base `data.frame`, tibble, `data.table`, IRkernel, R Markdown, and Quarto

## Context

Open Wrangler's session coordinator, immutable-source model, typed grid, and
transformation IR can support more than one runtime language. Its Python runtime
cannot, however, define R semantics. Converting an R object through Python,
Pandas, Polars, DuckDB, Arrow, or `reticulate` would make typed `NA`, factors,
S3/vctrs classes, row names, time zones, grouped frames, and `data.table`
by-reference behavior unreliable.

The available editor surfaces also do not expose one interchangeable R session:

- the stable Jupyter extension API can provide one exact notebook-owned kernel,
  correlated execution, status, and cancellation;
- the public vscode-R and Quarto extension APIs provide authoring integration,
  not a supported typed handle to the R process that owns a variable;
- `.R`, `.Rmd`, and `.qmd` files can receive provenance-checked source edits,
  but editing a document does not prove which live R session executed it.

The design therefore needs one native semantic core, explicit host ownership,
and separate integrations for notebooks, live editor sessions, and source edits.

## Decision

### Keep runtime, frame, and generated code independent

Every future R session records three separate identities:

1. runtime language: R;
2. frame flavor: base frame, tibble (including later grouped/rowwise variants),
   or `data.table`;
3. generated-code dialect: base R, dplyr/tidyr, or `data.table`.

The generated dialect is an explicit user/session decision. A tibble may produce
base-R code, and a `data.table` class never by itself authorizes by-reference
generated code. R values do not masquerade as any Python backend.

### Use the canonical provider stack

The native provider has one versioned wire representation:

- `r/openwrangler_runtime/kernel_agent.R` is the private pure-R producer and
  session owner inside the exact R process;
- `src/extension/r/rProviderProtocol.ts` is the strict host decoder and exact
  dispatched-request/confirmed-session guard;
- `src/extension/r/rKernelProviderTransport.ts` owns bootstrap, framing, byte
  bounds, and deterministic disposal for one exact Jupyter `Kernel`;
- `src/extension/r/rKernelDataFrameSession.ts` is the next stacked session layer,
  owning correlated open/page/close state without inventing another wire format.

The R agent evaluates to one factory in a private lexical environment. Remote
kernels receive its reviewed, content-addressed source through the Jupyter API;
they are never expected to read the extension filesystem. The provider remains
outside `.GlobalEnv`, and disposal removes its state.

### Make IRkernel the first live-variable surface

An R-backed Jupyter notebook is the first production target because the stable
Jupyter API can supply the exact kernel. The transport never reacquires a kernel
by URI, falls back to another notebook, or treats an installed authoring
extension as session ownership.

Live variables in `.R`, `.Rmd`, and `.qmd` require an explicit Open Wrangler
helper bound to the exact document, R process, and helper instance until a stable
upstream typed-session API exists. This helper is a distinct host integration;
it is not inferred from an `Rscript` process and does not depend on terminal
scraping, private commands, session files, IPC, sockets, or tokens belonging to
vscode-R or Quarto.

Generated source insertion is also distinct from live-session attachment.
`.R`, `.Rmd`, and `.qmd` insertion follows exact text-document provenance;
notebook insertion follows exact notebook provenance. Neither path proves access
to a live variable, and neither may substitute for the other.

### Gate every executable or mutating path with Workspace Trust

The extension host rechecks Workspace Trust immediately before every R bootstrap
or execution, dependency mutation, generated/custom-code dispatch, source
insertion, and export. A webview message or provider response cannot grant trust.
Package installation remains explicit, names the exact R executable and packages,
and requires confirmation before mutating the selected library.

### Preserve native semantics and source immutability

The provider starts read-only and advertises only implemented capabilities.
Typed pages distinguish null, NaN, infinities, integers, strings, dates,
datetimes, and durations without dataframe conversion. Integer cells are strings
on the wire and are checked against the bounds implied by their exact `rawType`;
the reserved base-R and `bit64::integer64` `NA` sentinels are valid only as null.

Revision-zero `data.table` viewing owns `data.table::copy(source)`. Every future
draft, derivation, custom-code run, or mutating generated function must likewise
begin from `data.table::copy(source)` and prove that the original object did not
change. Unsupported shaped, list, and raw columns fail closed until faithful,
bounded encodings and their acceptance tests exist.

## Consequences

- Native R support is a version-2 capability, never a 1.x compatibility claim.
- Arrow may later optimize compatible bounded blocks, but it cannot define R
  semantics or become the source of truth.
- Source insertion can ship independently from a live R Markdown/Quarto session
  helper as long as its UI does not imply variable access.
- New frame metadata or editing capabilities extend the canonical provider and
  contextual validator rather than introducing a parallel protocol.
- No support claim is valid until R-only producer, host-decoder, session,
  immutability, restart, cancellation, cleanup, and installed-editor acceptance
  gates are green in the documented R/version matrix.

## Follow-up gates

1. Complete exact-notebook launch and recovery above
   `rKernelDataFrameSession.ts`.
2. Add native filtering, multi-sort, and progressive profiles with typed semantic
   regressions across base frames, tibbles, and `data.table`.
3. Deliver one base-R draft, diff, apply/discard, and executable generated-code
   slice before adding alternative code dialects.
4. Add exact-source R chunk insertion independently of the explicit live-session
   helper for `.Rmd` and `.qmd`.
5. Add dplyr/tidyr and then `data.table` editing only after dialect selection,
   copy isolation, and original-object immutability tests are green.
