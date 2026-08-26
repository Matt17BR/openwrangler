# Releasing

## Current release train

Open Wrangler has three deliberately separate paths. None depends on a 1.99.7 release event.

1. `.github/workflows/daily-preview.yml` produces a tagless, disposable build from protected `main` each day. It
   assigns a source-derived `0.<odd>.<patch>` identity that cannot equal the checked-in release version, builds and
   checks one VSIX, then installs those exact bytes in stable VS Code for a short CSV/grid/sort/cleanup journey. A
   passing VSIX is retained for 14 days. It does not create a tag, GitHub Release, checksum/provenance bundle, or
   registry publication and is not a release candidate.
2. `.github/workflows/release-candidate.yml` is a manual, nonpublishing qualification run. It validates stable
   metadata on protected `main`, builds one production VSIX, and passes that VSIX, checksum, and provenance to ten
   expanded jobs. Those jobs cover Linux, macOS, Windows, first-use Python/Jupyter, native R 4.4 and 4.5, Remote SSH,
   and installed performance. The candidate and qualification receipt are retained for 30 days. Editor diagnostics
   are uploaded only when a phase fails, and no candidate job can publish.
3. `.github/workflows/stable-release.yml` accepts only `candidate_run_id` and `release_tag`. Its read-only selector
   requires a successful candidate and unexpired candidate, qualification, and performance artifacts. The protected
   `publishing` job checks out that candidate's source, downloads the three exact artifact IDs from that run, and
   revalidates source, bytes, checksum, provenance, performance, and qualification. It never builds or packages. It
   creates or verifies the tag and GitHub Release only. Open VSX and Microsoft Marketplace then consume that public
   GitHub release through their own protected publishers.

Fix deterministic failures before retrying. For an infrastructure failure, rerun all jobs so packaging, acceptance,
performance, and qualification share one run-attempt suffix. A source change needs a new candidate. Artifact expiry,
replacement, receipt mismatch, failed checks, or a public-byte conflict invalidates publication. After a tag or
registry write, recovery verifies existing bytes and never rebuilds, retags, or overwrites a conflict.

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
candidate's already-qualified bytes without rebuilding them or adding a time-based waiting period. Releases through v1.2.2 predate this branch policy. Automatic `main`
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

Repository development and automation use exactly Node.js 24.19.0 from `.node-version`; that release supplies the declared npm 11.17.0 package manager. GitHub workflows consume the version file directly. Azure Marketplace recovery
duplicates the same exact Node value because it may inspect historical tags that predate the file, and workflow
contracts keep that duplicate synchronized. The supported development engine range is `^22.22.0 || ^24.0.0`; Node 23 is intentionally excluded. A pull request also runs one bounded Node 22.23.2/npm 10.9.8 compatibility smoke.
The minimum extension-host contract remains independently pinned to `engines.vscode` `^1.106.0`, `@types/vscode` 1.106.0, and `@types/node` 22.20.1. The development pin remains repository tooling and is excluded from the VSIX.
`npm run check` includes the strict dependency-only TypeScript graph, and `npm run audit:node` audits the full
development tree.

Every repository, CI, candidate, packaging, promotion, and release install uses `npm ci --ignore-scripts`; `.npmrc`
makes the same boundary the contributor default. `npm run check:install-policy` checks every GitHub and Azure install
and rejects any unowned or plain install, lifecycle re-enablement, rebuild, package-manager alias, dynamic
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
candidate requires explicit review, qualification of those same bytes, and a separate protected promotion.

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

The only bundled extension-host runtime is `dist/extension/vendor/js-yaml.js`, copied from the installed js-yaml
CommonJS entrypoint during production and test builds. The build verifies the package name and CommonJS entrypoint,
copies the file exactly, and rejects a noncanonical repository root, symbolic-link source files or parent directories,
oversized files, and unexpected output siblings. Regular hard-linked package files are allowed: staging copies their
bytes into a new temporary file, and replacing the generated vendor pathname never mutates another link to the old
inode. The VSIX inventory requires that one bounded regular file and includes its bytes in the package receipt and
reproducibility checks. js-yaml remains a development dependency, and `npm run license:check` requires the installed
MIT license text in `THIRD_PARTY_NOTICES.md`. Routine compatible updates do not require hard-coded byte counts or
release hashes.

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

Release candidates deliberately sample installed behavior instead of repeating every unit and scheduled test. Linux
runs the complete installed VS Code journey plus the released Python/Jupyter first-use profile. macOS and Windows run
the focused platform smoke. Linux R 4.4 runs core operations, native frames, and kernel restart in three fresh editor
phases; macOS and Windows run one representative R 4.5 core journey each. The direct R/runtime/webview suites remain
the exhaustive operation owners. Remote SSH and installed performance each have a separate job.

Every consumer downloads the package job's numeric artifact ID and verifies the VSIX/checksum/provenance set before
use. The package job is the only production builder. Each editor phase retains its 300-second hard deadline,
180-second changed-checkpoint inactivity deadline, private profile, and failure-only sanitized diagnostic upload.

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
candidate exercises the native R notebook tooling in depth. Cursor does not own an R literate-document row. The current prior-27 suites plus
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

Historical macOS and Windows Cursor evidence used the fixed official `downloads.cursor.com` packages. `scripts/cursor-acquisition.mjs` retains those recovery receipts and the current Linux Cursor 3.13.10 receipt for the scheduled compatibility seam. Installed performance acquires only official VS Code 1.130.0 Linux x64 (`356,926,919` bytes, SHA-256 `7d6ad3d3a78ac4551c14631f78d7e03c85282ab505c3ce8b1bc04e01fafe88ea`); the Cursor seam uses its separately pinned Linux x64 package (`209,277,476` bytes, SHA-256 `8a5b734be3bccc3de6daf96c536daa644c715e5fe3e5eaf21721538072ea104c`). A target change requires updating those receipts and their tests in one reviewed pull request. Every downloaded editor package is a temporary test input under one disposable per-run private root: never commit, bundle in the VSIX, cache as a release output, upload, publish, or redistribute it.

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

Release-candidate acceptance, rather than this manual workflow, owns focused macOS and Windows native-R smoke jobs
plus the Linux native-frame and restart journeys. Local Windows file menus are hidden, while remote-resource and Command Palette entry points remain
available because static client keys cannot identify the extension-host platform. The runtime guard is authoritative;
remote R-document execution is experimental and is not part of the release matrix.

Both remote fixtures are unprivileged, read-only containers with no host mounts and one loopback port. Their credentials are generated inside the runner and are never workflow secrets or environment values. Cleanup revalidates the exact Docker engine and removes resources in reverse acquisition order: container, runtime image, then the R base image when present. Every removal must be provable or the run publishes no evidence path and leaves the private root in place for investigation. The fixture locks are excluded from the VSIX but remain release inputs: `npm run audit:remote-jupyter` scans both complete locks without advisory suppressions, and `npm run lock:remote-jupyter:check` must reproduce their committed bytes with the exact tool, target, and cutoff documented in `docs/testing.md`.

A released-Jupyter run is not release evidence while freshly executed MIME-v2 output remains unacknowledged by the renderer; successful host MIME emission or the separately green saved-output renderer path cannot make that gate green.

The packaged split-notebook renderer-provenance scenario proves notebook B is active immediately before dispatching notebook A's visible renderer action with a real user click. Synthetic DOM activation cannot satisfy this release gate. The run must retain the exact notebook A/B origin, variable, kernel, insertion, and cleanup assertions, including that notebook B never receives notebook A's session. Bounded timeout diagnostics may contain only safe origin classifications, coordinator state, and A/B generation/execution counters.

Linux packaged-editor release gates use VS Code in the isolated zero-window headless mode described in `docs/testing.md`. Candidate jobs remove desktop and editor IPC state, use private runtime/profile directories, verify the downloaded candidate immediately before the installed phase, and retain only sanitized failure diagnostics after process cleanup is proven. macOS and Windows jobs use the same candidate bytes and focused platform smokes; the Windows harness keeps its Job Object ownership check. The release candidate does not run Cursor. Scheduled compatibility CI owns the pinned Cursor lifecycle/responsive-grid/reveal-state seam, so fork coverage stays visible without duplicating the release matrix.

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
default-branch GitHub page is never accepted. This versioned contract starts at `1.2.1`;
an older exact release recovery skips both browser installation and this check so a new media inventory cannot
invalidate historical publication.

The deterministic inventory, exact-source, ancestry, and immutable-byte portion runs with `--prepublish` in the
release-candidate package job before any tag, release, or registry mutation. It requires the README media commit to be a
reachable ancestor of the exact release source in the selected full-history checkout. Recovery promotion runs it
for `1.99.4` and later from the exact checked-out release's script and restored lockfile before registry authentication
or publication; older releases predate that browser-free capability and retain their existing recovery behavior. This mode never launches
Chromium or reads a registry page. Public rendering is necessarily a separate post-publication observation gate: GitHub and registry writes have
already occurred before those pages can be inspected. A failure marks the promotion workflow failed and requires remediation or a
new release, but it cannot undo or roll back already-public immutable release or registry bytes. It never makes a
deterministic pull-request lane depend on registry pages.

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
and ready changes. JavaScript/TypeScript checks run for every change; Python, R, package/editor, web, and Windows jobs
are selected by path. Missing or malformed classification runs every lane, and the final `validate` job blocks merge
for every selected failure or unknown result. Scheduled/manual Cross retains its
macOS/Windows runtime, Windows dependency checks, the exact `python-runtime-dependency-cohorts` job that installs and
exercises every declared dependency/Python qualification pair, and R 4.4 qualification. CodeQL runs explicit always-on JavaScript/TypeScript
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
Focused workflow tests parse the release-candidate, stable-release, candidate-acceptance, Open VSX, and Marketplace
files. They check the properties that protect a release: one package build, exact artifact handoffs, full-SHA GitHub
actions, read-only defaults, protected publishers, and no rebuild in a registry job. They do not freeze whole YAML
files or require a particular dependency version merely because yesterday's workflow used it. Workflow changes still
run the normal CI owners selected for their affected paths.

Do not turn a release pull request into one oversized squash commit. Keep each independently reviewable product,
runtime, test, media, and documentation slice in its own commit. If a pull request contains several such commits,
merge it without squashing so the boundaries remain visible on `main`. The final release commit changes only the
version, changelog, release notes, and required release metadata.

Pull-request CI builds and verifies one VSIX inside the package-and-editor job and tests it in stable VS Code. It does
not pass that VSIX between jobs or retain successful-run artifacts. Failed visual checks and sanitized packaged-editor
diagnostics may be uploaded for seven days. Remote SSH remains part of release-candidate acceptance rather than an
opt-in pull-request job. Release and stable-performance workflows keep their separate artifact and provenance checks.

`npm run docs:check` parses the three candidate and stable workflow files. The package job owns the only production
build. Seven installed acceptance jobs consume its numeric artifact ID: Linux owns the full product and released
Python/Jupyter journey; macOS and Windows own focused installed smokes; Linux owns R lifecycle, frames, and restart;
macOS and Windows own one R 4.5 smoke each; and the last job records installed performance. Remote SSH runs beside
them. The final receipt is written only after packaging, installed acceptance, performance, and Remote SSH succeed.
Candidate jobs are read-only, GitHub actions use full commit SHAs, and consumers cannot rebuild the VSIX.

Stable release is a later independent dispatch. Selection is read-only; GitHub publication alone receives
`contents: write` inside the protected environment. Cross-run downloads bind the selected run and each numeric
artifact ID. The receipt binds the run attempt, stable tag, source SHA, VSIX bytes and digest, acceptance results, and
performance report. Missing, skipped, cancelled, expired, changed, or conflicting evidence fails. A complete rerun
is supported because artifact names and the receipt carry the workflow-attempt number. The candidate source must
still equal the current protected `main` commit; if `main` advanced, qualify a new candidate instead of publishing an
older ancestor.

The Linux native-R candidate job provisions packages once and runs core, native-frame, and kernel-restart journeys.
The macOS and Windows jobs each run one native-R core smoke. Exhaustive value, categorical, terminal, and document
selectors remain owned by pull-request or focused manual workflows instead of being repeated in every release cell.
The pinned dependency action reconciles the resolved lock and may restore a compatible versioned cache created
by an earlier candidate dispatch on `main`. GitHub's pull-request merge-ref cache is not available to the release
dispatch, so the first matching `main` dispatch performs a valid cold install. The cache is neither immutable package
pinning nor supply-chain evidence. Protected pull-request CI remains the direct owner for the deeper R contracts.

Candidate qualification keeps sibling cancellation disabled so each owner can finish cleanup and emit failure-only
diagnostics, but any failed, cancelled, or skipped owner prevents the qualification receipt. A failed candidate is
never promoted. The stable workflow has no rehearsal or publish toggle: it promotes one already-qualified candidate
selected by run ID.

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

GitHub publication calls the one reusable Open VSX workflow after the public release is complete. That workflow
verifies the tag and all three canonical assets, publishes with the lockfile-owned `ovsx` CLI, and checks the public
bytes. An explicit recovery dispatch uses the same publisher. The protected environment supplies `OVSX_PAT`; the
caller does not inherit or forward unrelated secrets. The shared `openwrangler-release-publication` queue serializes
publishers without replacing an older pending request. If Open VSX is unavailable, the GitHub release remains
available for a safe retry; nothing is rebuilt or replaced.

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
workflow defines no draft-only check name. Readiness and merge eligibility remain repository-policy decisions outside CI path selection. When
several ready pull requests share a base, merge them one at a time so strict up-to-date protection does not spend time
on runs that will immediately become stale. Dependabot checks npm, Python, and GitHub Actions on separate UTC days,
groups compatible minor and patch updates by ecosystem, and leaves major and security updates separate.

Dispatch **Release candidate** from protected `main` after the intended stable tag and version metadata are reviewed.
The run cannot publish. When it succeeds, dispatch **Stable release** with that run ID and the same tag. There is no
week-long timer. If an infrastructure failure needs a retry, rerun the whole candidate workflow so all three retained
artifacts belong to the same attempt. Do not create the tag manually or use publication as a rehearsal.

The shared candidate validator binds the requested runner label to its own input variable. Do not use a `RUNNER_*`
name for that value: GitHub reserves those variables for host metadata and ignores attempts to override them.

## Registry publication

Both registries are final release steps and may run only after the `Matt17BR` publisher or namespace is owned and
authorized. Publisher identity conflicts stop the release rather than changing the package identity. Microsoft's
optional domain badge is not required; Open VSX must report the publishing account verified for the `Matt17BR`
namespace. Never store tokens in repository files, workflow text, artifacts, or logs.

GitHub Releases remain the source-of-truth distribution channel. One Open VSX workflow handles the stable workflow's
handoff and explicit recovery for an existing tag. Visual Studio Marketplace promotion stays in Azure Pipelines because its
publisher identity lives in Azure DevOps. Neither registry path may rebuild the VSIX.

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

`.github/workflows/open-vsx-promotion.yml` is the only Open VSX publisher. The stable workflow calls it once after
GitHub publication; an explicit dispatch recovers an existing release. It checks out reviewed automation separately
from the release tag and downloads the GitHub Release's VSIX, checksum, and provenance. Only token verification and
publication receive the protected environment's `OVSX_PAT`. The job rejects conflicting public bytes, uses
`ovsx --skip-duplicate`, and then verifies the published metadata, checksum, download, and gallery icon instead of
parsing human-readable CLI output. Preview packages must carry matching preview provenance and the VSIX pre-release
marker.

For releases from `1.2.1` onward, after Open VSX and the immutable tag pass, the publishing path installs Chromium
from the reviewed lockfile and runs the media verifier against the exact release source. This keeps a historical
release tied to its own screenshot inventory when `main` has moved on. All declared
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
against its exact protected source. For `1.99.4` and later, Open VSX recovery restores the exact release checkout's
lockfile and runs that checkout's immutable-byte verifier before its PAT step. The later Chromium pass remains
required because only it can observe the rendered public pages; qualifying recovery installs Chromium through that
same release-local Playwright, while older exact releases retain their historical current-automation pairing.

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
both capabilities. Rendered public-media verification is skipped below `1.2.1`; newer releases use the verifier and
inventory in their exact tag. Browser-free recovery prepublication begins at `1.99.4`, the first release carrying
that mode; older exact-tag recovery does not apply a future inventory to historical media. Repeating the dispatch is safe only when
the registry already serves identical bytes; a conflict fails without replacement. Do not dispatch from an old
release tag, because historical releases intentionally do not contain the reviewed automation.

### Automatic Microsoft Marketplace promotion

`azure-pipelines-marketplace.yml` starts automatically only for immutable `v*` Git tags; ordinary `main` pushes do
not start a publishing pipeline. A manual run may name an existing release tag for recovery. Intake exports the exact
tag commit, semantic version, and channel. The deployment checks out that source, downloads the public GitHub release,
and verifies it before AzureCLI obtains the federated Marketplace identity. Because the tag is pushed immediately
before GitHub publication, this handoff polls for at most five minutes (30 attempts, ten seconds apart), not hours.

The next anonymous step performs one complete exact-byte Marketplace probe. If the requested version is already
public with matching channel metadata, checksum, archive semantics, and gallery icons, the deployment marks that
proof read-only and skips both Azure federation and `vsce publish`; this is the normal idempotent existing-release
recovery path. A genuinely pending version or temporary public-read outage proceeds to the unchanged WIF task and the
bounded post-publish verifier. A conflicting or malformed public version fails immediately and is never republished.
This removes private identity and PAT-profile availability from no-op recovery without weakening a new publication.
