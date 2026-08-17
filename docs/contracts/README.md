# Specification contracts

`AGENTS.md` remains the authority for the repository's non-negotiable invariants during this migration. The files in
this directory do not replace it.

`invariants-v1.md` is a lossless archive of the current 58-entry invariant block. It exists so later documentation
work can shorten or relocate that block without dropping a constraint. Do not edit the archive by hand. Run:

```bash
node scripts/spec-invariants.mjs --write
node scripts/spec-invariants.mjs --check
```

The first command refreshes the archive and the generated crosswalk in `docs/evidence/`. The second command fails if
the archive differs from `AGENTS.md`, the invariant IDs are missing or reordered, or the generated evidence is stale.
The crosswalk records literal numbered references in the four routed documents. An empty reference list means that no
numbered link was found; it is not an implementation or test-coverage verdict.

This is a transition boundary, not an authority change. Existing architecture, testing, feature-parity, and release
documents remain normative where `AGENTS.md` routes to them. A later change may reduce duplication only after it names
the surviving authority for each removed statement and keeps this lossless check green.
