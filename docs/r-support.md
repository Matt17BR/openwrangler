# Native R support

Open Wrangler 2 is planned to add native R dataframes without routing user data
through Python, Pandas, Polars, Arrow, or `reticulate`. This document records the
integration boundary before the user-facing feature is enabled. It is not a claim
that the current stable release supports R.

The durable boundary decision is recorded in
[ADR 0001: Native R provider and editor-session boundary](adr/0001-native-r-runtime.md).

## Supported host surfaces

| Surface              | Initial integration                                            | Product decision                                   |
| -------------------- | -------------------------------------------------------------- | -------------------------------------------------- |
| R-kernel `.ipynb`    | Stable Jupyter extension kernel API                            | First production surface                           |
| `.R`                 | Explicit Open Wrangler helper sourced into the exact R session | Experimental after the notebook viewer             |
| `.Rmd` and `.qmd`    | Same explicit session helper                                   | Experimental; not a seamless integration claim     |
| Quarto visual editor | No implicit variable access                                    | Do not replace or modify the Quarto editor         |
| Quarto CLI           | Public path, version, and availability metadata only           | Never infer a live R session from CLI availability |

The R and Quarto extensions improve authoring, preview, and rendering. Their
currently documented extension APIs do not expose a typed live-session dataframe
contract. Open Wrangler therefore must not read vscode-R session files, invoke
private commands, depend on undocumented IPC, or guess which R process owns a
document. Installing either extension does not grant Open Wrangler access to an R
environment.

The current foundation does **not** open live variables from `.R`, `.Rmd`, or
`.qmd` documents. It only defines the fail-closed connection contract needed for
a later explicit helper. A valid helper receipt is opaque and bound to the exact
editor document object, R process instance, and helper instance; replacement,
disposal, cross-document reuse, or a structurally forged receipt is rejected.
This keeps “the R extension is installed” distinct from “Open Wrangler owns a
verified channel to this exact live session.”

The Jupyter extension API is language-neutral and exposes the selected kernel
language plus correlated code execution. That makes an IRkernel notebook the
first reliable surface: the extension can retain the exact notebook and kernel
identity using the same lifecycle rules as the existing Python notebook bridge.

Every R bootstrap or execution path is code execution. The extension host must
therefore recheck Workspace Trust immediately before bootstrap, provider dispatch,
dependency mutation, generated or custom code, source insertion, and export. A
provider response or webview intent cannot confer trust.

## Provider boundary

`r/openwrangler_runtime/kernel_agent.R` is a small sourceable agent that runs
inside the exact R process owning the dataframe. Provider protocol v2 is
private, versioned, correlated, strict, and read-only. It supports:

- bounded discovery of picker metadata for exact base `data.frame`, tibble, and
  `data.table` bindings in the provider's owned R environment;
- base `data.frame`, tibble, and `data.table` objects without converting their
  class;
- full schema metadata and bounded two-dimensional pages;
- typed null, NaN, infinity, integer, numeric, logical, string, date, datetime,
  and duration cells;
- host-generated session IDs and deterministic close;
- strict rejection of filtering, sorting, editing, unknown fields, and malformed
  requests until those capabilities have native implementations.

The file evaluates to one provider factory and keeps every implementation symbol
inside that factory's private lexical environment. The future kernel loader must
source it into a fresh private environment and retain only the returned factory:

```r
local({
  agent_env <- new.env(parent = baseenv())
  agent_factory <- source(agent_path, local = agent_env)$value
  stopifnot(is.function(agent_factory), length(ls(agent_env, all.names = TRUE)) == 0L)
  agent_factory(exact_dataframe_environment)
})
```

Transport code must validate every response with the dispatched request ID,
request kind, requested session/projection/range, and confirmed session
schema/shape. A merely well-shaped response is insufficient. Revision-zero
`data.table` sources use `data.table::copy`, retaining their native class while
preventing later `:=` mutations from changing the open session. Shaped,
matrix/array, list, and raw columns are rejected until faithful nested or binary
typed-cell encodings exist.

Editing will extend the same isolation rule: every `data.table` draft,
derivation, custom-code run, or generated function that could mutate by reference
must start from `data.table::copy(source)` and prove that the original object is
unchanged. Runtime language, frame flavor, and generated-code dialect are also
separate identities. A tibble may generate base-R code; an object's class alone
never authorizes dplyr/tidyr or `data.table` syntax.

Producer and host enforce the same reviewed ceilings before data enters parsed
coordinator state: raw request/response bytes, dataframe shape, schema estimate,
page rows/columns/cells, page estimate, and individual text values. Pages contain
at most 100,000 cells. Schema IDs must be canonical for their zero-based column
position, and the native storage/class signature must map to the exact semantic
type the R producer emits, including for zero-row dataframes. Names and string
values are exact or rejected with a structured diagnostic; `NA` column names are
not interchangeable with empty names, and values are never shortened with a
silent ellipsis.

The agent requires the user environment to contain `jsonlite`, and native
`data.table` snapshots require `data.table`. Open Wrangler does not install
either silently. A future dependency action must name the exact R executable and
packages, obtain confirmation, and install into the user-selected library. The
required repository gate additionally pins and exercises `tibble` so none of the
three advertised dataframe flavors can disappear behind an optional test skip.

Discovery returns only a bounded provider-issued discovery ID, variable name,
canonical dataframe class, and bounded row/column shape. It never serializes
cells, profiles columns, or snapshots a dataframe. The producer examines at
most 4,096 bindings, returns at most 256
variables, accepts names only through the mirrored 128-code-point/512-byte
ceiling, and emits at most 256 KiB for this request. The transport checks that
smaller raw byte ceiling before `JSON.parse`; the parsed response must contain
exact keys, unique discovery IDs, unique names, one of the three canonical class
tags, and a valid bounded shape. Each discovery replaces the provider-private
registry, and provider close clears it. Opening requires the selected ID and
name, rejects missing or active bindings, and repeats public non-forcing
substitution before comparing the exact canonical class, shape, and
`identical()` value with the registered observation. Active bindings and
promise-backed bindings (including already forced promises, whose force state
is not exposed by the public base-R API) are never invoked or forced.
Noncanonical dataframe subclasses are not presented and cannot be opened. A
changed or stale source fails closed before session publication. A replacement
with an `identical()` value is intentionally semantically indistinguishable; the
provider does not inspect allocator addresses. An incomplete scan is labeled
`truncated` rather than silently claimed as exhaustive.

## IRkernel transport foundation

`src/extension/r/rKernelProviderTransport.ts` implements the first exact-kernel
transport layer. It embeds the reviewed agent source instead of assuming a
remote kernel can read the extension filesystem, stores the live provider in a
content-addressed private R option, and publishes no helper symbol into the
user's `.GlobalEnv`. Every dispatch is base64 framed, marker isolated, bounded
before JSON parsing, and validated against its exact request plus confirmed
session. Disposal closes the provider and removes the private option.

The same private provider now performs variable discovery through that owned
kernel object. There is still no notebook-URI lookup or fallback, and the
discovery result is not yet connected to a public picker.

The transport intentionally receives one already-owned Jupyter `Kernel` object;
it has no URI lookup or fallback path. The user-facing IRkernel viewer remains
disabled until an R-specific notebook bridge adds exact `NotebookDocument` and
kernel acquisition, picker wiring, cancellation-safe failed-open cleanup,
restart recovery, coordinator mapping, and installed-editor acceptance. This
is transport evidence, not an R support claim.

The next stacked session layer is `src/extension/r/rKernelDataFrameSession.ts`.
It owns correlated open/page/close state above `rKernelProviderTransport.ts` and
publishes only contextually validated provider results. The `.R`, `.Rmd`, and
`.qmd` helper remains a separate exact-session integration; it is not inferred
from an `Rscript` process, an installed authoring extension, or a notebook URI.

## Semantic acceptance inventory

The following are future versioned provider gates, not capabilities claimed by
the current read-only foundation:

- factor levels must round-trip in exact order, including explicit ordered-factor
  metadata;
- `POSIXct` values must retain their time-zone metadata, and `difftime` values
  must retain their declared units;
- row names must remain stable and correctly paged rather than being regenerated
  from the visible offset;
- grouped and rowwise tibbles must retain stable group-column identities;
- `data.table` keys must retain stable key-column identities without permitting
  by-reference source mutation;
- base integer and `bit64::integer64` cells must pass exact raw-type-specific host
  bounds, with each type's reserved `NA` sentinel represented only as null;
- list columns require a faithful bounded typed encoding. They remain rejected,
  as do matrix/array and raw columns, until that encoding and its producer/host
  acceptance matrix exist.

Each gate needs producer, host-decoder, session, and R-only cross-runtime evidence.
Arrow may later optimize compatible bounded blocks, but it cannot define R
semantics or become the source of truth.

## Delivery slices

1. **Foundation:** provider protocol, native serializer, capability model,
   package allowlist, and R-only smoke test.
2. **IRkernel viewer (in progress):** exact-kernel provider bootstrap, framing,
   bounded native variable discovery, response validation, and disposal are
   implemented. Exact-notebook launch, picker wiring, paging coordination,
   cancellation cleanup, recovery, and editor acceptance remain.
3. **Explicit session helper:** a documented helper for `.R`, `.Rmd`, and
   `.qmd` sessions with an unambiguous connection handshake.
4. **Viewing parity:** native filtering, multi-sort, profiles, large pages,
   and base/tibble/data.table equivalence.
5. **Editing parity:** R-native transformation IR compilers and generated code
   for base R, tidyverse, and data.table, delivered operation by operation.

Every slice must run in an R-only test environment with Python unavailable.
Viewer acceptance must cover VS Code and Cursor using isolated, non-focus-stealing
editor profiles. No R support is advertised as stable until the relevant rows in
`docs/feature-parity.md` are green.

## Primary references

- [vscode-R public API](https://github.com/REditorSupport/vscode-R/blob/v2.8.8/src/api.d.ts)
- [vscode-R extension exports](https://github.com/REditorSupport/vscode-R/blob/v2.8.8/src/extension.ts)
- [vscode-R session-process direction](https://github.com/REditorSupport/vscode-R/blob/master/sess/README.md)
- [Quarto VS Code public API](https://github.com/quarto-dev/quarto/blob/v1.135.0-vsix/apps/vscode/src/api.ts)
- [Quarto VS Code authoring documentation](https://quarto.org/docs/tools/vscode.html)
- [Jupyter extension API](https://github.com/microsoft/vscode-jupyter/blob/main/src/api.d.ts)
- [VS Code notebook extension guide](https://code.visualstudio.com/api/extension-guides/notebook)
- [Rscript documentation](https://stat.ethz.ch/R-manual/R-patched/library/utils/html/Rscript.html)
- [IRdisplay documentation](https://irkernel.github.io/docs/IRdisplay/0.4.4/display.html)
