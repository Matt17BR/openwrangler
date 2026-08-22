# Shared protocol and operation instructions

This file applies to `src/shared/**`. Read the root policy first. A change implemented in an engine, host, or webview must also read that scoped owner. This file is the single normative owner for cross-language protocol and operation rules listed below.

## Owned invariants

<!-- OW-RULE:I05 -->
5. Every runtime request is versioned, validated, correlated, cancellable where possible, and safe to ignore when stale.

<!-- OW-RULE:I11 -->
11. Every operation change needs matching runtime and executable generated-code tests for every editing-capable engine. Generated categorical columns may not collide, and engine-specific null/Unicode/aggregate defaults must be normalized explicitly. Integer group sums and by-example arithmetic share the checked `-(10^38 - 1)..10^38 - 1` envelope; nullable wide Pandas values and decimal mean/median normalization require typed-page regressions. A missing-value fill never rewrites present cells: integer and decimal medians must fit the native type exactly, explicit decimal fills must fit its scale, datetime replacements must match its timezone awareness, and ordered fallback columns leave the original missing value when no candidate is present.

<!-- OW-RULE:I29 -->
29. All 31 operations that address input columns accept only public `{id, name}` references: row/order, structural, categorical/text/numeric/datetime, ordered fill-fallback columns, `groupBy` keys and aggregation inputs, and `byExample` source/program leaves. Transform filters/sorts remain a distinct stable-reference IR from name-addressed viewing queries. By-example inputs are ordered arrays aligned to source-reference order; name-keyed maps and legacy strings are invalid. The runtime binds each reference against the exact input schema and lineage to a private `{id, name, position}` before adapter dispatch; persisted steps and protocol metadata never expose positions. Unknown, stale, type/name-mismatched, malformed, or disallowed repeated identities, duplicate input-lineage IDs, output collisions, private row-identity names, and non-portable group/by-example type combinations fail closed. Repeated group aggregation inputs are valid when aliases are unique. Pandas live execution and generated code address bound inputs positionally under duplicate and non-string labels; Polars and DuckDB receive verified native names. By-example synthesis stays within 16 sources, 64 examples, 256 AST nodes, depth 64, 64 concat parts, 8 KiB per string, and 64 KiB total UTF-8 text, with budgets checked before synthesis and after canonicalization. There is no legacy/name fallback. Edited latest steps retain their IDs and derive globally unique outputs as `c:step:<stepId>:<created-output-ordinal>` so replay publishes the same lineage.

<!-- OW-RULE:I31 -->
31. The private row-identity namespace is case-insensitively unreachable from every public operation, including legacy string-based column parameters and aggregation aliases. Pandas must recognize its sentinel under flat and MultiIndex columns; DuckDB must reject schemas whose identifiers differ only by case before they can target the wrong stable column. Binding rejects explicit drop-all and the post-transform guard rejects dynamically empty encoders or custom code; immutable zero-column sources remain valid where an engine supports them. A webview may hold only one draft: every add-operation and edit-latest entry point stays disabled until apply/discard, the no-argument Add Cleaning Step command opens the generic operation picker, and a new draft diff uses the immediately previous committed schema while a replacement uses the recorded latest-step input schema.

<!-- OW-RULE:I32 -->
32. Every schema crossing the host/webview or runtime boundary has non-empty, unique column IDs and positions exactly `0..n-1`. This applies independently to active, latest-step-input, and applied-step inspection schemas; malformed kernel/runtime responses fail before entering session or UI state.

<!-- OW-RULE:I33 -->
33. Every live grid page is a required two-dimensional window. Open, page, preview, inspection, apply, discard, and undo requests carry bounded row and column ranges; each response carries the exact ordered stable column IDs aligned with every row value vector. Cache identity includes the resolved projection. Pandas projects by position, lazy Polars projects before collection, and DuckDB uses an explicit terminal select while still fetching the private row ID. Full-schema ARIA coordinates, filters, sorts, generated code, and exports remain independent of the transported projection. Saved MIME-v2 pages are full-width and must carry exact `columnIds`; malformed or partial captures fail closed because no live session can fetch omitted columns.

<!-- OW-RULE:I35 -->
35. Live engines, generated cleaning code, and saved notebook snapshots share `fixtures/view-literal-contract.json` for typed viewing values. Literal search and case-insensitive contains use portable ASCII folding while non-ASCII code points remain exact; Pandas semantic-string equality collapses equivalent numeric/boolean/decimal native values without collapsing display-equivalent strings, and ambiguous value labels round-trip only through a bounded versioned `TypedSelectionToken`. Text predicate values and selected scalar strings are capped at 65,536 Unicode code points by the canonical schema, TypeScript and Python decoders, and saved-snapshot model before engine-specific or arbitrary-precision coercion; webview predicate inputs truncate to the same code-point limit while their native HTML bound permits the maximum 131,072 UTF-16 code units. The notebook producer enforces its UTF-8 cap incrementally and may never allocate a complete oversized encoding merely to reject it. URI-addressed Jupyter lookup requires the captured `NotebookDocument` to be the sole open object for that URI before and after every await; cleanup still targets the exact dispatched kernel.

<!-- OW-RULE:I51 -->
51. Optional protocol-v2 text summaries belong only to semantic string columns and always include an exact non-negative empty-string count. Length statistics are either all present or all absent, exclude null and NaN values, count Unicode code points without trimming, and remain bounded by their exact minimum and maximum. A zero-length minimum is equivalent to a positive empty count; an all-empty column has only zero length statistics; and all-null text reports `emptyCount: 0` with no invented lengths. Pandas, eager/lazy Polars, DuckDB, and PySpark compute these values without dataframe-engine conversion. Lazy Polars, DuckDB, and PySpark return only fixed-size aggregate results; Pandas mixed-object and non-string categorical values use the exact normalized grid display as a native-frame fallback. Saved notebook snapshots use the same semantics over captured truth, and older v2 payloads may omit the block. A semantic string with a positive `nanCount` must still expose that count in Insights.

<!-- OW-RULE:I57 -->
57. Fill Missing Values uses stable column references for fallback columns, directional order, and grouped statistics.
    Grouped targets and keys must be distinct and type-compatible. Grouped fills never read the current viewing query,
    treat null and NaN grouping keys as one missing group, leave tied or undefined groups unresolved, preserve row order,
    and keep conservative nullable metadata. Linear interpolation accepts only a floating-point target and one distinct
    numeric, date, or date-time coordinate. Coordinates must be complete, finite, unique, and precise enough to retain
    their relative distance. It fills only bracketed runs between finite anchors, applies the optional whole-run limit,
    restores source order, and never uses viewing filters or sorts. R `integer64` and native 128-bit integer coordinates
    remain unsupported until their distances can be represented exactly.

<!-- OW-INSTRUCTIONS:EOF path="src/shared/AGENTS.md" sha256="4e60be43c096248e903d97d281a80c4af5ff9137af4ab16acd575251105efe56" -->
