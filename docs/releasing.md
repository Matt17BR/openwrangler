# Releasing

## Current release train

Open Wrangler has three deliberately separate paths. None depends on a 1.99.7 release event.

1. `.github/workflows/daily-preview.yml` produces a tagless, disposable build from protected `main` each day. It
   assigns a source-derived `0.<odd>.<patch>` identity that cannot equal the checked-in release version, runs the
   authoritative pull-request checks plus one representative installed-VS-Code seam, and retains the exact
   VSIX/checksum/provenance triple for 14 days. It does not create a tag, GitHub Release, or registry publication and
   is not a release candidate.
2. `.github/workflows/release-candidate.yml` is a manual, nonpublishing qualification run. A first-attempt dispatch
   from protected `main` validates stable metadata, packages one canonical triple, and reuses its numeric artifact ID
   across VS Code, one pinned Cursor lifecycle/responsive-grid seam, Python/Jupyter, R 4.4 and 4.5 compatibility,
   installed performance, and Remote SSH. It retains the candidate and bounded qualification manifest for 21 days;
   failure diagnostics are failure-only and no job has write permission or a publishing environment.
3. `.github/workflows/stable-release.yml` accepts only `candidate_run_id` and `release_tag`. Its read-only selector
   requires a successful first-attempt candidate completed 168–336 hours earlier, rejects a newer successful
   candidate for the same tag, and requires the candidate, manifest, and performance artifacts to remain unexpired.
   The protected `publishing` job checks out the historical candidate source, downloads those exact numeric artifact
   IDs from that exact run, and revalidates source, bytes, checksum, provenance, performance, and manifest. It never
   builds or packages. The existing fail-closed tag, GitHub Release, Open VSX, and public-media transactions then
   promote the same VSIX bytes.

Do not rerun a failed candidate: create a new first-attempt candidate from the corrected protected `main`. A source
change, artifact expiry or replacement, manifest mismatch, failed owner, soak outside the window, public-byte
conflict, or newer same-tag candidate invalidates promotion. Before public promotion, rollback means selecting no
candidate at all; after a tag or registry write, recovery is verification-first and must never rebuild, retag, or
overwrite conflicting public bytes. The retired 1.99.x preview inspectors remain only for historical recovery tests;
they are not a current publication entry point.

## Release copy

Write `docs/release-notes/<version>.md` in the release pull request and review it with
[`docs/writing-style.md`](writing-style.md). The GitHub publisher reads that file from the tagged commit and disables
generated release notes. The automation guarantees the source of the text, not that a person reviewed it. Keep
detailed acceptance proof in this document and `docs/testing.md`; release notes should
tell users what changed and mention only the limits they need to act on. Pull request titles still need a plain,
specific description because people read them in the repository history.

## Version policy

Numeric `0.<odd-minor>.x` releases are the historical preview bands, and numeric `1.99.x` is reserved for Open
Wrangler 2 previews. Both require `package.json.preview` to be `true`; other numeric versions require it to be
`false`. The workflows use the same rule, so stable and preview metadata cannot be mixed.

Every future release candidate starts from the exact protected `main` head. Stable publication promotes that
candidate's already-qualified bytes after the bounded soak; it never rebuilds them. Releases through v1.2.2 predate this branch policy. Automatic `main`
recovery ignores them; an operator may recover one explicitly from its immutable tag, but never rebuild or retag it.
Update `package.json`,
`python/openwrangler_runtime/version.py`, `CHANGELOG.md`, and parity evidence in the release pull request. Do not put
the release channel in a hyphenated manifest version.
Do not include product code, test-harness changes, generated media, or unrelated documentation in the release commit.

The GitHub About description, homepage, and topics live in `.github/repository-metadata.json`. Its homepage points to
the Marketplace. The package description must match it, while the package homepage points to the project README so
the Marketplace and Open VSX Resources links do not loop back to a registry. Run `npm run repository:check` after
editing either file, apply the reviewed metadata to GitHub, then run `npm run repository:check-live`. Candidate
qualification runs the complete checked-in PR contract before packaging, and stable public verification remains
fail-closed against the exact historical source and public payload.

## Package gate

```bash
npm ci --ignore-scripts
python3 -m venv .venv
.venv/bin/python -m pip install -e "python[dev]"
.venv/bin/python -m pip install "pandas>=2.2,<3.0" "pyspark[connect]==4.2.0"
npm run check
npm test
npm run test:extension-host
npm run test:webview-acceptance
npm run package -- --out openwrangler.vsix
npm run verify:vsix -- openwrangler.vsix
npm run test:coverage
npm run license:check
npm run benchmark:runtime
npm run test:packaged-editors -- openwrangler.vsix
sha256sum openwrangler.vsix
```

The coverage gate requires a Java 17 runtime on `PATH`. Required pull-request coverage provisions Temurin Java 17,
exact PySpark 4.2.0 Connect extras, and compatible Pandas before running the unchanged Python coverage floor. Release
candidates consume the protected commit and exact VSIX after that merge gate; they do not rerun source
coverage. Their packaged PySpark journey still provisions Java 17 because that is installed-product evidence. An
optional adapter may skip in an ordinary development test run, but it may not disappear from pull-request coverage.

Repository development and automation use exactly Node.js 22.22.0 from `.node-version`; that release supplies the
declared npm 10.9.4 package manager. GitHub workflows consume the version file directly. Azure Marketplace recovery
duplicates the same exact Node value because it may inspect historical tags that predate the file, and workflow
contracts keep that duplicate synchronized. The development pin remains repository tooling and is excluded from the
VSIX. `npm run check` includes the strict dependency-only TypeScript graph, and `npm run audit:node` audits the full
development tree.

Every repository, CI, candidate, packaging, promotion, and release install uses `npm ci --ignore-scripts`; `.npmrc`
makes the same boundary the contributor default. `npm run check:install-policy` inventories all 28 executable
install invocations across 26 owners in 11 GitHub and Azure automation files and rejects any unowned or plain install, lifecycle re-enablement, rebuild, package-manager alias, dynamic
install, or lock entry with `hasInstallScript`. The lock has no native `keytar` or `prebuild-install`. A tracked
fail-closed credential shim selects VSCE's existing file/PAT path, while a script-free signing bridge resolves only
the exact lockfile-authenticated `@vscode/vsce-sign-*` package for the current platform. Missing platform bytes
fail locally; there is no npm, direct-download, or native-compilation fallback. The bridge preserves canonical
programmatic VSCE packaging and noninteractive signature manifest/archive operations without changing registry
credentials or publication commands.

The package command derives `--pre-release` from the validated numeric version and explicit `package.json.preview`
value. Preview metadata receives exactly one prerelease flag; stable metadata rejects any caller-supplied prerelease
override. `npm run verify:vsix` rejects either channel when its VSIX manifest and packaged `package.json` disagree.

Ordinary product packaging now pins the complete VSCE package-source set before invoking the lockfile-owned
programmatic VSCE API. VSCE writes only a raw candidate inside a random directory beside the requested destination:
current-user-owned with mode `0700` on POSIX, and governed by Windows' coarser identity-pinned writable host contract,
with GitHub issue linking disabled. Packaging then repins the sources, validates the raw inventory and every source
digest, canonicalizes the files-only archive, repins again, and repeats inventory and digest validation. The canonical
ZIP uses bytewise UTF-8 entry order, STORE for every file, fixed 1980 timestamps, exact `100644` file modes, and no
comments or extra fields. STORE is an ordinary ZIP method, so existing VSIX readers remain compatible. The deliberate
size tradeoff is an approximately 5 MB canonical package instead of the current approximately 1.2 MB compressed form.
Canonicalization changes only container metadata and compression: every entry name, byte count, digest, and
uncompressed byte remains identical.

The package-source transaction also builds and validates a portable, versioned in-memory manifest binding each VSIX
entry to its tracked or generated source path, portable mode (Git-derived for tracked sources and fixed for generated
sources and VSCE metadata), byte count, and SHA-256; the two VSCE metadata entries are represented explicitly. That
manifest is an internal reproducibility proof only. It is not written into the VSIX,
uploaded as an artifact, added to release provenance, or published to a registry. The complete canonical candidate is
written exclusively, flushed, closed, and validated in the private sibling. Its host file is mode `0644` on POSIX;
Windows uses its writable regular-file bit while the canonical ZIP modes remain exact on every platform. Publication
uses one atomic no-clobber hard link, verifies the exact temporary/output two-name transition, retires the private
name, flushes both directories, and requires the public file to have exactly one link before and after final
canonical/source validation. Destination, parent, raw-candidate, source, write, link, retirement, substitution, or
cleanup uncertainty fails. On failure, the exact produced public inode is removed only while its identity remains
attributable; a substituted or otherwise unknown path is retained and reported as cleanup uncertainty rather than
being deleted. Disposable nonpublishing previews from protected `main` may exercise this path. A future release
candidate requires explicit review, a soak of those same bytes, and a separate one-shot promotion.

This foundation does not change the checksum/provenance triple, release readiness, or publication policy.

The opt-in installed-editor performance runner uses the same bounded duplicate-key-rejecting channel policy and
retains the channel in its checksum-bound report. After its clean build, every VSCE package source must be either
Git-tracked or one of the exact generated outputs: compiled `dist` paths are derived only from tracked production
TypeScript, and `media` uses a fixed nine-file registry. The runner pins every tracked and generated package input's
no-follow single-link identity, size, and SHA-256 before `createVSIX`, requires the same receipts afterward, and
matches every digest to the sealed archive while also requiring the complete archive inventory to equal the
pre-package VSCE list. Ignored or nonignored extras, transient or restored source rewrites, altered generated bytes,
missing generated outputs, and a file introduced only while `createVSIX` runs therefore fail closed. Excluded user
files remain outside the VSCE inventory and are never opened, changed, or packaged. The runner seals the mutable
package output before running the full inventory/content verifier against shared descriptor-bound snapshot bytes.
Editor installation revalidates that receipt at the actual CLI spawn boundary and after exit. Final publication opens
and pins the report, revalidates the candidate while that report descriptor remains open, completes report
verification, and then revalidates the candidate once more; a report validator that cannot expose this joint read
window fails closed. Stable intake never invokes that self-package path.

The only vendored extension-host runtime is `dist/extension/vendor/js-yaml.js`, copied from the reviewed js-yaml
5.2.3 CommonJS entrypoint during production and test builds. Its generated package-source receipt is exactly 122,488
bytes with SHA-256 `f1499c20ab232a283f6f9f85aeecc99dceab175e8dd4005bd3d764848f3e5965`. The VSIX inventory
requires `extension/dist/extension/vendor/js-yaml.js`, rejects every other file in that vendor directory, captures
the entry under its exact bound, and independently verifies the same size and digest. When historical verification
permits the entry to be absent, a present entry still has to match that receipt. Omission from a current package, mutation, stale
generated output, or a package-only addition blocks canonical authoring. js-yaml remains a development dependency;
`npm run license:check` pins its source runtime and upstream LICENSE bytes and requires the full Vitaly Puzrin MIT
notice in `THIRD_PARTY_NOTICES.md`.

Both extension builds reconcile the compiler-emitted static CommonJS dependency graph after staging that asset.
Current product output may retain only the exact host `vscode` specifier, while the Remote acceptance output may
also retain exact `playwright-core`; local edges must remain inside the compiled root and resolve uniquely. The VSIX
verifier repeats the same graph check over the captured packaged module bytes. This inventory is deliberately scoped
to generated static dependencies and does not present itself as a JavaScript sandbox for reviewed runtime behavior.

The release-candidate package job writes the canonical VSIX exactly once, verifies its allowlist, and uploads only
the VSIX/checksum/provenance triple. Candidate acceptance and Remote SSH consume that artifact ID in parallel. The
qualification fan-in writes one bounded manifest after all owners succeed. Stable promotion later downloads that exact triple
and manifest from the selected candidate run; it never invokes readiness packaging or invents provenance.

Candidate Python-Jupyter acceptance uses one explicit integration-only ownership profile. VS Code owns consent denial,
the complete allowed Variables/renderer journey, PySpark, and remote Python. It does not repeat the ordinary restricted-workspace,
Python-environment, seed, verify, or generic packaged setup phases already owned by Linux packaged-editor acceptance.
Unset and manual packaged runs keep their complete prior editor matrix.

Protected pull-request CI owns the direct R 4.5 contract, while scheduled/manual Cross retains direct R 4.4
evidence. Candidate qualification installs the same canonical VSIX against both R 4.4 and R 4.5 platform seams.
VS Code owns the R operation semantics; Cursor does not repeat the R catalog. Stable promotion accepts that evidence only
through the sealed candidate manifest.

The source now includes a diagnostic `benchmark:r` command and the bounded
`openwrangler-native-r-performance-report-v1` contract. It consumes one exact canonical VSIX/checksum/provenance
triple only from the exact clean tracked checkout named by its required `EXPECTED_SHA` and `RELEASE_TAG` bindings.
Those values must equal the strict provenance; the tracked harness blob and bytes are bound into the report as well.
On the Linux reference platform it binds a deterministic 250,000×20 mixed fixture and retains, at both direct
packaged-frame and owned-kernel boundaries, five fresh samples plus twenty each for 200×16 projected pages, compound
filters, cached stable multi-key sorts, and eight-column summaries; the first uncached sort is retained separately.
Untimed controls prove exact dataset statistics, the greater-than-one-million-row sampled-summary seam, and keyed
`data.table` frame class/key, stable identities, supported S3 column metadata, and source-byte preservation. All
raw samples and the exact kernel schedule of 86 measured plus 13 control responses remain in the report with path-free
machine, Node, R, executable-digest, package, resource, session, child-process, and private-root cleanup provenance. It
never trims or retries a sample. Its 300-second owned-process deadline is lifecycle safety, not a performance limit.
One separately owned `Rscript` probe resolves and pins the caller's effective libraries before the seven measured
children run with private HOME and explicit library authority; only the path-free discovery protocol/count/proof is
public. Probe, direct, five fresh-kernel, and workload cleanup therefore account for exactly eight owned processes,
independently of the response and session counts.

This v1 infrastructure is intentionally non-promotional: `releaseGate` is always false, it defines no numeric release
threshold, and readiness does not consume its output. A subsequent reviewed change must define how an immutable
release-candidate run authors the required R performance record and resolves the stable-source/candidate circularity
without reusing, rebuilding, or blessing a diagnostic candidate. Until that record and the installed all-32 evidence
exist, no 2.x stable source is ready.

Every candidate core cell runs that same Clone lifecycle; Linux VS Code retains all-block grid depth, while macOS and
Windows VS Code retain representative single-round-trip grid/profile/view seams within the same
hard deadline. Explicit candidate core disables native-frame and embedded-restart work on every platform. A fresh
`value-operations` invocation owns exactly Find and replace, Formula, Format Datetime, Min-max scale, Round, Floor, Ceiling,
Capitalize, Lowercase, Uppercase, Strip text, and Split text as its targeted slice. A fresh
`categorical-operations` invocation owns exactly the One-hot encode and Multi-label binarize visible-form,
boundary-value, generated-call, preview, apply, and undo journeys as its targeted slice. Candidate-only
`core-operations`, `value-operations`, and `categorical-operations` do not duplicate the native-frame scaffold. A fresh
`native-frames` invocation makes Linux VS Code the comprehensive collapse/viewing and native tibble/data-table
Rename/Drop owner. macOS and Windows retain the representative tibble-Rename and keyed-data-table-Drop seams. Linux VS Code owns the full value and
categorical installed catalogs. The one Cursor compatibility invocation covers lifecycle, responsive-grid, and reveal-state behavior rather than R phases. Installed journeys still validate the advertised operation
registry at their integration boundary, but direct suites own exhaustive operation semantics. Explicit candidate
core omits embedded restart on Linux, macOS, and Windows because a separately verified `kernel-restart` invocation owns
restart/reopen on each platform. Focused native, value, and categorical selectors are restart-free. The candidate is
verified again before fresh phases cover the active R terminal, then once more before fresh phases cover plain `.R`,
`.Rmd`, `.qmd`, and Python Quarto. Ordinary `.qmd` acceptance owns the Open Wrangler title action plus exact
session/source/code/cleanup, not Quarto's third-party preview lifecycle; only Linux media capture owns one bounded
preview and cleanup through the exact prefixed `TabInputWebview`. macOS retains plain `.R` in the core invocation, and
Windows skips direct R documents.
Direct R/runtime/webview suites retain the complete R operation and document matrix. The release-candidate workflow
invokes the shared acceptance workflow through one non-matrix caller; stable promotion consumes its sealed result without rerunning it. The reusable workflow owns fixed
parallel Python, remote-R, generic-platform, `r_platform`, performance, and Linux local-R jobs, and all
candidate consumers download and semantically reverify the same VSIX. The producer is the sole owner of the full
`verify:vsix` inventory/content proof. Each consumer freshly checks the canonical checksum, provenance, and archive
semantics immediately before use instead of repeating that verifier. The generic macOS/Windows platform matrix owns
only packaged VS Code `platform-smoke` compatibility without rerunning the pull request's extension-host suite or
preparing R. Linux VS Code owns the full generic packaged journey; one pinned Linux Cursor run owns the focused fork-
compatibility smoke instead of multiplying the same seam across operating systems. Each
separate `r_platform` cell prepares R once, then
runs freshly verified VS Code-only `core-operations`, `native-frames`, and `kernel-restart` phases, with distinct
immediate uploads followed by an exact three-outcome verdict. Linux local R is a two-cell non-cancelling shard matrix:
lifecycle runs `core-operations`, `kernel-restart`, `interactive-terminal`, then `literate-documents`; editing runs
`native-frames`, `value-operations`, then `categorical-operations`. Setup is shared only within a shard or platform
cell. Every phase freshly verifies the exact candidate immediately before a fresh requested-editor invocation with
private roots, then immediately exposes only its distinct sealed failure diagnostic. Each cell defers its raw-outcome
failure until all assigned phase uploads have run. One output-free
acceptance fan-in requires literal success of every internal job; publication separately requires literal package,
candidate-acceptance, and Remote SSH success. Only the focused
`literate-documents` invocation creates a private core Python compatibility environment under its verified temporary
root, pins Jupyter Client 8.9.1 alongside the reviewed runtime versions, registers that exact interpreter in the
R-owned Jupyter data directory, and directly proves one start/execute/shutdown cycle before launching VS Code. The
probe and bounded cleanup remain in the runner-owned process tree or Windows Job, and the editor receives that same
interpreter. This closes the unreviewed hosted-IPykernel 7.x drift observed in the failed gate without claiming that
version caused the stall; it does not add a retry or relax either deadline. The categorical Undo assertion dispatches
once, keeps that authoritative receipt, and gives the queued mutation 75 seconds to complete; it never retries after
the dispatch boundary. Generated-R acceptance reacquires Code Preview only when it proves the prior renderer
generation was replaced, reads one exact bounded code receipt, selects one unique complete logical line with
receipt-only diagnostics, changes only the exact CodeMirror scroller, and requires two stable same-generation
visibility measurements with bounded diagnostics.

Candidate editor coverage keeps one complete installed Clone lifecycle, targeted value/categorical catalogs,
one comprehensive Linux VS Code native-frame owner, representative macOS/Windows R seams, and exactly one Cursor
lifecycle/responsive-grid/reveal-state seam. Every editor phase retains its 300-second hard deadline, 180-second
changed-checkpoint inactivity deadline, and no-retry rule.

Only the focused interactive and literate selectors acquire the four pinned R/Quarto tooling artifacts. Core, focused
restart, native-frame, value, categorical, and remote-only selectors do not prepare or install them. Acquisition may
retry only when the initial `fetch` promise rejects
before producing a response. Each artifact gets at most three total attempts, separated by cancellable fixed 2-second
and 4-second waits, all within its original aggregate 10-minute download budget. A synchronous fetch-start failure,
any non-success HTTP response (including 429 or 5xx), a missing or failing body, byte-count or SHA-256 mismatch,
filesystem error, override failure, extraction error, version mismatch, and every editor phase remain single-attempt
failures.
Download-attempt checkpoints and download errors contain no more than the public artifact key, pinned filename, and
bounded attempt number; they do not retain a request or redirect URL, headers, or raw transport cause. This setup-only
transport policy does not extend or retry the 300-second hard and 180-second inactivity-bounded native editor phases.

The preview-only form of the same author is `node scripts/create-canonical-release-artifact.mjs <candidate> --out-dir <directory> --preview-release`. It binds a clean exact `EXPECTED_SHA`, the intended numeric `RELEASE_TAG`, preview source/package/runtime identity, the VSIX pre-release marker, and immutable candidate bytes, but deliberately does not invoke stable parity, changelog, or README readiness and does not require the intended tag to exist. It emits the same three filenames as stable with the distinct `openwrangler-canonical-preview-release-artifact-v1` provenance protocol and `preview: true`. Pre-tag acceptance uses `scripts/verify-preview-release-artifact.mjs`; public registry intake independently revalidates the same triple. Historical two-file previews are not canonical inputs and are rejected rather than receiving invented provenance.

The content guard parses GitHub-flavored Markdown and requires exactly one active canonical Pandas/Polars table in the top-level section of `docs/feature-parity.md`; every exact ordered row must be Done and carry human completion text plus at least one positive `test:`, `workflow:`, or `record:` reference to a tracked file of the matching kind. Empty, malformed, untracked, placeholder, and future-action evidence fails. Fenced, indented, HTML-commented, or raw-HTML decoys cannot satisfy either that table or the one real dated changelog section, which must also contain a substantive bullet under an accepted change category. The guard pins the fixed `Matt17BR.openwrangler` identity, rejects duplicate JSON members, and requires the complete parsed packaged manifest to equal the source manifest. An exact `vsce` probe found no package-manifest transformation, so none is currently allowed; any future tool transformation must be documented, normalized narrowly, and covered before it can enter this gate. Source and packaged Python runtime versions and the canonical VSIX identity/channel must agree with the tag, with explicit `preview: false` and no prerelease VSIX property.

The checked-in preview documentation separately retains exactly one ordered `Native R preview` table. Preview rows may
remain truthfully Partial, but their surface, availability, status vocabulary, current-check prose, and release-gate
cells are structural release inputs. Stable releases at major version 2 or newer require a distinct `Native R support` table.
That top-level section contains only the canonical table, so preview-era or contradictory narrative cannot survive beside
an all-Done matrix. Every exact ordered row must be Done, must use the reviewed stable availability and `Stable release` cells, and must
say `Exact stable acceptance passed and is recorded` alongside exactly its row-specific tracked evidence references plus
the packaged extension-host, candidate-workflow, and testing-record references. The stable scope explicitly includes ordinary base `data.frame`, tibble, `data.table`, and
`collapse::qDF()`/`qTBL()`/`qDT()` frames; all 32 catalog operations and their generated-code surfaces; R transport,
document, insertion, and export journeys; a release-candidate R performance record; complete VS Code acceptance; and
the bounded Cursor lifecycle/responsive-grid/reveal-state compatibility seam. The active R-terminal transport and export rows claim Linux only, matching the platform where the
candidate installs and exercises the native R editor tooling. Cursor does not own an R literate-document row. The current prior-27 suites plus
focused Custom Code, multi-output split, public regex extraction, Pivot longer, and Pivot wider contracts cannot satisfy either all-32 catalog row by themselves. The dedicated
`r/tests/complete_catalog_contract.R` runtime/generated-code contract and
`src/test/rCompleteCatalogCodeExport.unit.test.ts` code-export contract now provide the required local-source
owners; the rows still cannot become Done without their tracked candidate record and the remaining stable gates.
`GRP_df`, `indexed_frame`, Windows direct-document execution,
and remote R documents remain outside that table. Successful candidate jobs do not change a documentation row to Done by themselves: the exact tracked record
and row-specific evidence must already substantiate the claim. Historical stable 1.x recovery does not require the
Native R stable table, while a malformed or preview-channel source version cannot bypass stable source readiness.

Source and packaged READMEs must each contain exactly one bounded generated `open-wrangler-release-status` region containing the only active Install section. It distinguishes the latest stable release, the latest published preview, and current `main` source. The source path uses `npm run package:dev` to make `openwrangler-dev.vsix` after a clean build without running the release matrix, and plainly says that `main` may be ahead of the published preview. Stable text links the exact Visual Studio Marketplace and Open VSX listings plus the latest stable GitHub Release for manual or offline installation, while the checked-in preview README is continuously compared with the generated preview region by `npm run docs:check`. Non-preview documentation must pass all-green stable readiness. Release links, product-level channel claims, unavailable-release disclaimers, or parity-status claims outside that region fail readiness; an engine-specific preview description remains valid. Missing, extra, duplicate, reordered, hidden, or invented parity surfaces fail closed. Preview candidates skip only stable-specific content readiness after their numeric channel policy passes; their VSIX, checksum, and provenance remain mandatory. Focused contract tests run in `npm run test:scripts`, and a readiness failure publishes no canonical set.

VS Code owns the complete release semantics and operating-system matrix. Cursor is a first-class supported fork through one pinned Linux lifecycle/responsive-grid/reveal-state seam, backed by focused component and panel contracts; it does not repeat the R catalog, installed-performance, Jupyter, or macOS/Windows matrices. Other VS Code-based desktop IDEs are experimental and may receive only bounded, isolated install/activation/file-open/cleanup smokes after their registry path is verified; those smokes are tracked in [issue #86](https://github.com/Matt17BR/openwrangler/issues/86) and never replace a first-class gate. Google says [Antigravity is based on the VS Code codebase and downloads extensions from Open VSX](https://antigravity.google/docs/editor?app=antigravity), so Open VSX is its documented discovery route. Microsoft states that [alternative Code - OSS products cannot access the Visual Studio Marketplace](https://code.visualstudio.com/docs/supporting/FAQ#_i-cant-access-the-visual-studio-marketplace-from-product-fill-in-the-blank-why-not), so a Marketplace upload must never be presented as distribution to forks. Open Wrangler 1.2.0 has one bounded Linux x64 Antigravity smoke through Open VSX; [the exact record](testing.md#experimental-antigravity-smoke) remains experimental and non-release-blocking, and does not cover macOS, Windows, notebooks, the full product matrix, or a future editor version.

Historical macOS and Windows Cursor evidence used the fixed official `downloads.cursor.com` packages. `scripts/cursor-acquisition.mjs` retains those recovery receipts and the current Linux Cursor 3.13.10 receipt for the one candidate compatibility seam. Installed performance acquires only official VS Code 1.130.0 Linux x64 (`356,926,919` bytes, SHA-256 `7d6ad3d3a78ac4551c14631f78d7e03c85282ab505c3ce8b1bc04e01fafe88ea`); the Cursor seam uses its separately pinned Linux x64 package (`209,277,476` bytes, SHA-256 `8a5b734be3bccc3de6daf96c536daa644c715e5fe3e5eaf21721538072ea104c`). A target change requires updating those receipts and their tests in one reviewed pull request. Every downloaded editor package is a temporary test input under one disposable per-run private root: never commit, bundle in the VSIX, cache as a release output, upload, publish, or redistribute it.

The VSIX may contain production extension bundles, webview assets, the Python and R runtime sources, package metadata, README, changelog, license, and third-party notices. It must not contain source TypeScript, tests, fixtures, scripts, benchmark sources, profiles, source maps, caches, virtual environments, `.env` files, credentials, or untracked scratch files. `verify:vsix` and stable readiness use the same bounded in-memory ZIP reader. It streams every entry, checks its actual uncompressed size and CRC-32, rejects encrypted or unsupported flags/methods, non-regular Unix entries, name and file/directory collisions, and per-entry or aggregate expansion beyond fixed limits, then requires the OPC metadata, legal notices, production bundles/assets, and runtime boundary files. Every local main, icon, view-container, notebook-renderer, command-icon, and walkthrough asset referenced by packaged `package.json` must resolve to a regular archive file. The allowlist requires the stdlib-only `python/openwrangler_runtime/dependency_guard.py` and both native-R `frame_contract.R` and `kernel_agent.R` files; omitting any of them is a package failure. Allowlist verification also reads packaged `webview.css`, the compiled webview host, the exact notebook-renderer entry, and all four shipped source documents. Packaged `README.md`, `CHANGELOG.md`, `LICENSE`, and `THIRD_PARTY_NOTICES.md` must byte-match their tracked sources, so ordinary verification catches VSCE rewriting or substitution before canonical release staging. `npm run license:check` independently pins `package.json` and the exact reviewed `LICENSE` bytes to the MIT project license; archive parity cannot legitimize a changed license. The Codicon font URL must be bundle-relative so the checked-in font resolves beside the stylesheet, the CSP must allow `webview.cspSource` through `font-src`, `media/notebookRenderer.js` must be non-empty valid JavaScript with a named `activate` export and no static imports, dynamic imports, or dependency re-exports, and every HTML `<source srcset>` candidate must be an absolute HTTPS URL because `vsce` does not rewrite it like a normal Markdown image. Shared renderer validation is inlined, so a separate renderer `protocolValidation.js` chunk is neither required nor allowlisted. After allowlist verification, `npm run test:packaged-editors -- openwrangler.vsix` must install and exercise the artifact from isolated profiles; development-host success is not a substitute. The packaged gate uses three editor processes per product: an untrusted Restricted Mode phase, then trusted seed and verify phases that prove backend-pinned persisted-plan replay, concurrent Pandas/Polars/DuckDB crash recovery for supported file sessions, guarded dependency interruption/revalidation, export source safety, and final process cleanup. Released-Jupyter acceptance separately gates native, viewing-only DuckDB notebook relations: the exact originating `DuckDBPyRelation` must survive paging, filtering, sorting, profiling, and Open Wrangler cleanup without conversion through Pandas, Polars, or Arrow; editing, code insertion, and data export remain unavailable for that path.

`.github/workflows/released-jupyter.yml` runs only when manually dispatched. Each selected lane makes a clean production build, packages it with `package:prepared`, verifies the VSIX, and runs the focused Python or R editor journey without repeating the full source suite. Pull requests own unit, renderer, extension-host, source-coverage, browser-baseline, and harness-adversarial evidence; the release-candidate workflow runs installed and external checks against its exact candidate VSIX instead of replaying those source suites. All editor processes use isolated profiles and an invisible test display.

The workflow keeps the Python and R fixtures separate. The Python fixture runs the remote journey in VS Code and
installs Pandas, Polars, DuckDB, IPykernel, and Jupyter Server from
`scripts/remote-jupyter/requirements.txt`. The R fixture uses Rocker R 4.5.2, the dated Ubuntu snapshot and P3M
repositories recorded in `docs/testing.md`, and fixed versions of IRkernel, jsonlite, rlang, tibble, data.table,
collapse, and nanoparquet. `Dockerfile.r.base` owns the snapshot-pinned operating-system and hash-locked Jupyter
foundation; `Dockerfile.r` consumes that exact owned image, installs the pinned R packages and kernelspec, adds the
server helpers, and produces the final fixture image. The existing third stage launches the container and proves
readiness. All three stages have independent 300-second hard and 180-second inactivity budgets, and their exact engine,
image, and owner receipts remain an opaque in-process handoff.

The manual workflow's Linux lane runs separately reverified local R default core, value, categorical, and
active-terminal VS Code/Cursor invocations in that order and runs remote R notebooks in VS Code. Each of those four
local runners owns an immediate sealed diagnostic upload before one exact four-way raw-outcome failure fan-in. The
remote R Docker journey keeps its existing `lowerText` (Lowercase) operation check independently of the local value
partition. The manual macOS and Windows lanes install R 4.5.2 with the pinned setup action, resolve the hosted
`Rscript`, and run the same default-core local `r-jupyter` journey in packaged VS Code against the freshly verified
VSIX. Default core retains its embedded native-frame and restart behavior. macOS includes the local plain `.R`
subjourney; Windows skips direct documents.

Release-candidate acceptance, rather than this manual workflow, owns the separate macOS/Windows `r_platform`
core/native/restart phases and the Linux VS Code native, restart, plain `.R`, `.Rmd`, `.qmd`, and Python Quarto
invocations. Local Windows file menus are hidden, while remote-resource and Command Palette entry points remain
available because static client keys cannot identify the extension-host platform. The runtime guard is authoritative;
remote R-document execution is experimental and is not part of the release matrix.

Both remote fixtures are unprivileged, read-only containers with no host mounts and one loopback port. Their credentials are generated inside the runner and are never workflow secrets or environment values. Cleanup revalidates the exact Docker engine and removes resources in reverse acquisition order: container, runtime image, then the R base image when present. Every removal must be provable or the run publishes no evidence path and leaves the private root in place for investigation. The fixture locks are excluded from the VSIX but remain release inputs: `npm run audit:remote-jupyter` scans both complete locks without advisory suppressions, and `npm run lock:remote-jupyter:check` must reproduce their committed bytes with the exact tool, target, and cutoff documented in `docs/testing.md`.

A released-Jupyter run is not release evidence while freshly executed MIME-v2 output remains unacknowledged by the renderer; successful host MIME emission or the separately green saved-output renderer path cannot make that gate green.

The packaged split-notebook renderer-provenance scenario proves notebook B is active immediately before dispatching notebook A's visible renderer action with a real user click. Synthetic DOM activation cannot satisfy this release gate. The run must retain the exact notebook A/B origin, variable, kernel, insertion, and cleanup assertions, including that notebook B never receives notebook A's session. Bounded timeout diagnostics may contain only safe origin classifications, coordinator state, and A/B generation/execution counters.

Linux packaged-editor release gates and pull-request extension-host gates run on the zero-window headless Ozone platform by default, with desktop display/editor-IPC variables removed, persistent auxiliary services disabled, and private runtime, home, config, cache, and data directories. Candidate exact-artifact validation keeps its full VS Code invocation on that path and runs the focused Cursor `platform-smoke` separately on the repository-pinned private Xvfb after Cursor 3.13.10 reproducibly failed before harness activation in headless Ozone; each invocation immediately follows a fresh canonical artifact verification, while the isolation rules, deadlines, and failure-only diagnostics remain identical, with no automatic retry or fallback. The checked workflow contract rejects inherited environment or shell defaults, conditional/non-fatal evidence gates, unapproved shells, and unbound checkout/download/verifier or consumer steps, so the exact-success fan-in cannot turn skipped evidence into a release signal. Its semantic and structural inspectors validate the parsed job topology and the release-critical ordered steps, commands, environments, action inputs, and evidence-upload structure; an intentional workflow edit must update the corresponding reviewed contract. Every artifact-consuming cross-platform, performance, Jupyter, Remote SSH, Linux editor, upload, and final-publication step immediately follows its own fresh canonical verification; an intervening workspace command therefore invalidates the checked structure instead of substituting the bytes under test. Editor CLI, workbench, and private-display processes on every platform receive only the explicit platform/isolation allowlist plus runner-owned test values; the caller's remaining environment is not inherited. CI and release workflows must not opt into the user's current display, attach commands to a live editor, touch normal editor profiles, or silently fall back to it. Hosted Cursor compatibility starts inside `dbus-run-session` and receives only that isolated, runner-owned GTK session-bus address; it never reuses a caller or desktop session bus and does not restore display or editor IPC access. `OPEN_WRANGLER_EDITOR_DISPLAY=current` is reserved for an intentional visible local debugging run and is forbidden in hosted evidence; `OPEN_WRANGLER_EDITOR_DISPLAY=xvfb` remains an explicit isolated compatibility mode, never an implicit local-desktop fallback. Late child errors cannot prove exit, and uncertainty from a downloader, editor, or private display propagates to cleanup. On Windows, every editor command and workbench is created suspended by a private supervisor, assigned to a kill-on-close Job Object with an explicit inherited-handle list, and resumed only after ownership succeeds. Completion requires exactly one random supervisor attestation that is excluded from the target environment and emitted only after `ActiveProcessCount == 0`; the runner closes the private control stdin on every settled path. If any editor/display ownership remains unverified, caller-environment restoration is lexical only, no diagnostic artifact or workflow output path is published, and no inherited private runtime/root/profile/result/progress/log path may be inspected or removed. Pull requests run stable VS Code extension-host coverage in the existing macOS and Windows runtime cells. Release candidates add focused exact-package compatibility seams on those platforms without repeating that source suite. The launch contract and local controls are documented in `docs/testing.md`.

The final pathname and Git-ref handoffs trust the GitHub-hosted runner, the pinned actions, the protected candidate source, and authorized repository writers. A detached same-UID process racing an already verified VSIX/Xvfb path, or another writer creating the intended tag between the final absence check and GitHub Release creation, is outside the release threat model. Before dispatching stable promotion, the release operator must confirm that no other tag-writing workflow is active and that the intended tag is still absent; the workflow then repeats the exact remote-tag check immediately before publication.

Attestation ambiguity permanently latches ownership uncertainty. The correlated marker is removed before stderr accounting or diagnostics, stream listeners continue draining through ownership verification, and a Windows-owned launch with non-piped stderr is rejected before spawn. Chunk-split marker/final-suffix coverage guards transform flush and backpressure handling. Major extension-host checkpoints use bounded, exclusive, randomized no-follow temporaries and treat publication failure as a failed acceptance run. The Windows cross-platform cell compiles the real supervisor and proves natural descendant containment, termination, and malformed-frame rejection.

A packaged-editor failure may preserve sanitized evidence only after every owned editor/display tree is proven empty and before its disposable root is deleted. This includes package/editor discovery, display startup, installation, phase, and cleanup failures. Prelaunch faults use the synthetic `setup` phase; cleanup-only and combined failures use a distinct `cleanup` phase and retain the originating phase in `cleanupOfPhase`. Before launch, the runner creates a random private staging root (mode 0700 on POSIX) and pins its device, inode, mode, canonical path, and emptiness. Every retained target receives an in-memory inventory receipt; sealing revalidates the staging root and every no-follow, single-link file identity, re-redacts strict UTF-8 text, and writes one exclusive random JSON artifact outside the staging root. GitHub runs use a fresh randomized parent below `RUNNER_TEMP` (mode 0700 on POSIX); local runs use `tmp/editor-acceptance-artifacts/`. A detected pre-close failure scrubs the owned file descriptor to zero bytes and flushes it before close; a close error reported after the descriptor is already closed falls back to identity-checked path removal. Successful sealing captures its authoritative file snapshot after the writer closes and returns a frozen path/parent/file-identity/size/SHA-256 receipt, which is revalidated immediately before the runner emits `evidence_path` and its digest/size to `GITHUB_OUTPUT`.

Pull-request and tag workflows pass only that exact non-glob path to the immediately following `actions/upload-artifact` step and retain it for seven days. Because the action accepts only a pathname, it cannot carry the receipt's descriptor or inode binding into the next process. Release security therefore trusts the GitHub runner and pinned upload action after editor/display tree-empty attestation; arbitrary same-UID mutation after attestation is outside the supported threat model. Replacement after the final check but before the action opens the path is the unavoidable narrow handoff window; do not claim it is race-free against a hostile runner. Local failure runs print and retain the exact repository-relative bundle for inspection rather than deleting prior untracked bundles; CI artifacts live below disposable `RUNNER_TEMP`. The artifact contains only bounded, structurally redacted result/progress JSON, selected redacted editor and Open Wrangler logs, structured failure metadata, and a paths/types/sizes-only manifest; malformed JSON and raw profiles, settings, workspace storage, databases, secrets, arbitrary logs, symlink targets, hard links, planted entries, and path-swapped inputs are omitted or prohibited. Each collected source is capped at 16 MiB, collection admits at most 64 candidates and 64 MiB of source text, and sealing independently caps receipt inventory, source bytes, and final artifact bytes. Private-key scanning and credential redaction cover the complete admitted source before a bounded retained tail is selected and run again while sealing. Results must match the phase's strict `protocol`/`runId`/`phase` envelope and first-observed file identity. When any editor/display ownership cannot be verified, the runner restores the caller environment lexically, publishes no artifact or workflow output path, and neither inspects nor removes any inherited private runtime, root, profile, result, progress, log, or staging path. A failed phase is never retried automatically, and a successful run removes its empty staging root and creates no artifact. See `docs/testing.md` for classifications, 300/180-second deadlines, 1 KiB/1 MiB phase-file limits, remaining content limits, and privacy rules.

The strict runtime benchmark and Playwright cached/uncached scroll gates must pass on the Linux release reference workstation. The runtime must import Polars before timing, record an accepted per-file source-cache eviction, and keep the canonical stdio first-grid round trip below 3s for the 100k×50 CSV and 5s for the 1M×20 Parquet fixture; a warm-source median cannot substitute for this gate. The report must retain separately named direct-manager cache metrics, real stdio protocol/JSON cache-miss round trips, the same-session statistics-contention latency, active-call proof, overlap result, native-frame evidence, source/machine/package provenance, and process resource samples. An in-process timing may not be cited as product-boundary performance, and none of these numbers may be described as VS Code, Cursor, webview, or editor first paint. The isolated benchmark bootstrap must prove from `header_stats` entry/exit events that statistics remained active when the page envelope finished sending; completed-before-send or otherwise inconclusive evidence fails release. The cache-miss response gap must then prove substantial overlap against the uncontented baseline, and both ordinary and contended stdio pages must remain within 500ms. Attach the generated `tmp/performance/report.json` values to parity evidence; opt-in Pandas and DuckDB smoke reports prove native coverage but do not replace the strict Polars release gate. Scheduled CI reports provide regression history but do not replace final local acceptance.

A stable 2.x release links a reviewed Data Wrangler comparison from its README. The linked `review.md` and sibling
`report.json` must both be tracked. `npm run docs:check` regenerates the marked results in memory and rejects a stale
review; the rest of the review stays human-written. It also recalculates the published counts and timings from the raw
samples. Stable release checks read that JSON from the release commit. A report made for the release must name the same
version and VSIX checksum; a patch may reuse a reviewed report from its current major/minor line.

The README keeps a short summary of the latest reviewed Data Wrangler comparison and links to its dated report. It
does not put a release number or timing table in the prose. Before releasing 2.0, rerun the comparison with the final
candidate VSIX, publish the 2.0 report, and update the link and summary.

Public README/gallery PNGs are captured at 2× physical density against unchanged logical editor layouts and retain
lossless pixels. Before tagging, `npm run verify:readme-media` must prove exact dimensions, crops, sRGB output, and
the per-file/total byte budgets. After GitHub and both registries have ingested the release README, check out the
exact released source and run:

```bash
RELEASE_SOURCE_SHA="0123456789abcdef0123456789abcdef01234567" # replace with the released source commit
RELEASE_VERSION="1.2.1" # replace with the released semantic version, without v
npm run verify:public-media-surfaces -- --source-sha "$RELEASE_SOURCE_SHA" --version "$RELEASE_VERSION"
```

The verifier requires the remote README at that exact commit to byte-match the reviewed local README and its
`package.json` version to match the supplied version. Before reading any PNG, it bounds the inventory's entry count,
depth, relative-path bytes, individual file size, and cumulative size. Every declared file must then pass chunk CRC,
IHDR/IDAT ordering, complete decode, reviewed natural dimensions, standard sRGB, and immutable-byte checks. The two
registries must show the exact version, all three surfaces must render the expected README content, and all 20
displayed images must retain the reviewed raw URL and natural dimensions. Screenshot markup is width-only and capped
at 960 CSS pixels; rendered images must stay inside that cap, their container, and the viewport, preserve their aspect ratio, and
retain at least two natural pixels per CSS pixel. Four representative images are rechecked near 760px and 1400px
viewport widths. Before publication, `npm run verify:readme-responsive-render` applies the same layout checks to the
actual local README and gallery at both widths and rejects document-level horizontal overflow. A mutable
default-branch GitHub page is never accepted. The `public-media-render-verification` cutover in
`fixtures/release-cutovers.v1.json` owns when this contract begins. Earlier exact-tag recovery skips both browser
installation and this check so a new media inventory cannot invalidate historical publication.

The deterministic inventory, exact-source, ancestry, and immutable-byte portion runs with `--prepublish` in the
release-candidate package job before any tag, release, or registry mutation. It requires the README media commit to be a
reachable ancestor of the exact release source in the selected full-history checkout. Recovery promotion follows the
`public-media-prepublication` manifest cutover and runs from the exact checked-out release's script and restored
lockfile before registry authentication or publication. Earlier releases retain their existing recovery behavior.
This mode never launches Chromium or reads a registry page. Public rendering is necessarily a separate
post-publication observation gate: GitHub and registry writes have already occurred before those pages can be
inspected. A failure marks the promotion workflow failed and requires remediation or a new release, but it cannot
undo or roll back already-public immutable release or registry bytes. It never makes a deterministic pull-request
lane depend on registry pages.

GitHub exact-source rendering owns one context and one non-retryable observation. Each image is scrolled and measured
inside one bounded same-page `page.evaluate` stability wait. If the page replaces candidate A with B, the same
evaluation re-queries the image and resets its candidate; B must then remain identical for two consecutive
post-scroll animation frames. The source observation, a navigation with no HTTP response, and escaped browser, DOM,
evaluation, scroll, or animation-frame errors are terminal. Exhaustion after any candidate disappears, keeps
changing, remains CSS-hidden, has invalid geometry, or produces a complete positive proof that fails to stabilize is
also terminal. On Marketplace and Open VSX, retries are limited to an explicitly observed stale version, README
content, or immutable image source; an initially missing or incomplete exact-alt image; or an actual non-OK HTTP
response. Those observations may use up to forty fresh registry contexts at thirty-second intervals. The one source
check and registry attempts share the existing thirty-minute global deadline.

The installed-performance job runs on GitHub-hosted `ubuntu-24.04`, downloads the candidate workflow's run-scoped artifact by exact artifact ID, and acquires the official pinned VS Code 1.130.0 Linux x64 package into its per-run private root. Its byte count and SHA-256 digest must match the receipt above before extraction or launch. VS Code remains on zero-window headless Ozone and may not use a preinstalled or moving channel, a normal profile, the current desktop, or an implicit local-display fallback. The temporary editor package and extracted installation are test inputs only and never enter the candidate, report, release artifact, cache, or registry.

Stable intake builds only the acceptance harness and revalidates the candidate, checksum, provenance, acquired editors, and private staged candidate throughout the run. Apart from its private Python path, the harness may not override product settings: every phase records and asserts the shipped `auto` backend, Editing mode, insights-on-open, 200-row block, and 16-column block defaults, then proves the file session selected native Polars and rendered the insights control. The editor-host result binds each phase fragment by byte count and SHA-256. A failed fragment publication cleans only the captured temporary identity; substitution with another inode is retained and fails the phase. Final report publication is accepted only while joint candidate, checksum, provenance, and report revalidation still matches every receipt after each has been read.

For each VS Code CSV/Parquet first-grid case, all ten timing samples retain a corresponding path-free cache proof. The resident case requires a complete sequential read followed by `mincore` proof that every file page is resident. The page-cache-evicted case synchronizes the descriptor, issues exactly one `POSIX_FADV_DONTNEED`, and requires immediate `mincore` proof of zero resident file pages. Unsupported proof, residual pages, identity drift, or any cache-control fault fails without retry. Release-sized cached scrolling uses exactly 200 real row transitions. Uncached-grid and renderer-heartbeat p95 each use 40 interactions. All measured samples are retained, with no trimming or automatic retry. The non-gating 5,000-row smoke uses ten interactions so every deterministic unseen-row target remains inside its fixture. After both cached rows are primed and the first row is restored, VS Code performs a fixed sequence of ten untimed alternating row transitions before the independent measurement window. This warms the repeated renderer/compositor path rather than admitting its startup into a steady-state cached-scroll metric; initial-grid startup remains covered by the separate first-grid phases. Warmup values are never retried, substituted for measured values, or included in the report, and every measured scroll still proves its transition. Continuous scrolling trailing-debounces view-state persistence so the latest state is written after quiescence rather than on every interaction. First-grid p95 stays below 3s/5s. Cached scrolling fails when 16 or more of its 200 transitions take at least 100ms. The cutoff uses a 5%-slow reference rate; for independent transitions, the binomial chance of seeing 16 or more is 4.44%. Uncached-grid p95 and outstanding foreground pages stay below 500ms; renderer-heartbeat p95 and outstanding renderer heartbeats stay below 100ms. The hosted path does not reinterpret a failed threshold. This evidence is a Linux file-page-cache checkpoint only and must never be described as physical cold-disk or cold-storage performance.

The installed-editor report deliberately excludes whole-editor-process-tree and runtime RSS sampling from its release
gate. `/proc` membership and sampling races describe the hosted harness and Electron helper topology, not a product or
package invariant. Report protocols `openwrangler-installed-performance-report-v10` and
`openwrangler-installed-performance-evidence-report-v5`, plus the non-gating smoke envelope
`openwrangler-installed-performance-run-v6`, retain platform/storage provenance and every timing, cache,
responsiveness, cancellation, and terminal runtime/session/editor cleanup gate. Editor ownership uncertainty remains
terminal and withholds private-root cleanup. The separate direct-runtime benchmark keeps its bounded-process RSS
evidence, and the Data Wrangler comparison study keeps its independent Linux process-tree PSS sampler.

The workflow retains a passing path-free report for 90 days. If and only if the complete validated report fails exclusively on numeric thresholds, the runner rejects every absolute, home-relative, drive-relative, environment-relative, percent-encoded, or ambiguously path-shaped unstructured value, revalidates the candidate set before and inside the sealed report's final descriptor snapshot, and then emits the exact report path, SHA-256, and byte size without another candidate read opening a receipt race; a distinct failure-only upload retains that one report for seven days. This is deliberately fail-closed: an unusual but harmless platform string that looks like a path makes evidence unavailable instead of being uploaded. Structural, mixed, cleanup, ownership, candidate, report, output, or privacy uncertainty emits no failure path, and neither upload can include candidate bytes.

The retired v1.0 evidence bridge completed on [run 30320866354](https://github.com/Matt17BR/openwrangler/actions/runs/30320866354) for source `cfc30e4fdb77711f9007b598bb9ad099dfcf5ca6`. Artifact `8674099196` contains the accepted 92,583-byte report with SHA-256 `46d7519df26890c44e5168be7d417da5c52713450cba4f5579e3b7673e3fcdee`; its exact measurements are recorded in `docs/testing.md` and `docs/feature-parity.md`. The measured candidate was 609,032 bytes with SHA-256 `59994b2b46cfb7c9ec28089122d4ba83301f59b9c4cc0145ce8c1793e960140f`. Those bytes remain historical evidence and are not release inputs.

The same installed-editor report must prove that the production renderer and foreground query lane remain responsive during filter, sort, and background profiling. Filter and sort probes begin only while their UI operation is still outstanding. Profiling additionally requires exact coordinator-owned evidence that its `getSummary` request has entered the active background lane and the separately identified `getDatasetStats` request remains queued; a merely unresolved Promise is not evidence of scheduler acceptance. Only then may the harness launch its animation-frame heartbeat, interactive page request, and queued cancellation. Every heartbeat must remain below 100ms, every foreground page below 500ms, and the queued profile must still return its own authoritative cancellation response.

## GitHub workflow (current policy and historical recovery details)

Each coherent change uses a feature branch and pull request. The current PR workflow applies the same triggers to draft
and ready changes; there is no separate draft-only feedback context. The unconditional `invariant-core` owns the
portable, TypeScript, Python 3.10, audit, schema, documentation, and license boundary. Four conservative classifier
outputs select the paired R 4.5 owners, canonical package/editor owner,
visual/accessibility owner, and Windows unique-risk owner. Missing or malformed classification fails open to all four,
and the sole `validate` fan-in fails closed on every required result. Scheduled/manual Cross retains its
macOS/Windows runtime, Windows dependency checks, and R 4.4 qualification. CodeQL runs explicit always-on JavaScript/TypeScript
and Python analyzers and joins them through `CodeQL gate`. Pushes to `main` retain CI and both CodeQL analyzers;
publication remains restricted to `main`. [CI and release checks](ci.md) has the current map.

The current PR workflow has no release-infrastructure-only, package-only, allowlist, or full-matrix classifier branch and no fixed
release job in pull-request CI. Control-plane and unmatched substantive changes select the full owner union. The
slower native editor, Jupyter, Remote SSH, installed-performance, canary, and publication checks remain separate exact
candidate or release evidence. This topology does not claim job-count, compute, or wall-time reductions before hosted
evidence. It does not weaken or replace complete exact-artifact release-candidate acceptance.

The active `main` ruleset keeps its existing rebase-only pull-request, thread-resolution, linear-history, deletion,
force-push, and required-status protections. Its CodeQL merge rule blocks non-security errors and high-or-higher
security alerts reported on changed pull-request lines. A successful workflow is not an alert-clearance receipt:
before changing this rule, query the code-scanning API for the fresh protected-main analysis and require zero open
high or critical CodeQL alerts. Preserve the complete current ruleset request when adding or changing that one rule,
then read the ruleset back and compare every retained rule.
The release-candidate, stable-promotion, and shared candidate-acceptance workflows are owned by mutation-sensitive
semantic inspectors plus the repository-wide immutable-action inventory. Their parsers and candidate-boundary tests
execute in the focused workflow lane, while workflow edits conservatively select the full pull-request owner union.
The Open VSX promotion workflow forces full CI until its inspector rejects unknown steps; its parser and focused tests
still execute in the focused lane. The Azure Marketplace pipeline also forces full CI because its hash-owning
inspector is an allowed release script; changing both files must not bless a new baseline in the narrow tier. No
workflow or pipeline YAML is eligible until an exact inventory is independent of every allowlisted hash owner.

Do not turn a release pull request into one oversized squash commit. Keep each independently reviewable product,
runtime, test, media, and documentation slice in its own commit. If a pull request contains several such commits,
merge it without squashing so the boundaries remain visible on `main`. The final release commit changes only the
version, changelog, release notes, and required release metadata.

For an intentional release-candidate pull request, apply the `acceptance:remote-ssh` label before the next pushed commit. The resulting opt-in job reuses the canonical PR package from the same run's run-, attempt-, commit-, and producer-digest-bound cache key and runs the pinned official VS Code/Remote SSH stack once inside private Linux namespaces; ordinary pull requests do not pay its download or runtime cost. The cache is untrusted transport: a missing entry or any mismatch with the producer job's exact digest and size fails closed, and each consumer also revalidates the VSIX inventory. Successful pull-request runs retain no ordinary artifacts; visual and coverage output is failure-only, while sealed packaged-editor diagnostics keep their exact emitted path and seven-day retention. Release and stable-performance workflows retain their canonical artifact-ID and provenance contracts unchanged and never consume the pull-request cache. A failed candidate is recorded and is not automatically retried.

`npm run docs:check` semantically parses the release-candidate, stable-promotion, and shared candidate-acceptance
workflows. The candidate producer owns the sole package and full VSIX proof. Every acceptance lane downloads the same
numeric artifact ID and revalidates its checksum/provenance immediately before use. VS Code owns product semantics;
Cursor runs exactly one pinned Linux lifecycle/responsive-grid/reveal-state seam and owns no operation catalog,
Jupyter, R catalog, performance, or operating-system matrix. The R compatibility evidence contains R 4.4 and 4.5,
while performance publishes one bounded, digest-bound VS Code report. Remote SSH starts alongside shared acceptance.
The always-evaluated manifest fan-in requires literal success from packaging, shared acceptance, and Remote SSH, then
records the canonical artifact identity and the exact performance artifact identity. Candidate jobs are read-only,
external actions are commit-pinned, and no consumer may rebuild or repackage the candidate.

Stable promotion is a later independent dispatch. Selection is read-only; publication alone receives `contents: write`
inside the protected environment. Cross-run downloads bind the selected workflow run and each numeric artifact ID.
The manifest binds that run, stable tag, historical source SHA, canonical VSIX bytes/digest, acceptance results, and
performance report bytes/digest. Canonical verification runs before manifest inspection, immediately before tag and
GitHub publication, and immediately before Open VSX publication. Missing, skipped, cancelled, expired, changed,
conflicting, too-young, too-old, rerun, or superseded evidence fails closed without a retry.

Each local-R shard and `r_platform` cell provisions its packages once through the same pinned dependency action and
exact configuration as the pull-request R matrix. The action reconciles the resolved lock and may restore a compatible versioned cache created
by an earlier candidate dispatch on `main`. GitHub's pull-request merge-ref cache is not available to the release
dispatch, so the first matching `main` dispatch performs a valid cold install. The cache is neither immutable package
pinning nor supply-chain evidence. Protected pull-request CI remains the sole direct R-contract owner. Core, restart,
value, categorical, native-frame, active-terminal, and R Markdown/Quarto packaged-editor journeys each retain their own artifact revalidation and remain
required release evidence.

Candidate qualification keeps sibling cancellation disabled so every bounded owner can finish cleanup and emit
failure-only diagnostics, but any failed, cancelled, or skipped owner prevents the qualification manifest. No failed
candidate is rerun or promoted. The stable workflow has no validation-only or publish boolean: it is solely the
explicit, protected promotion of one already-qualified candidate selected by run ID after its required soak.

GitHub publication is then resumable at a draft boundary. The exact lightweight tag must already resolve to the
accepted commit. An absent release becomes a draft; an exact partial draft receives only its missing canonical
assets; and every retained or newly uploaded asset is downloaded and byte-verified before the draft can be
published. An already exact public release succeeds without mutation, but a partial public release is terminal:
the publisher never edits, deletes, or repairs a public release. Duplicate releases for one tag, a conflicting
identity, target, channel, publication-state, or canonical-asset field, an unexpected asset, size/digest/byte drift,
a moved tag, or any change observed after the publish response fails closed. GitHub-generated release-note Markdown
must remain a bounded string, but is not canonical integrity evidence; exactness comes from the tag, target, channel,
provenance, checksum, and downloaded asset bytes. Stable and future preview publishers share this channel-aware
transaction; preview publication sets GitHub prerelease metadata and never marks the release latest.
The stable and preview wrappers open all three canonical files with no-follow descriptors before semantic
verification, retain those descriptors through publication, and publish only the verified in-memory bytes. They
revalidate every descriptor, named single-link path, bounded size, identity, timestamp, inventory, and in-memory
digest immediately before each draft creation, asset upload, or final publish mutation. The VSIX retains the
canonical 128 MiB ceiling; provenance remains capped at 4 KiB and the checksum at 512 bytes, so increasing the
package ceiling cannot widen either sidecar boundary.

After the remote tag push, the job creates or verifies the same lightweight tag in its local checkout before it
publishes the GitHub release. The tag push uses a commit-to-remote refspec, so this explicit local step is required
before registry verification reads the release source from `refs/tags/<version>`.

This ordering follows GitHub's [immutable-release publication guidance](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases):
create the draft, attach every asset, then publish it. The publisher uses the versioned `2026-03-10` REST contract
and validates GitHub's `immutable` response field. The repository's future-only immutable-release setting was enabled
on 2026-08-01 after the draft-first publisher merged. Stable promotion sets
`GITHUB_IMMUTABLE_RELEASES_EXPECTED=true`; a public response that omits `immutable` or reports false blocks completion
and registry promotion. The migration preserved publication throughout by merging draft-first support with a
temporary false expectation, enabling the repository setting, and only then requiring true. Do not reverse that order
when recreating this setup in another repository.

After GitHub publication, the same protected release job verifies `OVSX_PAT` against `Matt17BR`, rejects a conflicting
version, and sends the accepted VSIX to Open VSX with the lockfile-pinned `ovsx` CLI. It then checks the public
metadata, publisher, checksum, download, and gallery icon. Stable and preview publication share the global
`openwrangler-release-publication` queue, so releases are not displaced by newer runs. If Open VSX is unavailable,
the exact GitHub release remains available for the recovery workflow; nothing is rebuilt or replaced.

The real lightweight-tag push starts `azure-pipelines-marketplace.yml` before GitHub Release creation. The Azure
pipeline waits for that release to become public, downloads the same three assets, and may publish only the accepted
VSIX to Microsoft Marketplace. Anonymous metadata and asset requests that reject before returning an HTTP response
reuse this existing bounded poll with a fixed URL- and cause-free diagnostic. A direct synchronous fetch failure or
any response-body, inventory, URL, byte-bound, or filesystem failure remains terminal and is never retried. This does
not change the downloader's existing explicit pending classifications for selected HTTP statuses and incomplete
release observations. The complete anonymous read transaction finishes before its exclusive output directory is
created; authentication and publication still occur later and are never part of this poll. Creating only a GitHub
Release through the API is not accepted as a substitute for this Git protocol event.

Microsoft can accept a VSIX while `vsce publish` still returns a nonzero status. The pipeline records that result as
an ambiguous submission and continues to the exact public-package check. Missing or conflicting public bytes still
fail after the bounded wait; identity, authentication, and artifact checks remain fail-fast.

Draft and ready pull requests share the CI and CodeQL triggers; Cross is scheduled/manual only, and the current PR
workflow defines no draft-only check name. Readiness and merge eligibility remain repository-policy decisions outside the four-output classifier. When
several ready pull requests share a base, merge them one at a time so strict up-to-date protection does not spend time
on runs that will immediately become stale. Dependabot checks npm, Python, and GitHub Actions on separate UTC days,
groups compatible minor and patch updates by ecosystem, and leaves major and security updates separate.

Dispatch **Release candidate** from protected `main` only when the intended stable tag and version metadata have
already been reviewed. The run cannot publish. After it succeeds, let the exact artifacts soak for at least 168 and
at most 336 hours. Then dispatch **Stable release promotion** with that candidate run ID and the same tag. Do not
rerun the candidate, select a superseded run, create the tag manually, or dispatch promotion merely to rehearse it.

The shared candidate validator binds the requested runner label to its own input variable. Do not use a `RUNNER_*`
name for that value: GitHub reserves those variables for host metadata and ignores attempts to override them.

## Registry publication

Both registries are final release steps and may run only after the `Matt17BR` publisher or namespace is owned and
authorized. Publisher identity conflicts stop the release rather than changing the package identity. Microsoft's
optional domain badge is not required; Open VSX must report the publishing account verified for the `Matt17BR`
namespace. Never store tokens in repository files, workflow text, artifacts, or logs.

GitHub Releases remain the source-of-truth distribution channel. Stable and preview release jobs publish the same
accepted VSIX to Open VSX after creating the GitHub release. A separate workflow handles releases created outside
these jobs and protected-main recovery for an existing tag. Visual Studio Marketplace promotion stays in Azure
Pipelines because its publisher identity lives in Azure DevOps. Neither registry path may rebuild the VSIX.

### Current non-secret readiness

The owner has confirmed the following setup without placing account identifiers or credentials in the repository:

- The `Matt17BR` Visual Studio Marketplace publisher exists and the owner account has the **Owner** role.
- The matching Open VSX account, agreement, namespace, and protected `OVSX_PAT` environment secret are in place.
  Stable `Matt17BR.openwrangler` publication is automated, and Open VSX reports the publishing account verified for
  the `Matt17BR` namespace without a warning.
- The personal Azure subscription and `Matt17BR` Azure DevOps organization contain the private **Open Wrangler** publishing project.
- A user-assigned `openwrangler-marketplace-publisher` identity has only the Azure **Reader** role on the dedicated `openwrangler-publishing` resource group. The Azure DevOps project has a workload-identity-federated Azure Resource Manager service connection for it, and its Marketplace-facing profile is a **Contributor** on the personal `Matt17BR` publisher.
- The GitHub `publishing` environment accepts protected `main` and `v*` tag deployments.
  Release creation is the authorization boundary, so registry promotion needs no second reviewer click; the
  release-tag ruleset prevents deletion and non-fast-forward updates.

The Microsoft pipeline, its fixed service connection, and its exclusive-lock environment are active in the personal `Matt17BR / Open Wrangler` project. Stable release `v1.2.2` is the latest stable registry-handoff reference at source commit `437ac4c2fc535d4521959a90331fce8cd8436acf`. GitHub, Open VSX, and the Visual Studio Marketplace serve the accepted extension from canonical SHA-256 `5a68bf5bfee01e94c0e6fd296c53425bdec6a8d8d42cbb24bc2ec35a930af829`; isolated install-by-ID acceptance passed in both VS Code and Cursor. Open VSX reports the `Matt17BR` publisher verified, and the Marketplace's archive, metadata, checksum, and gallery icons pass the public verifier. Later releases must still run the same checks.

### Automatic Open VSX promotion

The stable and preview release jobs already run in the protected `publishing` environment, so they publish to Open
VSX directly after GitHub. Only token verification and publication receive `OVSX_PAT`. Both commands require a
non-empty token and explicit success output; the CLI's exit code alone is not accepted. The job rechecks the artifact,
rejects a conflicting version, publishes with lockfile-pinned `ovsx --skip-duplicate`, and waits up to fifteen minutes
for matching channel metadata, the verified `Matt17BR` namespace-publisher relationship, checksum, download, and
packaged gallery icon.

`.github/workflows/open-vsx-promotion.yml` covers a public `release: published` event created by another principal and
an explicit protected-main recovery dispatch. It checks out reviewed `main` separately from the release tag and
downloads that GitHub Release's VSIX, checksum, and provenance. This separate route is needed because releases created
with the repository `GITHUB_TOKEN` do not start another release workflow run. Preview packages must also carry the
matching preview provenance and VSIX pre-release marker.

For releases governed by the `public-media-render-verification` cutover, after Open VSX and the immutable tag pass,
the publishing path installs Chromium from the reviewed lockfile and runs the media verifier against the exact
release source. This keeps a historical release tied to its own screenshot inventory when `main` has moved on. All declared
PNGs must retain their reviewed natural dimensions, standard sRGB declaration, file and aggregate budgets, valid
chunk/decode structure, and immutable remote bytes. Every one of the 20 README images must then render from its exact
reviewed URL without upscaling, aspect distortion, container overflow, or viewport overflow on GitHub, Visual Studio
Marketplace, and Open VSX; representative images are rechecked near 760px and 1400px viewport widths. GitHub exact
source owns one context and one render observation. Inside the bounded same-page `page.evaluate` measurement, a
replacement from candidate A to B resets the candidate; B must then remain identical for two consecutive post-scroll
animation frames without starting a new attempt or context. The source observation, a navigation with no HTTP
response, and escaped browser, DOM, evaluation, scroll, or animation-frame errors are terminal. Exhaustion after any
candidate disappears, keeps changing, remains CSS-hidden, has invalid geometry, or produces a complete positive proof
that fails to stabilize is also terminal. On Marketplace and Open VSX, only an explicitly stale version, README
content, or immutable image source; an initially missing or incomplete exact-alt image; or an actual non-OK HTTP
response receives up to forty fresh browser contexts at thirty-second intervals. The source check and registry
attempts share one thirty-minute global deadline; network fetches are bounded to sixty seconds, one browser attempt
to three minutes, per-page and per-image operations to their configured Playwright deadlines, and context cleanup to
ten seconds. The media step receives only the source commit and version, never `OVSX_PAT`.

Before any new preview or stable tag/release write, the package path runs the browser-free `--prepublish` verifier
against its exact protected source. Under the `public-media-prepublication` cutover, Open VSX recovery restores the
exact release checkout's lockfile and runs that checkout's immutable-byte verifier before its PAT step. The later
Chromium pass remains required because only it can observe the rendered public pages; qualifying recovery installs
Chromium through that same release-local Playwright, while older exact releases retain their historical
current-automation pairing.

A post-public check can fail workflow success, but it cannot retract a GitHub, Open VSX, or Marketplace write that
already completed.

To recover an existing exact GitHub Release, dispatch **Promote GitHub release to Open VSX** from protected `main`
with `release_tag=v<version>`. Historical backfill is supported only when that release's canonical artifact and
provenance format remains compatible with the current registry verifier; incompatibility fails rather than weakening
validation. The verifier reads the exact release tag before checking the package inventory. A historical v1 tag from
before `r/openwrangler_runtime/frame_contract.R` was added may omit its packaged copy. If the tagged source includes
that regular file, the VSIX must include the complete R runtime too; every `1.99.x` or 2.x release must include it.
The vendored js-yaml capability is derived independently from the exact tag's tracked regular-file
`scripts/copy-extension-vendor-assets.mjs` marker and is forwarded unchanged to Marketplace and Open VSX verification.
The historical 1.99.0 through 1.99.2 tags may omit that marker and vendor asset. A 1.99 release from 1.99.3 onward, or
any 2.x-or-newer release, fails closed without the marker and exact asset. Verification of current packages requires
both capabilities.

<!-- release-cutovers:start -->

The versioned `fixtures/release-cutovers.v1.json` manifest is authoritative for these historical public-media
boundaries. Current automation reads the manifest; recovery reads the exact tag's own automation and must not
substitute current package requirements.

- `public-media-render-verification` starts at `1.2.1` and affects rendered public-media verification for immutable release README assets.
  Executable owner: `scripts/public-media-surface-contract.mjs`. Rationale: This was the first release whose exact source carried the reviewed public-media inventory and remote rendering contract.
  Recovery: Earlier exact tags skip browser installation and rendered public-media verification; recovery uses each tag's own files and never imports the current inventory or package requirements.
- `public-media-prepublication` starts at `1.99.4` and affects browser-free public-media verification before registry authentication.
  Executable owner: `scripts/public-media-surface-contract.mjs`. Rationale: This was the first release whose exact source and lockfile carried the browser-free prepublication verifier used by recovery promotion.
  Recovery: Earlier exact tags retain their historical recovery behavior; this version and later run the verifier from the exact release checkout without applying current package requirements retroactively.

<!-- release-cutovers:end -->

Repeating the dispatch is safe only when the registry already serves identical bytes; a conflict fails without
replacement. Do not dispatch from an old release tag, because historical releases intentionally do not contain the
reviewed automation.

### Automatic Microsoft Marketplace promotion

`azure-pipelines-marketplace.yml` subscribes to immutable `v*` Git tags and protected `main`, with batching
disabled so intake always reasons about one exact event commit. The trigger deliberately has no YAML path filter:
Microsoft documents [branch and tag filters as an OR](https://learn.microsoft.com/en-us/azure/devops/pipelines/repos/github?view=azure-devops#tags),
while path filters are defined in terms of changed files on an included branch. Keeping tags path-independent
prevents a later release tag from being silently suppressed by an unrelated path decision.

The protected branch subscriptions are recovery signals only. Before authentication, intake requires the checkout to
match the event commit. Automatic recovery continues only for a single-parent commit that changes a reviewed path.
The canonical allowlist is `MARKETPLACE_RECOVERY_PATHS` in `scripts/marketplace-release-intake.mjs`; its unit test
checks the complete list so this guide does not maintain a second copy. A promotable intake exports the exact tag
commit, semantic version, and channel. The deployment's full-history clean checkout then creates a contained detached
`release-source` worktree at that commit and proves its `HEAD`, root, and empty status. Under the
`public-media-prepublication` cutover it restores that exact source's lockfile and runs its deterministic
`--prepublish` media verifier after canonical artifact verification but before AzureCLI obtains the federated
Marketplace identity. This independent gate applies to tag events and protected-main recovery alike; earlier exact
releases retain their historical recovery behavior.

The next anonymous step performs one complete exact-byte Marketplace probe. If the requested version is already
public with matching channel metadata, checksum, archive semantics, and gallery icons, the deployment marks that
proof read-only and skips both Azure federation and `vsce publish`; this is the normal idempotent existing-release
recovery path. A genuinely pending version or temporary public-read outage proceeds to the unchanged WIF task and the
bounded post-publish verifier. A conflicting or malformed public version fails immediately and is never republished.
This removes private identity and PAT-profile availability from no-op recovery without weakening a new publication.
