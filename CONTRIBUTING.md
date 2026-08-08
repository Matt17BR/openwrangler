# Contributing to Open Wrangler

Open Wrangler welcomes bug fixes, tests, documentation, and product improvements. Read `AGENTS.md` and the linked architecture and testing documents before making changes.

## Development setup

```bash
npm ci
python3 -m venv .venv
.venv/bin/python -m pip install -e "python[dev]"
npm run build
npm test
```

Set `OPEN_WRANGLER_PYTHON` when the development interpreter is not `.venv/bin/python`.

## Writing for people

Read [`docs/writing-style.md`](docs/writing-style.md) before editing the README, changelog, issues, pull request text,
release notes, registry listings, screenshots, or other public copy. Lead with the user-visible change, keep
architecture and test proofs in their own documents, and use a concrete commit subject. Public text needs a real
editorial read; do not rely on an AI detector or a word list.

## Pull requests

- Target `main` for 1.x work and `v2` for native R work. Both branches require pull requests and the same protected
  checks. Publication stays on `main` until the first Open Wrangler 2 preview is ready.
- Keep a pull request limited to one documented milestone or issue.
- Keep independently reviewable changes in separate commits. Do not squash a pull request that contains more than
  one coherent product, test, media, or documentation slice; preserve those commits when merging.
- Add or update tests with every behavior change.
- Keep Pandas, Polars, and DuckDB implementations native. An operation change must include live-runtime and executable generated-code coverage for every editing-capable engine.
- Update the documentation listed in the `AGENTS.md` matrix.
- Review user-facing text and pull request summaries against `docs/writing-style.md`.
- Add and review `docs/release-notes/<version>.md` in every release pull request; the publisher does not generate it.
- Keep the final release commit limited to version and release metadata. Feature work must already exist in its own
  reviewed commits.
- Run `npm run generate:reference` after changing commands, settings, operations, protocol messages, or notebook MIME types; never hand-edit `docs/reference.md`.
- Include screenshots for visible changes in light, dark, and high-contrast themes.
- Push independently green branch commits before opening a pull request when early review is not needed. A draft pull request runs bounded feedback and remains non-mergeable until marking it ready reruns the required evidence at the same commit.
- Do not commit generated VSIX files, local virtual environments, editor profiles, notebook execution caches, or user scratch files.

All required checks must pass before merge. Feature work is tested in both VS Code and Cursor before a prerelease.
