# Native R support

Open Wrangler 2 is planned to add native R dataframes without routing user data
through Python, Pandas, Polars, Arrow, or `reticulate`. This document records the
integration boundary before the user-facing feature is enabled. It is not a claim
that the current stable release supports R.

## Supported host surfaces

| Surface              | Initial integration                                            | Product decision                                    |
| -------------------- | -------------------------------------------------------------- | --------------------------------------------------- |
| R-kernel `.ipynb`    | Stable Jupyter extension kernel API                            | First production surface                            |
| `.R`                 | Explicit Open Wrangler helper sourced into the exact R session | Planned after the notebook viewer                   |
| `.Rmd` and `.qmd`    | Same explicit session helper                                   | R and Quarto extensions remain authoring companions |
| Quarto visual editor | No implicit variable access                                    | Do not replace or modify the Quarto editor          |
| Quarto CLI           | Public path, version, and availability metadata only           | Never infer a live R session from CLI availability  |

The R and Quarto extensions improve authoring, preview, and rendering. Their
currently documented extension APIs do not expose a typed live-session dataframe
contract. Open Wrangler therefore must not read vscode-R session files, invoke
private commands, depend on undocumented IPC, or guess which R process owns a
document. Installing either extension does not grant Open Wrangler access to an R
environment.

The Jupyter extension API is language-neutral and exposes the selected kernel
language plus correlated code execution. That makes an IRkernel notebook the
first reliable surface: the extension can retain the exact notebook and kernel
identity using the same lifecycle rules as the existing Python notebook bridge.

## Provider boundary

`r/openwrangler_runtime/kernel_agent.R` is a small sourceable agent that runs
inside the exact R process owning the dataframe. The first provider protocol is
private, versioned, correlated, strict, and read-only. It supports:

- base `data.frame`, tibble, and `data.table` objects without converting their
  class;
- full schema metadata and bounded two-dimensional pages;
- typed null, NaN, infinity, integer, numeric, logical, string, date, datetime,
  and duration cells;
- host-generated session IDs and deterministic close;
- strict rejection of filtering, sorting, editing, unknown fields, and malformed
  requests until those capabilities have native implementations.

The agent requires the user environment to contain `jsonlite`. Open Wrangler
does not install it silently. A future dependency action must name the exact R
executable and package, obtain confirmation, and install into the user-selected
library.

## Delivery slices

1. **Foundation** — provider protocol, native serializer, capability model,
   package allowlist, and R-only smoke test.
2. **IRkernel viewer** — exact-notebook launch, variable picker, kernel dispatch,
   paging, cancellation, cleanup, and recovery.
3. **Explicit session helper** — a documented helper for `.R`, `.Rmd`, and
   `.qmd` sessions with an unambiguous connection handshake.
4. **Viewing parity** — native filtering, multi-sort, profiles, large pages,
   and base/tibble/data.table equivalence.
5. **Editing parity** — R-native transformation IR compilers and generated code
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
