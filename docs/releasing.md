# Releasing

Open Wrangler keeps daily preview, manual preview publication, release-candidate qualification, and stable publication
separate. Do not rebuild, replace, or retag an artifact after it has entered qualification.

## Release change

A release pull request contains only:

- the `package.json` version and channel metadata;
- the PEP 440-equivalent `python/openwrangler_runtime/version.py` value;
- `CHANGELOG.md`;
- `docs/release-notes/<version>.md`; and
- release metadata required by the existing workflows.

Write the release notes using [the writing guide](writing-style.md). Product changes, test changes, generated media,
and unrelated documentation land before the release pull request.

Numeric `0.<odd-minor>.x` and `1.99.x` versions are preview bands and require `package.json.preview` to be `true`.
Other numeric versions require it to be `false`. The package verifier rejects a VSIX whose embedded manifest disagrees
with that channel.

## Source and package commands

Use the repository's exact Node/npm pair from `.node-version` and `package.json`. Install the lock without lifecycle
scripts:

```bash
npm ci --ignore-scripts
python3 -m venv .venv
.venv/bin/python -m pip install -e "python[dev]"
```

Run the direct source contract, then create and verify one package:

```bash
npm run check:pr
npm run clean
npm run build
npm run package:prepared -- --out openwrangler.vsix
npm run verify:vsix -- openwrangler.vsix
```

`npm run check:pr` runs `npm run check` followed by `npm test`. `package:prepared` does not rerun source checks or
rebuild the project. The exact-artifact installed smoke is documented in [Testing](testing.md); it consumes the same
verified VSIX path.

`npm run package:dev` is for local development only. Its output is not a release candidate and must not be committed.

## Daily preview

`.github/workflows/daily-preview.yml` builds a disposable package from protected `main` and runs its existing stable
VS Code smoke. It creates no stable tag or registry publication and cannot be promoted as a release candidate.

## Manual preview publication

Dispatch `.github/workflows/preview-release.yml` from protected `main` with `release_tag` set to `v1.99.7`. The default
`publish: false` run validates preview metadata, packages one canonical VSIX/checksum/provenance triple, and installs
that exact VSIX in stable VS Code with the existing `daily-core` selector. A failed qualification run creates no tag
or release; fix the source and qualify it again.

Set `publish: true` only when the same run should publish. The protected job revalidates the recorded triple, creates
or verifies the exact lightweight tag and GitHub prerelease, then dispatches the existing protected-main Open VSX
promoter. The tag starts the existing Azure Marketplace promoter. Both promoters download the public canonical assets
and do not rebuild the extension. An exact existing tag, release, or artifact may resume verification-first recovery;
conflicting public bytes fail closed.

## Release candidate

Dispatch `.github/workflows/release-candidate.yml` from the exact protected `main` commit with the reviewed stable tag.
The workflow validates source metadata, runs the source contract, packages exactly once, and records the canonical
VSIX, checksum, and provenance. Existing consumers receive that recorded artifact identity; they do not package a
replacement.

A failed or cancelled candidate is not promoted. Correct the source on `main` and create a new candidate rather than
rerunning or repairing the old artifact.

## Stable publication

Dispatch `.github/workflows/stable-release.yml` with the successful candidate run ID and matching release tag. The
workflow selects the recorded candidate, checks out its source, revalidates the canonical files, and publishes the
same VSIX bytes. It does not build or package.

Only a protected publication job receives repository write permission. It creates or verifies the lightweight tag
and GitHub Release, then publishes the accepted bytes to Open VSX. The real tag starts the separately protected Azure
Marketplace pipeline, which consumes the same GitHub Release artifact.

GitHub Releases remain the source-of-truth distribution channel. A registry conflict, moved tag, changed artifact,
or mismatched metadata fails instead of overwriting public state.

## Recovery

Recovery starts from an immutable tag or exact GitHub Release. Verify the existing checksum, provenance, source, and
VSIX before any registry action. Never rebuild historical bytes, move a release tag, replace a public package, or put
credentials in repository files, workflow text, artifacts, or logs.

Use `.github/workflows/open-vsx-promotion.yml` only for its documented public-release or protected-main recovery
entrypoints. The Azure Marketplace pipeline remains the Microsoft publication owner. The workflow files are
authoritative for current permissions, inputs, and supported recovery cases.
