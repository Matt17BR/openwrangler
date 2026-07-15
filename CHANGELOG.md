# Changelog

All notable changes to Data Explorer are documented here. The project follows Semantic Versioning while prerelease versions remain unstable.

## [0.2.0-alpha.1] - 2026-07-15

### Added

- Data Explorer 1.0 parity milestone, contributor guardrails, CI, release automation, and documentation ownership.
- Original extension and Activity Bar icon sources.
- Strict TypeScript, Python, formatting, documentation, and VSIX-content checks.
- Protocol v2 JSON Schema, generated TypeScript contract, explicit Python validation, typed cell encodings, request cancellation, timeouts, and structured diagnostics.
- Stable extension-host session IDs with per-session serialization, concurrent dataframe sessions, cleanup, stale-revision rejection, and runtime replay.
- Python 3.10-3.14 environment resolution, engine/format dependency probes, and confirm-before-install runtime commands.

### Changed

- Package publisher changed from `local` to `Matt17BR`.
- File-only use no longer declares Jupyter as a hard extension dependency.
- Supported Python versions are 3.10 through 3.14.

### Known gaps

- Editing operations, native views, and release-grade editor tests are tracked in `docs/feature-parity.md` and are not yet parity complete.

## [0.1.0] - 2026-06-01

- Initial Pandas/Polars viewing prototype.
