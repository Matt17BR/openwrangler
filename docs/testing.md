# Testing

Prefer the lowest-cost test that exercises the behavior. Keep a higher-level test only when it can catch a product,
package, runtime, or platform failure that a direct test cannot. Keep dedicated security and privacy tests for
credential redaction, no-follow identity checks, sealed artifacts, and exact output-path handoff. Do not keep fixture
or end-to-end tests merely to verify how another test runner, selector, or diagnostic path is wired.

## Direct source checks

While iterating, run the smallest relevant test:

```bash
npx --no-install vitest run src/test/configuration.unit.test.ts
node scripts/run-python.mjs -m pytest python/tests/test_engine_registry.py -q
node --test scripts/package-source-manifest.test.mjs
```

The ordinary source suites are:

```bash
npm run test:scripts
npm run test:ts
npm run test:python
```

`npm run test:scripts` runs the Node tests for release, packaging, licenses, dependency locks, and archives directly
with `node --test`.

Use these checks for changed static boundaries:

```bash
npm run format:check
npm run lint
npm run lint:python
npm run typecheck
npm run typecheck:dependencies
npm run protocol:check
npm run reference:check
npm run docs:check
npm run check:remote-jupyter-lock
npm run check:r-dependency-lock
npm run license:check
```

`npm run check` runs those static checks sequentially, and `npm test` runs the three source suites sequentially.
`npm run check:pr` runs both commands for local and protected-main checks. The release-candidate workflow starts from
protected main after these checks pass and does not repeat the source suites.

For Native R changes, run the full contract suite or the relevant group:

```bash
npm run test:r-contract
npm run test:r-contract:frame-and-interactive-transport
npm run test:r-contract:catalog-and-process-transport
node scripts/run-r-contract-tests.mjs --shard kernel-agent
```

The grouped commands keep real-R process tests serial while separating frame and interactive-transport, catalog and
process-transport, and kernel-agent failures.

## Pull-request CI

The pull-request workflow requires five jobs:

- Source contracts: formatting, lint, types, generated protocol/reference output, documentation, dependency locks,
  licenses, the retained script contracts, and Vitest.
- Python runtime contracts: Ruff, Pyright, and Pytest.
- Native R frame, kernel, and transport contracts: the three R 4.5 selections above.
- Packaged VS Code smoke: one production VSIX opened in the declared minimum VS Code 1.106.0 and current stable VS
  Code.
- Windows filesystem and process contracts: Windows-only export, dependency, and shutdown behavior.

Branch protection requires all five jobs to pass. See [CI](ci.md) for the job names.

## Failure-artifact allowlist

After editor and display ownership and private-root identity are verified, a failure artifact may contain only:

- Phase result and progress JSON.
- Selected `main.log`, `sharedprocess.log`, `renderer.log`, `notebook.rendering.log`, `exthost.log`, and Open Wrangler
  output-channel logs.
- A paths, types, and sizes-only profile manifest.
- Structured failure metadata.

Jupyter output logs may be inspected only to derive a fixed failure category and are never copied. Raw profiles,
settings, workspace storage, databases, arbitrary extension logs, credentials, private keys, and user data are never
allowed. Collection and sealing use bounded no-follow, single-link, identity-pinned reads and repeat redaction. CI
uploads only the exact sealed path emitted through `GITHUB_OUTPUT`; it never uploads a staging directory or glob.

## Exact-artifact installed smoke

For a local or pull-request installed-editor smoke, build and verify one VSIX, then give that exact file first to the
declared minimum VS Code 1.106.0 and then to current stable VS Code:

```bash
npm ci --ignore-scripts
python -m pip install -e "python[dev]"
npm run clean
npm run build
npm run package:prepared -- --out openwrangler.vsix
npm run verify:vsix -- openwrangler.vsix
npm run build:test-extension
OPEN_WRANGLER_PACKAGED_EDITORS=vscode \
OPEN_WRANGLER_PACKAGED_MODE=platform-smoke \
OPEN_WRANGLER_TEST_SELECTOR=daily-core \
VSCODE_TEST_VERSION=1.106.0 \
node scripts/run-packaged-editor-tests.mjs openwrangler.vsix
OPEN_WRANGLER_PACKAGED_EDITORS=vscode \
OPEN_WRANGLER_PACKAGED_MODE=platform-smoke \
OPEN_WRANGLER_TEST_SELECTOR=daily-core \
VSCODE_TEST_VERSION=stable \
node scripts/run-packaged-editor-tests.mjs openwrangler.vsix
```

The smoke catches production-bundle, VSIX-installation, public CSV action, grid rendering, sort, and terminal cleanup
failures that source tests cannot observe. It must not rebuild or substitute the VSIX after verification.

## Release-candidate checks

The release-candidate workflow packages the protected-main source once and retains one canonical VSIX, checksum, and
provenance triple. It does not repeat protected-main source checks. The candidate job:

1. Audits the published Node and Python dependencies.
2. Runs pinned VS Code installed-performance against the canonical triple.
3. Reverifies the triple and runs pinned Cursor `platform-smoke` against the same VSIX.
4. Reverifies and uploads only the canonical triple for stable promotion.

Stable publication uses this verified VSIX and does not rebuild it.

## Change-focused editor checks

Run a manual editor scenario only when the change crosses that UI or integration boundary:

- File changes: open `fixtures/sample.csv`, exercise the changed view or cleaning action, and confirm the source bytes
  are unchanged.
- Notebook changes: use the exact visible notebook and selected kernel; verify the changed live-variable or saved
  output path without falling back to another notebook.
- R changes: exercise the affected `.R` or IRkernel path in its supported editor and confirm the source object remains
  unchanged.
- Webview changes: check keyboard operation, accessible names, focus restoration, and light, dark, and high-contrast
  themes for the changed control.

Do not retain a second end-to-end journey for behavior already covered by the exact-artifact smoke or a direct source
test. Do not retry deterministic failures; fix the product or remove a check that cannot identify a distinct failure.
