# Testing

Keep a test only when it catches a distinct product, package, runtime, or platform failure that a cheaper direct test
cannot catch. Test product behavior at the lowest useful boundary. Do not add tests whose subject is another test,
fixture, workflow topology, runner, diagnostic bundle, or test selector.

## Direct source checks

Run the narrowest owner while iterating:

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

`npm run test:scripts` runs the retained Node script contracts directly with `node --test`. Each file owns one
semantic release, package, license, dependency-lock, or archive boundary; it does not discover tests from a registry.

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

`npm run check` runs those static checks sequentially. `npm test` runs the three source suites sequentially. The
release-candidate workflow uses `npm run check:pr`, which is the same two commands in sequence.

Native R changes use the source contract or one of its two direct shards:

```bash
npm run test:r-contract
npm run test:r-contract:frame-and-interactive-transport
npm run test:r-contract:catalog-and-process-transport
```

The shards keep real-R process ownership serial while separating native frame/interactive transport failures from
catalog/process transport failures.

## Pull-request CI

The pull-request workflow has five direct owners:

- Source contracts: formatting, lint, types, generated protocol/reference output, documentation, dependency locks,
  licenses, the retained script contracts, and Vitest.
- Python runtime contracts: Ruff, Pyright, and Pytest.
- Native R frame and transport contracts: the two R 4.5 shards above.
- Packaged VS Code smoke: one production VSIX opened in stable VS Code.
- Windows filesystem and process contracts: Windows-only export, dependency, and shutdown behavior.

There is no path classifier or aggregate workflow test. The inline `validate` job requires all five owners to pass.
See [CI](ci.md) for the job names.

## Exact-artifact installed smoke

This is the only ordinary installed-editor smoke. Build and verify one VSIX, then give that exact file to the stable
VS Code runner:

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
VSCODE_TEST_VERSION=stable \
node scripts/run-packaged-editor-tests.mjs openwrangler.vsix
```

The smoke catches production-bundle, VSIX-installation, public CSV action, grid rendering, sort, and terminal cleanup
failures that source tests cannot observe. It must not rebuild or substitute the VSIX after verification.

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
