# Repository tooling and acceptance instructions

This file applies to `scripts/**`. Read the root policy first. Workflow changes also require `.github/AGENTS.md`; changes to documented commands or evidence boundaries require `docs/AGENTS.md`. Harnesses prove only the seam they execute.

## Owned invariants

<!-- OW-RULE:I15 -->
15. Visual baselines and axe acceptance use the lockfile-pinned Playwright Chromium plus deterministic Liberation Sans/Mono harness tokens. Install Chromium with `npx playwright-core install chromium`; do not silently fall back to a moving system browser or distribution font. CI must retain actual/diff artifacts on failure. On POSIX, axe runs keep browser data in their private workspace root and expose only its temp directory through a mode-0700, short-lived `/tmp/ow-a11y-*` symlink so Chrome's singleton socket stays below the Unix path limit; nested cleanup must remove both paths.

<!-- OW-RULE:I37 -->
37. On Linux, native VS Code/Cursor acceptance uses zero-window headless Ozone by default, removes desktop/editor IPC and credential routes, disables updates and telemetry, and owns one mode-0700 `tmp/ow/x-*` root for profiles, workspace copies, runtime files, and temporaries. It must never fall back to the current desktop, shared system temp, normal editor profiles, or the repository workspace. Cursor may retain only the session-bus address required for GTK startup. Visible runs require the explicit `OPEN_WRANGLER_EDITOR_DISPLAY=current` debugging opt-in; Xvfb is an isolated compatibility fallback. Cleanup happens only after editor/display ownership is proven; uncertainty leaves the private root in place for manual inspection.

<!-- OW-RULE:I40 -->
40. Native editor phases keep a 300-second hard deadline and a 180-second changed-checkpoint inactivity deadline. They publish exclusive atomic progress/results under a strict per-phase `protocol`/`runId`/`phase` envelope, pin each result's first-observed file identity through the final read, classify every failure with editor/version/phase/exit context, and never retry automatically. Major extension-host checkpoints use bounded, exclusive, randomized, no-follow sibling temporaries; a publication or identified-temp cleanup error fails the test. Phase stdout/stderr is captured under fixed bounds, discarded on success, and redacted before failure reporting. Editor CLI, workbench, and private-display processes inherit only the explicit platform/isolation allowlist plus runner-owned test values; unrecognized, credential-bearing, and authenticated-proxy variables never reach them. A late `ChildProcess` error may never impersonate exit, and downloader, editor, or display ownership uncertainty must propagate. POSIX launches own a process group. Windows launches own a kill-on-close Job Object through the strict parent-leased supervisor; its random job-empty attestation is absent from the target environment, emitted exactly once only after `ActiveProcessCount == 0`, and required before phase contents or full evidence may open. Attestation ambiguity latches permanently, its correlated control marker is removed before stderr accounting or diagnostics, and a Windows-owned launch with non-piped stderr is rejected before spawn. The runner closes the supervisor's control stdin on every settled path. Native Windows CI must compile the real supervisor and prove natural descendant containment, forced termination, and malformed-frame rejection. If any editor/display ownership cannot be verified, restore the caller environment from captured lexical values only, publish no diagnostic artifact or output path, and do not stat, canonicalize, open, read, traverse, or remove any inherited private runtime/root/profile/result/progress/log path. Package discovery, display setup, installation, phase, and cleanup failures retain diagnostics before verified private-root deletion; cleanup faults use an explicit `cleanup` phase that records the originating phase. Full evidence inputs are source-count, scan-byte, and per-file bounded, use one verified descriptor, and fail closed on non-regular files, hard links, identity changes, containment changes, private-key material, or redaction failure. Only the redacted allowlist documented in `docs/testing.md` may survive in one receipt-bound, re-redacted, sealed JSON artifact outside the prelaunch staging root. A detected pre-close failure must flush a zero-length scrub through the still-owned descriptor before close; a close error reported after that descriptor is already closed may remove only its still identity-matching path. A successful artifact captures its authoritative post-close snapshot in a frozen path/parent/file-identity/size/SHA-256 receipt and is revalidated immediately before `GITHUB_OUTPUT`. CI uses a fresh randomized parent below `RUNNER_TEMP` (mode 0700 on POSIX), uploads only the exact emitted non-glob path in the immediately following step, and retains failure-only artifacts for seven days; local failures print and retain their exact repository-`tmp` path without sweeping prior untracked bundles. Because `actions/upload-artifact` is pathname-only, the GitHub runner and pinned action are trusted after editor/display tree-empty attestation, and arbitrary same-UID post-attestation interference, including the narrow interval after final receipt validation, is explicitly outside the threat model. Raw profiles, settings, storage, databases, arbitrary logs, and secrets must never enter artifacts, and no evidence is created on success or ownership uncertainty.

<!-- OW-RULE:I41 -->
41. Release-candidate installed-performance evidence consumes exactly one `openwrangler.vsix`, its exact lowercase SHA-256 checksum, and `openwrangler.vsix.provenance.json` from the same trusted canonical-packaging job. A checksum alone is not source provenance. The bounded provenance receipt binds the extension identity/version, release tag, exact source commit, and VSIX digest/size to `EXPECTED_SHA` and `RELEASE_TAG`; the runner never rebuilds the production VSIX, builds only the acceptance harness, and revalidates all three inputs throughout the run. Candidate consume mode uses the fixed local VS Code executable/CLI pair and may never download a moving editor channel. Cursor performance is not a release gate; the separately pinned Cursor lifecycle/responsive-grid/reveal-state seam owns fork compatibility without repeating semantic or performance matrices. The release-candidate workflow passes the exact uploaded artifact ID to the protected Linux reference runner. A passing path-free report is retained for 90 days. A complete report that fails exclusively on validated numeric thresholds may be retained as one distinct seven-day failure artifact only after its path-free schema, candidate set, and final sealed report receipt are revalidated; structural, mixed, cleanup, ownership, candidate, report, output, or privacy uncertainty emits no failure artifact, and candidate bytes are never included. Its complete ordered steps and every external action revision are an exact allowlist.

<!-- OW-RULE:I48 -->
48. Native **Change Import Options** prompt acceptance treats workbench visibility and keyboard focus as separate asynchronous states; the primary CSV/TSV launch remains prompt-free and uses automatic detection. Before any keyboard navigation, fill, acceptance, or cancellation in the explicit advanced flow, acceptance must use the complete existing 10-second workbench budget to poll for the editor's natural DOM focus transfer without calling `focus`, clicking, or sending input through a locator that would assign focus. A prompt that never receives focus remains a hard failure; retained diagnostics may contain only bounded structural active-element metadata and never input values, labels, or user text. For a final InputBox whose acceptance can immediately replace the active editor, genuine key-down and key-up CDP commands are queued back-to-back before either acknowledgement is awaited; both must settle under the unchanged Node-owned operation deadline.

<!-- OW-RULE:I49 -->
49. Native notebook-renderer discovery is observation-only. Under the remaining 30-second discovery budget, each exact-preview/role/name probe may inspect only presence, visibility, and enabled state under its own Node-owned deadline; it must not scroll, focus, click, or wait for pointer-style layout stability. Only proven-retired auxiliary pages or detached child frames may be skipped; workbench closure, CDP disconnection, detached workbench main frames, and all live-target failures fail closed. The provenance scenario must reassert the exact other notebook remains active immediately before dispatching the separately recorded DOM action from the origin renderer. Missing, hidden, disabled, disconnected, or nonfunctional actions remain hard failures, and timeout diagnostics are target-count-bounded structural state only. It never includes URLs, labels, rendered text, cell values, or other user-derived content.

<!-- OW-RULE:I52 -->
52. The Data Wrangler comparison uses official VS Code, public notebook/workbench controls, synthetic fixtures, and the exact Marketplace baseline `ms-toolsai.datawrangler@1.24.2`. Microsoft package contents remain opaque: never open, hash, archive, retain, or upload them. Run one isolated session per product and Pandas/Polars CSV/Parquet workload, with ten warm UI samples in each session. Report median and type-7 p95, but gate only material median regressions. Measured product failures and timeouts are immutable; only harness-aborted sessions may be replaced. PSS evidence needs at least two samples and no gap longer than one second. The smoke runs two samples for both products on the Pandas/CSV workload; its timings are not evidence and cannot support a speed claim. The real-product smoke and study are release-candidate work, not ordinary pull-request CI.
    The comparison session is the sole exception to invariant 40's ordinary phase limit and may use 600 seconds for its ten timed samples; the 180-second inactivity limit still applies.

<!-- OW-RULE:I58 -->
58. CI red must have one narrow owner: a product regression, real editor/runtime/platform compatibility regression,
    violated package/release invariant, deterministic prerequisite failure, or explicitly classified external-
    infrastructure outage. Interpreter, dependency, browser, display, and private-profile prerequisites fail before
    product/editor/visual assertions and never fall through to ambient PATH or desktop state. One comprehensive
    end-to-end owner proves each behavior; every additional editor, operating system, transport, or registry lane must
    name a distinct seam or be removed. Pull requests own source, coverage, workflow-contract, browser-baseline, and
    harness-adversarial suites; release candidates consume the immutable artifact and prove only installed
    compatibility, external integrations, performance, cleanup, provenance, and publication. Do not respond to
    nondeterminism with an automatic retry, a larger deadline, or another orchestration layer. Fix, isolate, replace,
    or delete the check. The rolling last ten first-attempt candidate failures must contain at least nine product,
    genuine package/release-invariant, or real dependency/platform signals; a second failure from the same
    harness/runner cause blocks another release attempt until that gate is repaired or simplified.

## Disposable checkouts

Use one temporary clone or worktree outside this repository for each bounded task. Record its absolute path in the
active task notes, remove it immediately after the branch is pushed or the task is aborted, and verify that it is gone
before handoff. Never add checkout-manager or worktree-lifecycle code to the extension repository. Never remove an
unknown or user-owned directory; leave it alone when ownership is uncertain.

## Required checks

Run the narrowest relevant tests while iterating. Open or update a pull request only for a coherent, locally green
slice, then use its exact-head hosted matrix as the authoritative broad gate. Do not repeat the complete local test,
package, media, and editor stack merely because a pull request is about to open; that duplicates hosted evidence,
slows the feedback loop, and can exhaust the developer machine without improving the accepted result.

Do not run memory-intensive local suites concurrently. Coordinate that in the active task instead of adding locks,
leases, process managers, or other operator machinery to this repository. Run the complete serial list below for a
release candidate or when a change genuinely spans every listed boundary;
otherwise run `npm run check:pr`, the focused tests for the changed owner, and the relevant UI/editor scenario. Hosted
pull-request CI requires every lane selected by its path classifier before merge. Release-only consumers run later
against the protected release candidate; they are not default pull-request jobs.

```bash
npm run check:pr
npm test
npm run test:extension-host
npm run test:webview-acceptance
npm run test:coverage
npm run license:check
npm run benchmark:runtime # required for performance/runtime changes and release candidates
npx playwright-core install chromium # before local visual capture/verification
npm run clean
npm run build
npm run capture:screenshots # for visible changes
npm run package -- --out openwrangler.vsix
npm run verify:vsix -- openwrangler.vsix
npm run test:packaged-editors -- openwrangler.vsix
```

Changes to `r/openwrangler_runtime/`, its decoder, or its packaging rules must also run `npm run test:r-contract`. The hosted full matrix repeats that contract on R 4.4 and 4.5.

For editor-facing changes, also complete the relevant scenarios in `docs/testing.md` in both VS Code and Cursor using isolated profiles.

<!-- OW-INSTRUCTIONS:EOF path="scripts/AGENTS.md" sha256="940d19ec3048a4f86bec9a5b0587f5896483d94d0319597b8f8bfccc9b6e26bb" -->
