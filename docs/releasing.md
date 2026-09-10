# Releasing

Daily previews, release-candidate qualification, and stable publication are separate stages. Once an artifact enters
qualification, do not rebuild it, replace it, or move its tag.

## Release change

A release pull request contains only:

- the `package.json` version and channel metadata;
- the PEP 440-equivalent `python/openwrangler_runtime/version.py` value;
- `CHANGELOG.md`;
- `docs/release-notes/<version>.md`; and
- release metadata required by the existing workflows.

Use [the writing guide](writing-style.md) for release notes. Land product changes, tests, generated media, and unrelated
documentation before the release pull request.

## Version and channel policy

Numeric `0.<odd-minor>.x` versions are preview bands. The manual `1.99.N` preview series ends at `1.99.7`.

Automatic daily previews use `x.y.YYYYMMDD`. The latest canonical stable tag reachable from the protected `main`
source commit chooses `x.y`; the workflow requires a full checkout to prove that tag. A pre-v2 stable tag keeps the
`1.99.YYYYMMDD` compatibility series. For example, daily previews remain `2.0.YYYYMMDD` until a stable `v2.1.0` tag
becomes reachable, after which they use `2.1.YYYYMMDD`.

The dated patch field is intentional and is not a stable patch number. It may be numerically higher than a
conventional patch in the same minor line. An intended manual stable release normally advances the minor `y`, so a
release after the 2.0 preview line may be `2.1.0`. Reserve a major `x` increment for a substantially larger feature or
architectural shift.

Every preview requires `package.json.preview` to be `true`; every stable release requires it to be `false`. Package
verification rejects a VSIX whose embedded manifest uses the wrong channel.

## Source and package commands

Use the Node and npm versions in `.node-version` and `package.json`. Install dependencies without lifecycle scripts:

```bash
npm ci --ignore-scripts
python3 -m venv .venv
.venv/bin/python -m pip install -e "python[dev]"
```

Run the source checks, then create and verify one package:

```bash
npm run check:pr
npm run clean
npm run build
npm run package:prepared -- --out openwrangler.vsix
npm run verify:vsix -- openwrangler.vsix
```

`npm run check:pr` runs `npm run check` and `npm test`. `package:prepared` does not repeat source checks or rebuild the
project. The installed smoke described in [Testing](testing.md) uses this same verified VSIX.

Packaging verifies the staged archive's canonical form, then compares the published descriptor snapshot with those
exact bytes before reusing its receipt. Final file identity, link count, source inventory and manifest checks remain
required. A changed output fails and only owned files are removed.

`npm run package:dev` is for local development. Its output is not a release candidate and must not be committed. The
README links to the [source installation steps](../CONTRIBUTING.md); its generated installation block lives in
`scripts/release-documents.mjs`. The stable badge reads GitHub's latest stable release, while registry badges link to
installation without presenting a preview version as stable.

## Daily preview

The schedule checks for new commits before checking out source or installing dependencies. If protected `main` has
the same commit as the last successful scheduled run of `preview-release.yml`, it skips packaging and publication.
The first run, or any new commit, builds a preview. Failed and cancelled runs do not advance this baseline; a skipped
run preserves it. If the run history cannot be read, the check fails instead of assuming nothing changed. Manual
dispatches bypass this comparison.

On schedule, `.github/workflows/preview-release.yml` reads the run's UTC `created_at` timestamp and finds the latest
stable tag reachable from that protected `main` commit. It creates a deterministic single-parent child bound to the
stable tag and changes only `package.json`, `package-lock.json`, and
`python/openwrangler_runtime/version.py`.

Daily release notes start with a link to the previous published canonical preview and list merged PRs once each.
They show five entries, with the remaining changes and full source comparison under **Read more**. Short lists keep
the comparison visible. If no preview has been published, the introduction links to the bound stable release instead;
an empty range is stated explicitly.

The first-attempt package job selects the previous preview by publication time and records its verified tag, source
commit and PR attribution in job outputs. PR numbers, titles and commit membership are frozen together. Unpublished
attempts, skipped schedules, drafts and stable releases do not advance this notes baseline.

Comparison endpoints replace generated daily commits with their protected-main parents. PR attribution requires a
merged PR targeting this repository's `main`, with its merge commit in that exact source range. Unmatched commits keep
their own linked subjects. Mixed changes, including dependency, configuration, changelog and curated-note edits, remain
included; only changes confined to version/channel fields in the three version files are omitted. Incomplete or
ambiguous attribution and exceeded history, snapshot or note-size bounds stop preparation instead of truncating the
list. Stable and manual-preview releases keep their checked-in curated notes.

The workflow packages one VSIX with its checksum and provenance receipt, then installs those bytes in stable VS Code
with the `daily-core` selector, using the base Python dependencies for CSV viewing and saved-notebook rendering.
After that check passes, the protected job creates the lightweight tag and GitHub
prerelease, sends the same public files to Open VSX, and lets the tag start the Azure Marketplace pipeline. A failed
check publishes nothing; fix `main` and let the next scheduled run create a new candidate.

## Manual preview publication

The only manual `1.99.N` fallback is a dispatch of `.github/workflows/preview-release.yml` from protected `main` with
`release_tag` set to `v1.99.7`. With the default `publish: false`, the workflow packages and checks one VSIX without
creating a release. Set `publish: true` only when that run should publish the checked bytes.

Preview packaging runs only on the first attempt of a workflow run. If packaging fails, start a new run; rerunning
the package job is refused before checkout or setup. If the GitHub **Publish preview** job fails, rerun only that job
in the same workflow run while its stable-tag binding is still current. It reconstructs the same source and reuses
the same artifact and frozen notes inputs. Publication revalidates the baseline's tag and provenance and requires the
existing draft or public release body to match exactly; it never selects a newer preview or rereads PR titles during
recovery. Missing notes outputs, moved tags, conflicting provenance or a nonancestor source stop publication. If a newer
stable tag is now reachable, discard the old candidate and run the workflow again.
To recover an Azure Marketplace failure, run its pipeline from current protected `main` with `existingReleaseTag`
set to the same tag. Recovery verifies the existing tag and GitHub files and never rebuilds or replaces them.

## Release candidate

From protected `main`, dispatch `.github/workflows/release-candidate.yml` with `release_tag` set to the reviewed stable
tag. Use a new first-attempt run; do not rerun a failed or cancelled candidate.

The workflow verifies the tag, source commit, and stable metadata, then builds the VSIX once. It binds that VSIX to a
SHA-256 checksum and provenance receipt. It also audits the full Node lock, published Python dependencies, and optional
runtime packages.

Stable qualification requires every required Pandas/Polars row in [feature parity](feature-parity.md) to be Done with
its expected backend availability and tracked evidence. Ordinary source checks permit documented limitations so
maintenance can record them accurately; passing those checks does not establish release readiness.

The workflow runs the installed-performance check in pinned VS Code and a bounded platform smoke in pinned Linux
Cursor against the exact candidate. Cursor does not receive the full VS Code qualification matrix. Both checks use the
same candidate bytes, and neither rebuilds the extension.

If every check passes, keep the workflow run ID for stable publication. If the run fails or is cancelled, correct
protected `main` and dispatch a new candidate.

## Stable publication

From protected `main`, dispatch `.github/workflows/stable-release.yml` with `candidate_run_id` set to the successful
candidate run and `release_tag` set to its matching stable tag. The workflow accepts only a successful first-attempt
candidate whose source remains in protected `main`.
Candidate selection needs only Node and Git. Publication dependencies are installed in the separate promotion job.

The stable workflow is also first-attempt-only: it requires `github.run_attempt == 1`. If it fails before creating the
exact GitHub Release, start a fresh stable-release dispatch. Once that release exists, use only the registry recovery
steps below.

The workflow downloads the candidate VSIX, checksum, and provenance receipt and verifies their source and tag binding.
It then publishes or verifies the exact lightweight tag and GitHub Release, and sends the same VSIX to Open VSX. The
tag starts the Azure Marketplace pipeline, which publishes the same file from the GitHub Release. No publication step
rebuilds the extension.

A moved tag, changed artifact, metadata mismatch, or conflicting registry version stops publication. Never overwrite a
different public package.

## Recovery

Treat an existing release tag and its assets as immutable. Before retrying a registry publication, verify the tag,
source commit, VSIX, checksum, and provenance receipt. Never rebuild historical bytes, move a tag, or replace a public
package.

A maintainer may correct the title or notes of a completed GitHub release separately. Preserve the previous text and
verify that the tag, source and asset identities remain unchanged. This editorial correction does not authorize a new
publication or relax the publisher's exact-body check; replaying the old GitHub publication against edited notes will
still refuse the mismatch. Registry recovery below uses the existing artifacts.

To recover Open VSX publication, dispatch `.github/workflows/open-vsx-promotion.yml` from protected `main` with
`release_tag` set to the existing release tag. The workflow downloads the GitHub Release files, verifies them, and
publishes the same VSIX or accepts an exact existing copy. Open VSX verification uses the requested version's
`preRelease` flag and exact package bytes. The extension-wide `preview` label does not determine a historical version's
channel.

To recover Azure Marketplace publication, run the configured Azure Marketplace pipeline defined by
`azure-pipelines-marketplace.yml` from current protected `main` with `existingReleaseTag` set to the same tag. It
verifies the existing tag and GitHub Release files and does not rebuild or replace them.

Keep publication credentials out of repository files, workflow text, artifacts, and logs.

Public release downloads and registry verification give each request, including its response body, a 15-second
deadline. Interrupted transports retry within the existing polling budget and report fixed messages without raw
transport details. Metadata, size, checksum, and source-identity conflicts remain fatal.
