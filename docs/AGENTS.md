# Documentation instructions

This file applies to `docs/**` and, when routed by the root policy, to public text elsewhere. Read the implementation owner's scoped file before documenting a protocol, runtime, operation, UI, workflow, or release boundary. Cite its rule IDs; do not duplicate its normative text.

## Document ownership

- `docs/architecture.md` records boundaries and invariants.
- `docs/decisions/0001-native-r-runtime.md` records the runtime and release boundary for R work in v2.
- `docs/feature-parity.md` is the release gate for user-visible parity.
- `docs/performance-comparison.md` defines the Data Wrangler comparison and links its dated evidence.
- `docs/product-roadmap.md` records product priorities, deferrals, acceptance gates, and audit dispositions.
- `docs/reference.md` is generated from public interface registries; never edit it by hand.
- `docs/testing.md` defines required checks and manual editor scenarios.
- `docs/releasing.md` defines packaging and release rules.
- `docs/writing-style.md` defines the voice for README, changelog, release, issue, pull request, and commit text.

## Owned invariant

<!-- OW-RULE:I09 -->
9. Do not describe the project as feature-parity complete until every in-scope row in `docs/feature-parity.md` is green.

## Public writing

Read `docs/writing-style.md` before changing public text. Write like a maintainer explaining a concrete change to
another developer. Do not copy architecture invariants or test-contract prose into README, changelog, release notes,
issue/PR summaries, registry listings, screenshot captions, alt text, or commit subjects. Link to the detailed document
instead.

Public copy needs an editorial pass; an AI detector or word blacklist is not a substitute. Say that Open Wrangler was
built independently instead of describing it as a “clean-room implementation.” Use terms such as `atomic`, `bounded`,
or `fail closed` only when they name a real method or invariant. Commit subjects and PR titles should name the
observable result rather than “harden,” “improve,” or “stabilize” without saying what changed.

Prefer short sentences, concrete claims, and a clear explanation of why a change matters to users. Avoid stacked
buzzwords, slogan-like parallel headings, internal prompt context, and long defensive disclaimers. Legal and clean-room
constraints belong in internal guidance; they are not marketing copy.

Every release adds `docs/release-notes/<version>.md` in the release change. Publication reads that exact blob from the
tagged commit and must not substitute GitHub-generated notes. Automation proves which text will be published; it does
not prove that a person reviewed the prose. Give public copy an editorial read before approving the release change.

## Documentation update matrix

- Protocol, session, runtime, or engine boundary changes: update `docs/architecture.md` and protocol tests.
- Native R producer, decoder, or supported-frame changes: update `docs/decisions/0001-native-r-runtime.md`, `docs/architecture.md`, `docs/feature-parity.md`, and `docs/testing.md`.
- New or changed operation, filter, export, or entry point: update `docs/feature-parity.md` and its acceptance evidence.
- New or changed command, setting, operation, MIME type, or protocol message: run `npm run generate:reference` and commit `docs/reference.md`.
- Test commands, fixtures, or release gates: update `docs/testing.md`.
- Package contents, versioning, CI, publishing, or credentials: update `docs/releasing.md` and `CHANGELOG.md`.
- User-visible setup or behavior: update `README.md` and `CHANGELOG.md`.
- New third-party runtime or bundled asset: update `THIRD_PARTY_NOTICES.md` and verify its license.

CI runs `npm run reference:check` and `npm run docs:check`; do not bypass them or hand-edit `docs/reference.md`.

<!-- OW-INSTRUCTIONS:EOF path="docs/AGENTS.md" sha256="ae9ab5aa2fc9b6dae26955515dc42244eb67119e2fb92feac31c2b3ac9afa9f6" -->
