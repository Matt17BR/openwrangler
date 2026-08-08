# Writing for Open Wrangler

Write as a maintainer explaining the product to another developer. The reader needs facts, not a sales rhythm.

This guide applies to every public surface:

- README
- user documentation
- contributor documentation
- changelog
- GitHub issues
- pull requests
- commit subjects and `git log`
- release notes
- Marketplace listings
- Open VSX listings
- screenshot captions
- image alt text

Architecture, security, test, release, and performance specifications can use formal language when the wording carries
a precise contract. Their introductions and summaries should still be direct.

## Public copy

- Put the feature or result at the start of the sentence.
- Prefer a concrete subject and verb: “The grid fetches visible columns” is clearer than “Navigate wide data
  efficiently.”
- Keep one claim in a sentence. Split long strings of adjectives, implementation terms, and caveats.
- Name the command, screen, engine, file format, or limitation when it matters.
- Use captions to explain what an image proves. Do not give every image a two-word slogan.
- Write alt text for someone who cannot see the image. Name the screen and the useful state instead of praising the
  design.
- State safety limits directly. Explain the consequence once, then stop.
- Do not claim that something is faster, safer, complete, or production-ready without linked evidence.
- Keep release-specific timing tables in a dated performance report. The README may summarize the latest reviewed
  result and link to it, but it must not copy a table that goes stale when the product changes.
- Do not paste architecture invariants or test-contract prose into the README, changelog, release notes, or a pull
  request summary. Link to the detailed document when a reader needs it.
- Read the finished paragraph aloud. If several sentences have the same length or pattern, rewrite them.
- Remove meta-commentary such as “this section covers” when the heading and following text already make the point.
- Use “X, not Y” only when the contrast answers a real question. Repeating that construction makes ordinary copy
  sound defensive.

Use “built independently” in user-facing copy instead of “clean-room.” Describe the Data Wrangler comparison by what
it does through the public UI instead of calling it a “black-box” test. Terms such as “atomic” and “correlated” are
useful in a technical contract when they name a specific guarantee; define them there and do not use them as decoration.

Examples:

| Avoid                                                                       | Write instead                                                                                 |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| “Independent clean-room implementation with native multi-engine execution.” | “Open Wrangler was built independently. Pandas, Polars, and DuckDB run in their own engines.” |
| “Understand distributions.”                                                 | “Hover any histogram bin to see its range and row count.”                                     |
| “The whole workflow stays in your editor.”                                  | “The workbench shows the grid, profiles, filters, and cleaning steps together.”               |
| “These are evidence points, not row limits.”                                | “The benchmark fixtures are not a hard row limit.”                                            |
| “Other desktop forks remain experimental.”                                  | “Support for other VS Code-based desktop editors is currently experimental.”                  |

## Issues, commits, pull requests, and releases

An issue title should name the missing behavior or failure. Put reproduction steps, expected behavior, and evidence in
the body. Avoid turning a roadmap issue into launch copy.

A commit subject should describe the observable change. Prefer “Reject stale notebook sessions after a kernel
restart” to “Harden notebook lifecycle.” Keep it short enough to scan in `git log`.

A pull request title should make sense in repository history. The body should say what problem prompted it, what
changed, how it was tested, and what is still unresolved. Do not turn the body into a feature brochure or repeat every
implementation detail from the diff.

Release notes and registry listings should lead with what a user can now do or what no longer breaks. Internal protocol
or test work belongs there only when it changes risk, compatibility, or contributor workflow. Each release has a
checked-in `docs/release-notes/<version>.md`; GitHub-generated notes are disabled so publication cannot skip that edit.
The check proves which committed text will ship, not whether a person read it. Review the prose in the release change.

Before publishing text:

1. Remove slogans, repeated mini-headings, and adjective stacks.
2. Check every performance and compatibility claim against current evidence.
3. Shorten disclaimers without removing the actual warning.
4. Ask whether a reader without issue or prompt context will understand the sentence.
5. Run `npm run docs:check`.

Automated checks can make sure this guide stays connected to contributor and pull request instructions. They
cannot decide whether prose sounds human. Do not add AI detectors, word bans, or sentence-style scoring as a merge
gate; public copy still needs an editorial read.
