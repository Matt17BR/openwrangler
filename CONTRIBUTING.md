# Contributing to Open Wrangler

Open Wrangler welcomes bug fixes, tests, documentation, and product improvements. Read `AGENTS.md`,
[Architecture](docs/architecture.md), and [Testing](docs/testing.md) before making changes.

## Prerequisites

- Git.
- Node.js `24.19.0` with its bundled npm `11.17.0` is the canonical development, CI, and packaging pair. The
  supported development engine range is `^22.22.0 || ^24.0.0`; Node 23 is intentionally unsupported.
- VS Code 1.106 or newer for the Extension Development Host.
- Python 3.10 through 3.14. Python 3.12 is the recommended development version and is the reference version in the
  main CI workflow.

Use npm from the selected Node installation. The lockfile is authoritative; do not substitute another package
manager.

## Clone and install

Clone the repository and install its locked Node dependencies:

```bash
git clone https://github.com/Matt17BR/openwrangler.git
cd openwrangler
node --version
npm ci --ignore-scripts
```

`node --version` should report `v24.19.0`, and `npm --version` should report `11.17.0`.

Dependency lifecycle scripts are disabled by `.npmrc`, and automation repeats `--ignore-scripts` explicitly. Use the
reviewed lock and do not substitute another package manager.

Create a checkout-local Python environment and install the runtime with its development dependencies. The `.venv`
name matters because repository commands discover that environment without shell activation.

On macOS or Linux with Bash or zsh:

```bash
python3.12 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -e "python[dev]"
```

On Windows with PowerShell:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -e "python[dev]"
```

On Windows with Command Prompt:

```bat
py -3.12 -m venv .venv
.venv\Scripts\python.exe -m pip install --upgrade pip
.venv\Scripts\python.exe -m pip install -e "python[dev]"
```

Python 3.10, 3.11, 3.13, and 3.14 are also supported. Use the matching executable or Windows launcher selector when
you need to reproduce a version-specific result.

### Python selection for repository commands

Commands such as `npm run lint:python`, `npm run test:python`, and `npm run reference:check` use the checkout `.venv`
by default. An active absolute `VIRTUAL_ENV` is also accepted. If the development interpreter is elsewhere, set
`OPEN_WRANGLER_PYTHON` to the absolute path of an existing Python 3.10-3.14 executable.

Bash or zsh:

```bash
export OPEN_WRANGLER_PYTHON=/absolute/path/to/venv/bin/python
```

PowerShell:

```powershell
$env:OPEN_WRANGLER_PYTHON = "C:\absolute\path\to\venv\Scripts\python.exe"
```

Command Prompt:

```bat
set "OPEN_WRANGLER_PYTHON=C:\absolute\path\to\venv\Scripts\python.exe"
```

`OPEN_WRANGLER_PYTHON` selects Python for repository and visual-test commands. It does not configure the extension
running in an Extension Development Host. The extension uses the environment selected by the Python extension, then
a supported system interpreter. Set `openWrangler.pythonPath` to an absolute executable path when the development
host needs an explicit override.

## Golden path

The following path proves a fresh checkout can build, run one focused test, start Open Wrangler in an Extension
Development Host, and produce a development VSIX.

1. Build the extension and webviews:

   ```bash
   npm run build
   ```

2. Run one focused Vitest file:

   ```bash
   npx vitest run src/test/configuration.unit.test.ts
   ```

3. Open the checkout in VS Code:

   ```bash
   code .
   ```

   In **Run and Debug**, choose **Run Open Wrangler** and press F5. The tracked launch configuration runs the existing
   `npm run build` task, opens this checkout in a new Extension Development Host, and loads the extension from the
   current source tree.

   Trust the development workspace. Select the checkout `.venv` with **Python: Select Interpreter**, or set
   `openWrangler.pythonPath` to its absolute Python executable as described above. Then right-click
   `fixtures/sample.csv` and choose **Open in Open Wrangler**. A grid with the four sample columns confirms that the
   bundled Python runtime can start from the selected environment.

4. Close the development host and create a development VSIX:

   ```bash
   npm run package:dev
   npm run verify:vsix -- openwrangler-dev.vsix
   ```

   `package:dev` performs a clean build and writes `openwrangler-dev.vsix`. It does not run the source test suite or
   the release-candidate matrix. Install it with one of these commands when you need to test the package in your
   normal editor:

   ```bash
   code --install-extension openwrangler-dev.vsix --force
   # or
   cursor --install-extension openwrangler-dev.vsix --force
   ```

Do not commit the VSIX, `.venv`, `node_modules`, editor profiles, notebook caches, or scratch files.

## Fast feedback

Use the narrowest command that covers the change. Do not run memory-intensive suites concurrently.

- `npm run format:check`, `npm run lint`, and `npm run typecheck` run the direct JavaScript/TypeScript static owners.
- `npm run check` runs the complete static, generated-file, documentation, brand, dependency-lock, and license checks.
  It does not run the source test suites.
- `npx vitest run src/test/configuration.unit.test.ts` runs one Vitest file. Add `-t "test name"` to select one test.
- `node scripts/run-python.mjs -m pytest python/tests/test_engine_registry.py -q` runs one Pytest file through the
  repository's cross-platform Python resolver. Add `-k "test_name"` to select matching tests.
- `npx vitest --watch src/test/configuration.unit.test.ts` watches one Vitest file.
- `npm run watch:extension` watches the extension build. `npm run watch:webview:main` and
  `npm run watch:webview:renderer` watch the two webview bundles separately. Reload the Extension Development Host
  after a completed rebuild.
- `npm run package:dev` creates the development VSIX without invoking release-candidate checks.

See [Testing](docs/testing.md) for suite ownership, required editor scenarios, visual prerequisites, and CI gates. See
[Releasing](docs/releasing.md) for production packaging, candidate verification, and publication. Those release paths
are not part of the contributor golden path.

## Writing for people

Read [the writing guide](docs/writing-style.md) before editing the README, changelog, issues, pull request text,
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
- Keep Pandas, Polars, and DuckDB implementations native. An operation change must include live-runtime and executable
  generated-code coverage for every editing-capable engine.
- Update the documentation listed in the `AGENTS.md` matrix.
- Review user-facing text and pull request summaries against `docs/writing-style.md`.
- Add and review `docs/release-notes/<version>.md` in every release pull request; the publisher does not generate it.
- A release pull request contains only the version bump, changelog, release notes, and release metadata. Merge product,
  test-harness, media, and unrelated documentation work first.
- Run `npm run generate:reference` after changing commands, settings, operations, protocol messages, or notebook MIME
  types; never hand-edit `docs/reference.md`.
- Include screenshots for visible changes in light, dark, and high-contrast themes.
- Push independently green branch commits before opening a pull request when early review is not needed. Draft pull
  requests run checks when opened and after each pushed commit. Marking an unchanged draft ready does not rerun them.

All required checks must pass before merge. Feature work is tested in both VS Code and Cursor before a prerelease.
