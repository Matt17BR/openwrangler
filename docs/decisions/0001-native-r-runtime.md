# Native R runtime for Open Wrangler 2

- Status: Accepted; amended for owned R-document processes and active R terminals
- Date: 2026-08-03

## Context

Open Wrangler originally handled dataframe work through Python. R support needs to preserve R objects and package
semantics, including `data.frame`, tibble and `data.table`. Converting those objects through Python would change
classes, missing values, factors and generated code, and require a Python environment for an R workflow.

R notebooks have an execution owner: the selected IRkernel. The official VS Code R extension can own a live R
terminal. Ordinary R documents need a separate process whose lifetime Open Wrangler can control. R Markdown and
Quarto add document syntax, but their render processes are not Open Wrangler sessions.

## Decision

Run R dataframe operations in R. Share the workbench, operation model and versioned host protocol with other engines,
while keeping frame validation, execution, generated code and exports native to R. The host identifies the confirmed
backend, frame flavor and code dialect explicitly.

Support three execution paths with distinct owners:

- An IRkernel session stays bound to the exact notebook, kernel and variable captured when the action starts.
- An existing live terminal session stays bound to the exact official R terminal and process. Passive discovery uses
  bounded, untrusted vscode-R metadata; Open or Refresh explicitly connects through the terminal API.
- An R document session owns a private `Rscript` process and the exact text document/version that started it. R Markdown
  and Quarto use the same process for supported R cells, without attaching to or replacing their render processes.

Do not retarget asynchronous work to whichever editor, kernel or terminal becomes active later. Recovery must verify
its replacement and retain the original operation's outcome; abandoning an await does not establish that native work
has stopped. Cleanup remains attached to the resource that Open Wrangler actually owns.

Live viewing retains the verified R binding. Editing creates an isolated copy and preserves the source. Runtime and
standalone generated code must agree on supported classes, values, column identity and refusals. Unsupported frames
fail explicitly rather than being flattened or converted through another engine.

The [architecture](../architecture.md#native-r) owns the current frame, numeric, transport, document and export
contracts. The [generated reference](../reference.md#transformation-operations) owns the operation catalog;
[feature parity](../feature-parity.md#native-r-preview) owns user-facing support and limitations. Ordinary implementation fixes
update those owners when needed. Amend this decision only when the language boundary, execution ownership or its
rationale changes.

## Alternatives rejected

- **Conversion through Python:** loses native R semantics and adds an unrelated runtime dependency.
- **Attaching to arbitrary R or render processes:** provides no reliable authority to evaluate code, recover a session
  or stop its descendants. A matching path or process name is not sufficient ownership.
- **Reimplementing knitr or Quarto rendering:** expands the product beyond bounded dataframe execution and would imply
  render semantics the document parser does not provide.

## Consequences

R needs its own producer, decoder, native tests and generated-code checks. The shared UI does not imply identical
numeric capacity, package behavior or platform support across engines. Source preservation, trust, bounded transport
and exact cleanup still apply to every path.

R support is currently Preview because stable extension publication does not yet require R qualification against its
exact candidate package. The [first stable R notebook scope](../feature-parity.md#first-stable-r-notebook-scope) defines
finite graduation criteria; terminal and document paths can be assessed separately. New claims need direct native and
generated-code evidence plus installed evidence for the advertised host path. [Testing](../testing.md) and [CI](../ci.md)
own those checks.
