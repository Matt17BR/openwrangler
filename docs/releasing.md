# Releasing

Open Wrangler uses one preview workflow for its automatic daily public train and manual fallback, while
release-candidate qualification and stable publication remain separate. Do not rebuild, replace, or retag an artifact
after it has entered qualification.

## Release change

A release pull request contains only:

- the `package.json` version and channel metadata;
- the PEP 440-equivalent `python/openwrangler_runtime/version.py` value;
- `CHANGELOG.md`;
- `docs/release-notes/<version>.md`; and
- release metadata required by the existing workflows.

Write the release notes using [the writing guide](writing-style.md). Product changes, test changes, generated media,
and unrelated documentation land before the release pull request.

Numeric `0.<odd-minor>.x` versions are preview bands. Manual `1.99.N` previews end at `1.99.7`, while automatic daily
public previews use `1.99.YYYYMMDD`; all require `package.json.preview` to be `true`. The next stable version is
`2.0.0`. Other numeric versions require `preview` to be `false`. The package verifier rejects a VSIX whose embedded
manifest disagrees with that channel.

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

The schedule in `.github/workflows/preview-release.yml` reads the workflow run's immutable UTC `created_at` timestamp
and binds that run to version `1.99.YYYYMMDD`. From the exact protected `main` commit, it creates a deterministic
single-parent child that changes only `package.json`, `package-lock.json`, and
`python/openwrangler_runtime/version.py`. The workflow packages one canonical VSIX/checksum/provenance bundle and
qualifies those exact bytes in stable VS Code with the existing `daily-core` selector.

After qualification, the protected publication job creates or verifies the direct-child lightweight tag and GitHub
prerelease, then dispatches the same public assets to the Open VSX and Azure Marketplace promoters. If qualification
fails, correct protected `main` and let a new scheduled run create a new candidate. If only publication fails, rerun
only the failed **Publish preview** job in that workflow run; it reconstructs the same dated source and reuses the same
qualified artifact.

## Manual preview publication

Dispatch `.github/workflows/preview-release.yml` from protected `main` with `release_tag` set to `v1.99.7`. This is the
only manual `1.99.N` fallback. The default `publish: false` run validates preview metadata, packages one canonical
VSIX/checksum/provenance triple, and installs that exact VSIX in stable VS Code with the existing `daily-core`
selector. A failed qualification run creates no tag or release; fix the source and qualify it again.

Set `publish: true` only when the same run should publish. The protected job revalidates the recorded triple, creates
or verifies the exact lightweight tag and GitHub prerelease, then dispatches the existing protected-main Open VSX
promoter. The tag starts the existing Azure Marketplace promoter. Both promoters download the public canonical assets
and do not rebuild the extension. Registry promotion verifies the canonical VSIX, checksum, provenance, channel, and
downloaded public VSIX identity; README image hosting and CDN propagation are not publication inputs. Recover a failed
preview publication only by rerunning the failed **Publish preview** job against the same qualified artifact in the
same workflow run; conflicting public bytes fail closed.

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
or mismatched metadata fails instead of overwriting public state. README and gallery media remain ordinary source
assets and never gate registry publication.

## Recovery

Recovery starts from an immutable tag or exact GitHub Release. Verify the existing checksum, provenance, source, and
VSIX before any registry action. Never rebuild historical bytes, move a release tag, replace a public package, or put
credentials in repository files, workflow text, artifacts, or logs.

Use `.github/workflows/open-vsx-promotion.yml` only for its documented public-release or protected-main recovery
entrypoints. The Azure Marketplace pipeline remains the Microsoft publication owner. The workflow files are
authoritative for current permissions, inputs, and supported recovery cases.
