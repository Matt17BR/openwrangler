# Releasing

## Version policy

`0.2.0-alpha.n` releases are parity-development checkpoints. `1.0.0` is allowed only after every in-scope feature-parity row is Done and all automated and manual gates pass. Update `package.json`, `python/openwrangler_runtime/version.py`, `CHANGELOG.md`, and parity evidence in the same pull request. The Python package reads its version from `version.py`; `npm run docs:check` converts the npm prerelease spelling to PEP 440 and rejects any extension/runtime mismatch.

## Package gate

```bash
npm ci
python3 -m venv .venv
.venv/bin/python -m pip install -e "python[dev]"
npm run package -- --out openwrangler.vsix
npm run verify:vsix -- openwrangler.vsix
npm run test:coverage
npm run license:check
npm run benchmark:runtime
sha256sum openwrangler.vsix
```

The VSIX may contain production extension bundles, webview assets, the Python runtime source, package metadata, README, changelog, license, and third-party notices. It must not contain source TypeScript, tests, fixtures, scripts, benchmark sources, profiles, source maps, caches, virtual environments, `.env` files, credentials, or untracked scratch files. After allowlist verification, `npm run test:packaged-editors -- openwrangler.vsix` must install and exercise the artifact from isolated profiles; development-host success is not a substitute. The packaged gate uses two editor processes per product to prove persisted-plan replay, concurrent Pandas/Polars crash recovery, export source safety, and final process cleanup.

The strict runtime benchmark and Playwright cached/uncached scroll gates must pass on the Linux release reference workstation. The runtime must import Polars before timing, record an accepted per-file source-cache eviction, and keep the canonical stdio first-grid round trip below 3s for the 100k×50 CSV and 5s for the 1M×20 Parquet fixture; a warm-source median cannot substitute for this gate. The report must retain separately named direct-manager cache metrics, real stdio protocol/JSON cache-miss round trips, and the same-session statistics-contention latency, active-call proof, and overlap result; an in-process timing may not be cited as product-boundary performance. The isolated benchmark bootstrap must prove from `header_stats` entry/exit events that statistics remained active when the page envelope finished sending; completed-before-send or otherwise inconclusive evidence fails release. The cache-miss response gap must then prove substantial overlap against the uncontented baseline, and both ordinary and contended stdio pages must remain within 500ms. Attach the generated `tmp/performance/report.json` values to parity evidence; scheduled CI reports provide regression history but do not replace final local acceptance.

## GitHub workflow

Each milestone uses its own branch and pull request. Push independently green vertical slices; squash-merge only after required CI and acceptance evidence pass. Tag prereleases from `main` as `v0.2.0-alpha.n`. The release workflow builds a fresh VSIX, verifies its allowlist, publishes a SHA-256 checksum, and creates a GitHub prerelease.

Tag builds first validate packaging and tests on Linux/Python 3.10, macOS/Python 3.12, and Windows/Python 3.14. The Linux release job runs only after that matrix succeeds.

Marketplace and Open VSX jobs remain disabled until `Matt17BR` is verified in both registries and repository secrets or federated publishing credentials are configured. Never store tokens in the repository, workflow text, artifacts, or logs.
