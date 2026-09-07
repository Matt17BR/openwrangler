# CI and release checks

## Pull requests

Every pull request reports the same five required product checks:

- **Source contracts (Node 24)** runs formatting, lint, TypeScript types, generated protocol/reference checks,
  documentation checks, dependency-lock checks, licenses, `npm run test:scripts`, and Vitest. It then builds the same
  checkout with Node 22.17.0 against the already-installed locked dependencies.
- **Python runtime contracts** runs Ruff, Pyright, and Pytest with the declared Python and PySpark dependencies.
- **Native R frame, kernel, and transport contracts** installs the R 4.5 lock and runs the two frame/transport shards
  plus the native kernel-agent shard.
- **Packaged VS Code smoke** builds and verifies one VSIX, then opens those exact bytes with the `platform-smoke` /
  `daily-core` selector in the declared minimum VS Code 1.106.0 and current stable VS Code.
- **Windows filesystem and process contracts** runs only Windows-specific export, dependency, and shutdown cases.

Source contracts, packaged smoke, and the separate required CodeQL gate run for every change. Python, native R, and
Windows run their full checks unless `scripts/ci-docs-only.mjs` proves that the tested merge only modifies existing
regular, non-executable `README.md` or `docs/**/*.md` files. Each runtime has a cancellable execution job and a short
required-result job. The latter reports success only for completed execution or a proved documentation-only omission.

The proof binds the checkout's merge commit and both parents to the pull-request event. It reads a bounded,
NUL-delimited Git diff; additions, deletions, renames, mode changes, mixed changes, empty diffs, and unavailable or
unrecognized evidence select full checks. A failed proof job or malformed output fails the required result.
Execution jobs remain cancellable. Their result jobs run even after a failed or canceled dependency, so skipped or
canceled execution cannot satisfy a required check when full runtime checks were needed.
Branch protection continues to require all five product checks and CodeQL.

Drafts and ready pull requests use the same jobs. A new commit cancels the older run for that pull request. Successful
pull-request jobs do not upload build output. The packaged smoke may upload its bounded diagnostics only after that
job fails.

## Local equivalents

Use focused commands while iterating. The complete source boundary is:

```bash
npm run check
npm test
```

The exact-artifact installed smoke and its environment are documented once in [Testing](testing.md).

## Scheduled and release workflows

The consolidated preview workflow owns both the automatic daily public train and the manual preview fallback:

- A small check compares protected `main` with the last successful scheduled run before any checkout, dependency
  installation, build, or editor test. An unchanged commit skips packaging and publication with a job-summary reason.
  Failed runs remain eligible on the next schedule, and manual dispatches always reach the existing preview flow.
- Each scheduled run derives its date from that workflow run's immutable UTC creation timestamp and its series from
  the latest canonical stable release tag reachable from the exact protected-main source commit in the full checkout.
  A pre-v2 stable tag retains the `1.99.YYYYMMDD` compatibility series. For v2 and later, the tag's `major.minor`
  selects the series: a source whose metadata has advanced to 2.1 still produces `2.0.YYYYMMDD` while `v2.0.z` is the
  latest stable tag, and switches to `2.1.YYYYMMDD` only after a stable `v2.1.z` tag exists. The run binds one
  deterministic direct child to that stable tag and commit, changes only the three version files, and qualifies one
  canonical VSIX/checksum/provenance bundle in exact stable VS Code with the existing `daily-core` selector. The
  accepted bytes are then published automatically as a GitHub prerelease. GitHub dispatches Open VSX, while the tag
  triggers Azure Marketplace.
- A manual run remains available only for the public `v1.99.7` fallback. It qualifies the same canonical bundle, and
  publication remains explicit through its `publish` input.
- Release candidate trusts the required checks already attached to protected `main` rather than repeating the source
  suites. It validates stable metadata, packages once, audits published dependencies, runs pinned VS Code
  installed-performance, and then runs pinned Cursor platform-smoke against the same reverified canonical VSIX.
- Stable publication selects a successful candidate and promotes its already-recorded bytes. It does not rebuild the
  extension.

The workflows themselves are authoritative for their current inputs and schedules. See [Releasing](releasing.md) for
the operator sequence and failed-publication recovery. These release paths are not additional pull-request
source-test owners.

## Reading a red check

Start with the failing owner. Source, Python, R, installed-package, and Windows failures should each identify the
boundary that regressed.

Do not retry a deterministic failure to make it green. Fix the product or prerequisite, classify an external outage,
or remove a check that cannot name a distinct failure. Third-party workflow actions remain commit-pinned, and write
permission belongs only to publication jobs.
