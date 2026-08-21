# Webview instructions

This file applies to `src/webviews/**`. Read the root policy first. Shared messages and schemas require `src/shared/AGENTS.md`; host lifecycle and command work requires `src/extension/AGENTS.md`; visual and installed acceptance requires `scripts/AGENTS.md`.

## Owned invariants

<!-- OW-RULE:I07 -->
7. Webviews use VS Code theme tokens, a restrictive CSP, same-origin validated messages, accessible labels, and keyboard navigation. User-derived keys belong in `Map`/`Set`, never dynamic object properties.

<!-- OW-RULE:I13 -->
13. Cleaning-plan shortcuts must be state-scoped, mirrored inside the webview, documented in the generated reference, and tested without intercepting editable-field undo.

<!-- OW-RULE:I20 -->
20. Runtime and webview mutations publish atomically. A failed preview/apply/discard/undo restores revisions, plans, drafts, metadata, page/cache state, code, selected column, and progressive-profile ownership to the last confirmed snapshot.

<!-- OW-RULE:I30 -->
30. Webview build assets must use bundle-relative URLs and the webview CSP must allow their exact origin. In particular, the packaged Codicon font must resolve beside `webview.css` and `font-src` must allow `webview.cspSource`; an absolute `/codicon.ttf` URL or blocked font is a release-blocking visual defect. Browser baselines must exercise the actual production CSS and font asset.

<!-- OW-RULE:I44 -->
44. A successful webview `postMessage` is not renderer hydration. Recreated or delayed renderers use finite visibility-aware snapshot pulls until the matching replay marker commits; the host publishes one fresh opaque completion marker only after the retained snapshot/error, presentation, view state, import response, and busy state, and accepts only the exact acknowledgement emitted after React commits that replay. Native import-option actions use a separate opaque correlation ID with one bounded host fallback; manual and correlated intents coalesce, every preparation path first flushes pending view state, and stale, busy, or late renderer responses must never lose or duplicate the transaction. Concurrent native commands share one renderer request and transaction, and remain pending through that exact prepared transaction so editor focus restoration cannot overtake an open QuickInput. Every delayed or post-commit webview focus restoration must prove `document.hasFocus()` both when it retains focus ownership and immediately before calling `focus`; losing host focus cancels that restoration instead of reclaiming it from a workbench QuickInput or another editor surface.

<!-- OW-INSTRUCTIONS:EOF path="src/webviews/AGENTS.md" sha256="ebc7935c1046e07ab3067a089106ac6b8a3cb5ab4f960cabc5a091f42987818e" -->
