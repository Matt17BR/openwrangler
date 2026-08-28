# CI and release checks

## Pull requests

Every pull request runs the same five owners:

- **Source contracts (Node 24)** runs formatting, lint, TypeScript types, generated protocol/reference checks,
  documentation checks, dependency-lock checks, licenses, `npm run test:scripts`, and Vitest.
- **Python runtime contracts** runs Ruff, Pyright, and Pytest with the declared Python and PySpark dependencies.
- **Native R frame and transport contracts** installs the R 4.5 lock and runs the two direct R shards.
- **Packaged VS Code smoke** builds and verifies one VSIX, then opens those exact bytes in stable VS Code with the
  `platform-smoke` / `daily-core` selector.
- **Windows filesystem and process contracts** runs only Windows-specific export, dependency, and shutdown cases.

There is no path classifier. The inline `validate` job has no repository checkout or custom parser; it requires all
five job results to equal `success`. The separate CodeQL gate remains required by branch protection.

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

Daily preview, manual preview publication, release-candidate qualification, and stable publication remain separate
transactions:

- Daily preview builds a disposable package from protected `main` and runs its existing installed VS Code journey.
- Manual preview publication packages one canonical `v1.99.7` artifact from protected `main` and installs those exact
  bytes in stable VS Code with the existing `daily-core` selector before any public mutation. Publication is explicit.
- Release candidate validates protected `main`, packages once, and passes the same canonical artifact to its existing
  installed and external consumers.
- Stable publication selects a successful candidate and promotes its already-recorded bytes. It does not rebuild the
  extension.

The workflows themselves are authoritative for their current inputs and schedules. See [Releasing](releasing.md) for
the operator sequence. These release paths are not additional pull-request source-test owners.

## Reading a red check

Start with the failing owner. Source, Python, R, installed-package, and Windows failures should each identify the
boundary that regressed. A red `validate` result means at least one of those owners did not succeed.

Do not retry a deterministic failure to make it green. Fix the product or prerequisite, classify an external outage,
or remove a check that cannot name a distinct failure. Third-party workflow actions remain commit-pinned, and write
permission belongs only to publication jobs.
