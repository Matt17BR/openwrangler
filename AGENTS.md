# Open Wrangler agent guide

Open Wrangler is a VS Code extension with bundled Python and native R runtimes. Read this guide before changing the repository.

Open Wrangler was built independently. Use public documentation and behavior observable through public interfaces as references. Do not copy Microsoft Data Wrangler code or assets, and do not inspect or retain Microsoft Data Wrangler package contents.

## Architecture map

- `src/extension/` owns VS Code APIs, commands, editors, notebook integration, sessions, and runtime processes.
- `src/shared/` owns versioned protocol types and behavior shared by the extension and webviews.
- `src/webviews/` owns the React UI. It must remain independent of Node APIs.
- `python/openwrangler_runtime/` owns Python dataframe engines, queries, transformations, profiling, code generation, and export writers.
- `r/openwrangler_runtime/` owns the native R frame boundary and R execution. R dataframes never route through Python.

Keep behavior in its owning layer. Change a shared interface explicitly instead of reaching across a boundary.

## Sources of truth

- `docs/architecture.md` defines product boundaries, protocol and session behavior, engine rules, persistence, and security-sensitive invariants.
- `docs/decisions/0001-native-r-runtime.md` defines the native R boundary and its supported execution paths.
- `docs/feature-parity.md` records supported user-visible behavior and release evidence. `docs/product-roadmap.md` records priorities and deferrals.
- `docs/reference.md` is generated from public interface registries. Never edit it by hand.
- `docs/testing.md` owns source suites, editor scenarios, artifact rules, and test ownership. `docs/ci.md` describes hosted checks.
- `docs/releasing.md` owns packaging, versioning, qualification, publication, and recovery.
- `docs/performance-comparison.md` owns the Data Wrangler comparison method and reviewed results.
- `docs/writing-style.md` owns public, issue, pull request, commit, and release prose.
- `CONTRIBUTING.md` provides setup and contribution commands. `SECURITY.md` defines supported security releases and private reporting.

Read the owning document before changing its boundary. Link to it rather than copying its detailed contract into another file.

## Repository-wide safety rules

- Treat pre-existing dirty and untracked files, including `scratch.txt`, as user-owned unless the task explicitly assigns them. Do not edit, delete, stage, package, or clean unknown work. Leave unknown directories and worktrees alone. Keep agent notes and temporary housekeeping outside the repository.
- Keep dataframe work engine-native. Polars must not convert through Pandas. DuckDB must not convert through Pandas, Polars, or Arrow. PySpark is a bounded, viewing-only live-notebook backend: do not use `toPandas()`, `toArrow()`, unbounded `collect()` or iteration, or a local dataframe engine. Native R must not route through Python.
- Viewing filters and sorts do not modify the cleaning plan or source. Open Wrangler never overwrites source data. Export uses an explicit, separate destination and atomic replacement.
- Python or R execution, dependency installation, custom code, and exports require Workspace Trust. Preserve existing confirmation, source, and destination checks; test hooks may not bypass the production safety path.
- Validate data and messages at every process and webview boundary. Runtime requests are versioned and correlated; stale results are ignored. Mutations publish as one confirmed state or restore the previous state.
- Bind asynchronous work to the exact source and execution or session owners that started it—backend, interpreter, kernel, R terminal, or document as applicable. Do not recover provenance from whichever editor, notebook, or runtime happens to be active after an await. Cleanup targets only owned resources; engine cleanup hooks run at most once.
- Keep pages, profiles, notebook captures, transport values, and diagnostics bounded and strict-JSON-safe. Schemas crossing runtime, host, or webview boundaries use stable, unique, non-empty column IDs and contiguous positions. User-derived keys belong in `Map` or `Set`, not object properties.
- Webviews use a restrictive CSP, same-origin validated messages, VS Code theme tokens, accessible names, and keyboard navigation. They do not read files, execute dataframe code, or use Node APIs.
- Generated cleaning code and live execution must agree. An operation change needs executable runtime and generated-code coverage for every editing-capable engine that supports it, including null, type, identity, and collision behavior relevant to that operation.
- Diagnostics and test artifacts must not contain credentials, private keys, user data, raw profiles, workspace storage, or unrelated logs. Follow the allowlist in `docs/testing.md`.
- Do not claim feature-parity completion or backend support beyond the current evidence in `docs/feature-parity.md`.

## Making changes

- Preserve unrelated changes. Give each commit one reviewable purpose, with its directly related tests and required documentation.
- Reuse existing registries and validators instead of creating a second source of truth. Follow `docs/testing.md` for test ownership; do not add an overlapping end-to-end journey.
- Use the narrowest existing check while iterating. Run broader source or installed-editor coverage only when the change crosses that boundary. Do not make deterministic failures green with retries or larger deadlines.
- Keep generated files generated. Run the owning generator and commit its output; do not patch generated output to hide drift.
- Write public text as a maintainer describing a concrete result. Follow `docs/writing-style.md` and give the finished text an editorial read.

## Documentation routing

- Protocol, session, runtime, engine, persistence, or security-boundary changes update `docs/architecture.md` and the owning executable tests.
- Native R producer, decoder, supported-frame, or execution changes also update `docs/decisions/0001-native-r-runtime.md`, `docs/feature-parity.md`, and `docs/testing.md` as applicable.
- User-visible capabilities, operations, exports, entry points, and limitations update `docs/feature-parity.md` and the relevant `README.md` or `CHANGELOG.md` text.
- Commands, settings, operations, protocol messages, and notebook MIME types require `npm run generate:reference` and the resulting `docs/reference.md` change.
- Test commands, fixtures, and editor scenarios update `docs/testing.md`. Hosted CI ownership or job changes also update `docs/ci.md`.
- Package contents, versions, channels, qualification, publication, and credential requirements update `docs/releasing.md` and the release-facing records it names.
- New third-party runtime code or bundled assets update `THIRD_PARTY_NOTICES.md` and require license verification.

## Release boundary

Land product, test, media, and ordinary documentation changes before the release change. A release change contains only version and channel metadata, changelog, checked-in release notes, and required release metadata.

Qualification and publication are separate. Build the candidate once, preserve its recorded artifact set and provenance, and never rebuild, replace, or retag it after qualification begins. Follow `docs/releasing.md`; do not infer a release process from old workflow history.
