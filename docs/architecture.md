# Architecture

## Product boundaries

Data Explorer has three cooperating processes:

1. The VS Code extension host owns commands, trusted-workspace enforcement, editor and view providers, session coordination, filesystem prompts, runtime processes, and Jupyter access.
2. Sandboxed webviews render the editor grid and auxiliary views. They receive validated state snapshots and send typed user intents; they never read files or execute Python directly.
3. The bundled Python runtime executes dataframe queries and transformation plans in either a standalone selected interpreter or the active Jupyter kernel.

The source dataframe is immutable from Data Explorer's perspective. A session stores a source descriptor, import options, engine, independent viewing query, committed transformation steps, optional draft step, and revision. Export is the only operation that writes data, and it always targets an explicit destination.

## Runtime and engines

The runtime exposes one protocol across standalone and notebook transports. `protocol/data-explorer.v2.schema.json` is the canonical contract; `npm run generate:protocol` produces `src/shared/protocol.generated.ts`, and CI rejects stale generated types. Python's explicit decoder rejects malformed versions, correlation IDs, priorities, request shapes, revisions, and import descriptors before dispatch. Standalone requests use newline-delimited envelopes on standard input/output; notebook requests use the stable `@vscode/jupyter-extension` `kernels.getKernel()` and `executeCode()` surface with a marker-delimited encoded envelope.

Pandas and Polars adapters implement the same engine contract for schema, blocks, profiling, viewing queries, transformations, code generation, and exports. Engine results must agree on semantic output while generated code remains idiomatic to the source engine. Polars adapters may use eager frames for notebook values and lazy scans/plans for files; they never convert through Pandas.

The extension host assigns stable public session IDs while each runtime owns replaceable internal IDs. Sessions serialize requests within a dataframe and run concurrently across dataframes. Requests carry the current revision; stale requests and responses are rejected. Closing an editor sends `closeSession`. A request timeout restarts the standalone runtime, while the coordinator recreates the source session and retries against its new internal ID. Notebook execution reacquires the stable kernel API after a restart.

Runtime discovery resolves an explicit `dataExplorer.pythonPath`, then the active Python extension environment, then system interpreters. It accepts Python 3.10–3.14 and probes only engine/format-specific modules. Missing packages produce a structured diagnostic; installation always requires a modal user confirmation.

## UI composition

The data grid is a custom readonly editor because opening and cleaning a source does not mutate that document. Data Explorer contributes native view containers for Operations, Summary, Filters/Sorts, Cleaning Steps, and Code Preview. A session coordinator publishes the active editor's state to these views and routes actions back to the correct runtime session.

Grid blocks are columnar and use stable row/column identities. Rows and columns are virtualized; summaries and insights load progressively for visible columns. Webviews use VS Code theme tokens, external assets, nonce-protected scripts, validated messages, and accessible grid/menu/form semantics.

## Persistence and compatibility

Serializable import options, viewing state, widths, and transformation steps are stored by source URI. Binary dataframe content is never persisted. Notebook sessions can only replay when their variable exists again.

Protocol v2 is the active internal contract. Notebook MIME v1 remains renderable so saved notebook output does not break; new helpers emit MIME v2.
