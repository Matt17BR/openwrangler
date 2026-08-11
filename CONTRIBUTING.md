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

To install the current checkout in VS Code or Cursor without running the release matrix:

```bash
npm run package:dev
code --install-extension openwrangler-dev.vsix --force
# or: cursor --install-extension openwrangler-dev.vsix --force
```

## Writing for people

Read [`docs/writing-style.md`](docs/writing-style.md) before editing the README, changelog, issues, pull request text,
release notes, registry listings, screenshots, or other public copy. Lead with the user-visible change, keep
architecture and test proofs in their own documents, and use a concrete commit subject. Public text needs a real
editorial read; do not rely on an AI detector or a word list.

## Pull requests

- Target `main` for all work. Use a short-lived branch and pull request for each change.
- `main` is current development. Release preparation uses short-lived `release/*` branches before publication from
  the exact merged commit. The protected `stable` branch starts with the verified 2.0 release and advances only to
  releases published on all three registries.
- Keep a pull request limited to one documented milestone or issue. Split unrelated work into separate pull requests.
- Give each commit one reviewable purpose. Product code may travel with its directly related tests and required docs;
  keep unrelated product slices, test-harness changes, generated media, standalone docs/metadata, and release/version
  changes separate. Use rebase merge when a pull request has several reviewable commits; squash only when the pull
  request is already one coherent commit.
- Add or update tests with every behavior change.
- Keep Pandas, Polars, and DuckDB implementations native. An operation change must include live-runtime and executable generated-code coverage for every editing-capable engine.
- Update the documentation listed in the `AGENTS.md` matrix.
- Review user-facing text and pull request summaries against `docs/writing-style.md`.
- Add and review `docs/release-notes/<version>.md` in every release pull request; the publisher does not generate it.
- A release pull request contains only the version bump, changelog, release notes, and release metadata. Merge
  product, test-harness, media, and unrelated documentation work first.
- Run `npm run generate:reference` after changing commands, settings, operations, protocol messages, or notebook MIME types; never hand-edit `docs/reference.md`.
- Include screenshots for visible changes in light, dark, and high-contrast themes.
- Push independently green branch commits before opening a pull request when early review is not needed. A draft pull request runs bounded feedback and remains non-mergeable until marking it ready reruns the required evidence at the same commit.
- Do not commit generated VSIX files, local virtual environments, editor profiles, notebook execution caches, or user scratch files.

All required checks must pass before merge. Feature work is tested in both VS Code and Cursor before a prerelease.
