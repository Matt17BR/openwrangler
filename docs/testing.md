# Testing

Keep a test only when it catches a distinct product, package, runtime, or platform failure that a cheaper direct test
cannot catch. Test product behavior at the lowest useful boundary. Retain direct security and privacy boundary tests
for credential redaction, no-follow identity checks, sealed artifacts, and exact output-path handoff. Beyond those
boundaries, do not retain tests of fixtures, general workflow topology, runner ceremony, diagnostic topology, or test
selectors.

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

`npm run check` runs those static checks sequentially. `npm test` runs the three source suites sequentially.
`npm run check:pr` runs the two commands in sequence for local and protected-main source qualification. The
release-candidate workflow consumes that already-checked protected-main source and does not repeat the source suites.

Native R changes use the source contract or one of its three pull-request selections:

```bash
npm run test:r-contract
npm run test:r-contract:frame-and-interactive-transport
npm run test:r-contract:catalog-and-process-transport
node scripts/run-r-contract-tests.mjs --shard kernel-agent
```

The selections keep real-R process ownership serial while separating native frame/interactive transport,
catalog/process transport, and native kernel-agent failures.

## Pull-request CI

The pull-request workflow has five direct owners:

- Source contracts: formatting, lint, types, generated protocol/reference output, documentation, dependency locks,
  licenses, the retained script contracts, and Vitest.
- Python runtime contracts: Ruff, Pyright, and Pytest.
- Native R frame, kernel, and transport contracts: the three R 4.5 selections above.
- Packaged VS Code smoke: one production VSIX opened in stable VS Code.
- Windows filesystem and process contracts: Windows-only export, dependency, and shutdown behavior.

There is no path classifier or aggregate workflow test. Branch protection directly requires all five owners to pass.
See [CI](ci.md) for the job names.

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

For a local or pull-request installed-editor smoke, build and verify one VSIX, then give that exact file to the stable
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

## Release-candidate checks

The release-candidate workflow packages the protected-main source once and retains one canonical VSIX, checksum, and
provenance triple. It does not repeat protected-main source checks. The candidate job:

1. Audits the published Node and Python dependencies.
2. Runs pinned VS Code installed-performance against the canonical triple.
3. Reverifies the triple and runs pinned Cursor `platform-smoke` against the same VSIX.
4. Reverifies and uploads only the canonical triple for stable promotion.

This is the complete retained candidate flow. Stable publication consumes those exact bytes and does not rebuild
them.

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
