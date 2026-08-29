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

`npm run package:dev` is for local development. Its output is not a release candidate and must not be committed.

## Daily preview

On schedule, `.github/workflows/preview-release.yml` reads the run's UTC `created_at` timestamp and finds the latest
stable tag reachable from that protected `main` commit. It creates a deterministic single-parent child bound to the
stable tag and changes only `package.json`, `package-lock.json`, and
`python/openwrangler_runtime/version.py`.

The workflow packages one VSIX with its checksum and provenance receipt, then installs those bytes in stable VS Code
with the `daily-core` selector. After that check passes, the protected job creates the lightweight tag and GitHub
prerelease, sends the same public files to Open VSX, and lets the tag start the Azure Marketplace pipeline. A failed
check publishes nothing; fix `main` and let the next scheduled run create a new candidate.

## Manual preview publication

The only manual `1.99.N` fallback is a dispatch of `.github/workflows/preview-release.yml` from protected `main` with
`release_tag` set to `v1.99.7`. With the default `publish: false`, the workflow packages and checks one VSIX without
creating a release. Set `publish: true` only when that run should publish the checked bytes.

If the GitHub **Publish preview** job fails, rerun only that job in the same workflow run while its stable-tag binding
is still current. It reconstructs the same source and reuses the same artifact. If a newer stable tag is now
reachable, discard the old candidate and run the workflow again. To recover an Azure Marketplace failure, run its
pipeline from current protected `main` with `existingReleaseTag` set to the same tag. Recovery verifies the existing
tag and GitHub files and never rebuilds or replaces them.

## Release candidate

Dispatch `.github/workflows/release-candidate.yml` from the protected `main` commit with the reviewed stable tag. The
workflow validates the tag, metadata, and source; packages once; verifies the VSIX, checksum, and provenance receipt;
and audits the full Node lock plus published Python dependencies. It does not repeat the pull-request source-test
graph.

The candidate job installs the same VSIX in pinned VS Code for the installed-performance check and in pinned Cursor
for platform smoke. It verifies the files again between consumers and uploads only that artifact triple. Stable
publication may select only a successful candidate run. If a candidate fails or is cancelled, correct `main` and
create a new one.

## Stable publication

Dispatch `.github/workflows/stable-release.yml` with the successful candidate run ID and matching release tag. The
workflow checks out the candidate's source, verifies its recorded files, and publishes the same VSIX bytes without
building again.

Only the protected publication job can write the tag and GitHub Release or publish to Open VSX. The lightweight tag
starts the protected Azure Marketplace pipeline, which downloads the same GitHub Release artifact. A moved tag,
changed artifact, metadata mismatch, or registry conflict stops publication instead of overwriting public state.

Registry publication starts from the files on GitHub Releases. README and gallery media remain ordinary source files
and do not gate registry publication.

## Recovery

Start from an existing tag or GitHub Release. Verify its checksum, provenance receipt, source commit, and VSIX before
any registry action. Never rebuild historical bytes, move a release tag, replace a public package, or put credentials
in repository files, workflow text, artifacts, or logs.

Use `.github/workflows/open-vsx-promotion.yml` only through its documented release or protected-`main` recovery inputs.
The Azure Marketplace pipeline remains the Microsoft registry publisher. The workflow files define the current
permissions and supported recovery cases.
